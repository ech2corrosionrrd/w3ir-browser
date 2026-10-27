'use strict';
// Перевірка підпису Solana через процес-підписувач на ЖИВІЙ мережі Devnet (без реальних коштів):
//   npx electron build/devnet-signer-check.js [rpc-url] [--wait <секунд>] [--phrase-file <файл.json>]
// --phrase-file — JSON { "phrase": "…" } з тестовою фразою (лише для Devnet; файл тримайте поза репозиторієм), щоб повторно використати поповнений рахунок.
// Якщо кран RPC закритий, надішліть кілька тестових SOL на виведену адресу рахунку 0 (https://faucet.solana.com) протягом --wait секунд.
// Одноразова фраза лише в пам'яті. Через підписувач виконуються: підпис повідомлення (перевіряється відкритим ключем),
// переказ SOL між двома рахунками однієї фрази, стейкінг із двома підписантами (рахунок-власник у підписувачі, одноразовий
// ключ stake-акаунта локально, як у гаманці). Мережа сама відхилить хибний підпис або транзакцію.
const { app } = require('electron');
const path = require('path');
const crypto = require('crypto');
const { Mnemonic } = require('ethers');

const root = path.join(__dirname, '..');
const S = require(path.join(root, 'src', 'solana'));
const { SignerClient } = require(path.join(root, 'src', 'wallet-signer-client'));

const RPC = process.argv.slice(2).find(a => /^https:/.test(a)) || 'https://api.devnet.solana.com';
const waitIdx = process.argv.indexOf('--wait');
const WAIT = waitIdx > 0 ? Number(process.argv[waitIdx + 1]) || 0 : 0;
const pfIdx = process.argv.indexOf('--phrase-file');
const PHRASE_FILE = pfIdx > 0 ? process.argv[pfIdx + 1] : '';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (cond, name, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!cond) failed++; };

async function rpc(method, params) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (r.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
    const j = await r.json();
    if (j.error) { const e = new Error(j.error.message); e.data = j.error.data; throw e; }
    return j.result;
  }
  throw new Error('RPC: забагато запитів (429)');
}
const latest = async () => (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
const balance = async (a) => (await rpc('getBalance', [a, { commitment: 'confirmed' }])).value;

async function send(wire, label) {
  const sim = await rpc('simulateTransaction', [wire.toString('base64'), { encoding: 'base64', sigVerify: true, commitment: 'processed' }]);
  if (sim.value.err) throw new Error(`${label}: симуляція: ${JSON.stringify(sim.value.err)} ${(sim.value.logs || []).slice(-3).join(' | ')}`);
  const sig = await rpc('sendTransaction', [wire.toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
  for (let i = 0; i < 60; i++) {
    const st = (await rpc('getSignatureStatuses', [[sig]])).value[0];
    if (st && st.err) throw new Error(`${label}: помилка в мережі ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return sig;
    await sleep(1000);
  }
  throw new Error(`${label}: не підтверджено за 60 с`);
}

async function main() {
  const client = new SignerClient();
  try {
    const phrase = PHRASE_FILE ? JSON.parse(require('fs').readFileSync(PHRASE_FILE, 'utf8')).phrase : Mnemonic.fromEntropy(crypto.randomBytes(16)).phrase;
    await client.call('unlock', { mnemonic: phrase });
    const a = (await client.call('address', { chain: 'sol', index: 0 })).address;
    const b = (await client.call('address', { chain: 'sol', index: 1 })).address;
    console.log('RPC', RPC, '\nрахунок 0', a, '\nрахунок 1', b);
    const signTx = async (index, address, wire) => Buffer.from((await client.call('solSignTx', { index, address, wire })).signedWire);

    // 1. підпис повідомлення: перевіряється відкритим ключем рахунку
    const msg = Buffer.from('W3IR devnet signer check ' + Date.now());
    const sig = Buffer.from((await client.call('solSign', { index: 0, message: msg })).signature);
    check(S.verify(S.b58decode(a), msg, sig), 'підпис повідомлення Solana перевіряється відкритим ключем рахунку');

    // 2. безкоштовні тестові SOL
    let funded = await balance(a);
    if (funded) console.log('Рахунок уже поповнено:', funded, 'лампортів');
    for (const amount of funded ? [] : [1_000_000_000, 500_000_000, 200_000_000, 100_000_000]) {
      try {
        await rpc('requestAirdrop', [a, amount]);
        for (let i = 0; i < 40 && !funded; i++) { await sleep(1000); funded = await balance(a); }
        if (funded) { console.log('airdrop', amount); break; }
      } catch (e) { console.log('airdrop не вдався:', e.message); await sleep(2000); }
    }
    if (!funded && WAIT > 0) {
      console.log(`Кран закрито. Надішліть тестові SOL на ${a} (https://faucet.solana.com), очікую до ${WAIT} с…`);
      for (let t = 0; !funded && t < WAIT; t += 5) { await sleep(5000); funded = await balance(a); }
    }
    if (!funded) { console.log('SKIP: Devnet не видав тестові SOL (ліміт faucet). Повторіть пізніше або вкажіть інший RPC.'); return 2; }

    // 3. переказ SOL через підписувач
    const before = await balance(b);
    const wire1 = S.unsignedWire(S.buildTransferMessage({ from: a, to: b, lamports: 12_345_678n, blockhash: await latest() }));
    await send(await signTx(0, a, wire1), 'переказ SOL');
    check(await balance(b) - before === 12_345_678, 'переказ SOL: баланс одержувача зріс точно на суму переказу');

    // 4. стейкінг: два підписанти — рахунок-власник (підписувач) і одноразовий ключ stake-акаунта (локально, як у гаманці)
    const votes = await rpc('getVoteAccounts', [{ commitment: 'confirmed' }]);
    const vote = (votes.current || []).sort((x, y) => Number(y.activatedStake) - Number(x.activatedStake))[0];
    if (!vote) { check(false, 'на Devnet немає поточного валідатора'); return 1; }
    // мінімальне делегування в мережі (на Devnet — 1 SOL): менша сума відхиляється програмою Stake (Custom 12)
    const minDelegation = BigInt((await rpc('getStakeMinimumDelegation', [{ commitment: 'confirmed' }])).value);
    const need = minDelegation + 2_282_880n + 50_000n;
    if (BigInt(await balance(a)) < need) { console.log(`SKIP: для стейкінгу потрібно щонайменше ${Number(need) / 1e9} SOL на ${a}, поповніть рахунок.`); return 2; }
    const stake = S.generateKeypair();
    const msgStake = S.compileMessage({ feePayer: a, blockhash: await latest(), instructions: [
      S.ixSystemCreateAccount({ from: a, newAccount: stake.address, lamports: 2_282_880n + minDelegation, space: 200, programId: S.PROGRAMS.STAKE }),
      S.ixStakeInitialize({ stakeAccount: stake.address, staker: a, withdrawer: a }),
      S.ixStakeDelegate({ stakeAccount: stake.address, voteAccount: vote.votePubkey, authorizedPubkey: a }),
    ] });
    const kpSig = S.sign(stake.secret, msgStake);
    const wire2 = S.unsignedWire(msgStake);
    const signed = await signTx(0, a, wire2);
    const tx = S.parseTransaction(wire2);
    const idx = tx.parsed.keys.slice(0, tx.parsed.numSigs).indexOf(stake.address);
    check(idx >= 0 && tx.parsed.numSigs === 2, 'стейкінг: два підписанти (власник і stake-акаунт)');
    kpSig.copy(signed, tx.sigOffset + idx * 64);
    await send(signed, 'стейкінг SOL');
    const info = (await rpc('getAccountInfo', [stake.address, { encoding: 'jsonParsed', commitment: 'confirmed' }])).value;
    const d = info && info.data && info.data.parsed && info.data.parsed.info;
    check(d && d.stake && d.stake.delegation.voter === vote.votePubkey && d.meta.authorized.staker === a && d.meta.authorized.withdrawer === a, 'stake-акаунт делеговано обраному валідатору, права — рахунок 0');
  } finally {
    await client.lock();
  }
  return failed ? 1 : 0;
}

app.whenReady().then(async () => {
  let code = 1;
  try { code = await main(); } catch (e) { failed++; console.log('FAIL помилка:', e && e.message, e && e.data ? JSON.stringify(e.data).slice(0, 300) : ''); }
  console.log(code === 2 ? 'Пропущено (faucet)' : failed ? `Збоїв: ${failed}` : 'Усе пройшло на живій мережі Devnet.');
  app.exit(code);
});
