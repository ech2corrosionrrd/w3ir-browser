'use strict';
// Перевірка підпису EVM через процес-підписувач на ЖИВІЙ мережі Sepolia (тестова, без реальних коштів):
//   npx electron build/sepolia-signer-check.js [rpc-url] [--wait <секунд>]
// Створюється одноразова фраза (лише в пам'яті, не виводиться). Підписи повідомлення й EIP-712 перевіряються відновленням адреси,
// підписана транзакція EIP-1559 надсилається у вузол Sepolia: якщо на адресі є тестовий ETH, транзакція (переказ собі) підтверджується;
// якщо ні — вузол має відхилити її помилкою «недостатньо коштів» саме для нашої адреси, що також доводить коректність підпису.
// Щоб виконати повний переказ, надішліть трохи Sepolia ETH на виведену адресу (з будь-якого крана) протягом --wait секунд.
const { app } = require('electron');
const path = require('path');
const { Mnemonic, Network, verifyMessage, verifyTypedData, formatEther } = require('ethers');

const root = path.join(__dirname, '..');
const { SignerClient } = require(path.join(root, 'src', 'wallet-signer-client'));
const { RemoteEvmSigner } = require(path.join(root, 'src', 'wallet-signer-evm'));
const { FailoverProvider } = require(path.join(root, 'src', 'rpc-failover'));

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
// Публічні вузли Sepolia нестабільні, тому використовується той самий перемикач вузлів, що й у гаманці
const RPCS = [...args.filter(a => /^https:/.test(a)), 'https://sepolia.gateway.tenderly.co', 'https://ethereum-sepolia-rpc.publicnode.com', 'https://1rpc.io/sepolia', 'https://sepolia.drpc.org'];
const waitIdx = process.argv.indexOf('--wait');
const WAIT = waitIdx > 0 ? Number(process.argv[waitIdx + 1]) || 0 : 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (cond, name, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!cond) failed++; };

async function main() {
  const phrase = Mnemonic.fromEntropy(require('crypto').randomBytes(16)).phrase;
  const client = new SignerClient();
  const call = async (op, a) => { await ensure(); return client.call(op, a); };
  let unlocked = false;
  const ensure = async () => { if (!unlocked) { await client.call('unlock', { mnemonic: phrase }); unlocked = true; } };
  try {
    await ensure();
    const { address } = await client.call('address', { chain: 'evm', index: 0 });
    const signer = new RemoteEvmSigner(call, 0, address);
    console.log('Адреса одноразового рахунку Sepolia:', address);

    const msg = 'W3IR signer check ' + Date.now();
    const sig = await signer.signMessage(msg);
    check(verifyMessage(msg, sig) === address, 'підпис повідомлення відновлює адресу рахунку');

    const domain = { name: 'W3IR', version: '1', chainId: 11155111, verifyingContract: '0x000000000000000000000000000000000000dEaD' };
    const types = { Check: [{ name: 'note', type: 'string' }, { name: 'amount', type: 'uint256' }] };
    const value = { note: 'sepolia', amount: 12345n };
    const typed = await signer.signTypedData(domain, types, value);
    check(verifyTypedData(domain, types, value, typed) === address, 'підпис EIP-712 відновлює адресу рахунку');

    const net = Network.from(11155111);
    const provider = new FailoverProvider(RPCS, net);
    const s = signer.connect(provider);
    let bal = await provider.getBalance(address);
    console.log('Баланс:', formatEther(bal), 'ETH (Sepolia)');
    for (let t = 0; bal === 0n && t < WAIT; t += 10) {
      if (t === 0) console.log(`Очікую поповнення адреси до ${WAIT} с…`);
      await sleep(10000);
      bal = await provider.getBalance(address);
    }

    const req = await s.populateTransaction({ to: address, value: 1n, type: 2 });
    check(req.chainId === 11155111n && req.maxFeePerGas > 0n, 'транзакцію підготовлено для Sepolia', `nonce ${req.nonce}, maxFee ${req.maxFeePerGas}`);
    const raw = await s.signTransaction(req);
    if (bal > 0n) {
      const resp = await provider.broadcastTransaction(raw);
      const rc = await resp.wait(1, 120000);
      check(rc && rc.status === 1 && rc.from === address, 'переказ собі підтверджено в мережі', resp.hash);
    } else {
      let msgErr = '';
      try { await provider.broadcastTransaction(raw); } catch (e) { msgErr = String(e.shortMessage || e.message || e) + ' ' + String((e.info && e.info.error && e.info.error.message) || ''); }
      // вузол відновив відправника з підпису й порахував його баланс: помилка «недостатньо коштів» (не «invalid signature/sender»)
      check(/insufficient funds|insufficient balance|exceeds the balance/i.test(msgErr) && !/invalid (sender|signature)/i.test(msgErr), 'вузол прийняв підпис (відхилено лише через відсутність коштів)', msgErr.slice(0, 160));
    }
  } finally {
    await client.lock();
  }
}

app.whenReady().then(async () => {
  try { await main(); } catch (e) { failed++; console.log('FAIL помилка:', e && e.message); }
  console.log(failed ? `Збоїв: ${failed}` : 'Усе добре');
  app.exit(failed ? 1 : 0);
});
