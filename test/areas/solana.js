'use strict';
const http = require('http');
const { Vault } = require('../../src/vault');
const { ok, sleep, tmp } = require('../lib');

const S = require('../../src/solana');

// ---------- конструктор транзакцій для тестів ----------
const sv = (n) => S.encodeShortVec(n);
const key = (n) => S.b58encode(Buffer.alloc(32, n));
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
function message({ keys, numSigs = 1, ro = 0, rou = 0, ins, v0 = null }) {
  const parts = [];
  if (v0) parts.push(Buffer.from([0x80]));
  parts.push(Buffer.from([numSigs, ro, rou]), sv(keys.length), ...keys.map(k => S.b58decode(k)), Buffer.alloc(32, 9), sv(ins.length));
  for (const i of ins) parts.push(Buffer.from([i.program]), sv(i.accounts.length), Buffer.from(i.accounts), sv(i.data.length), Buffer.from(i.data));
  if (v0) parts.push(sv(v0.length), ...v0.flatMap(l => [S.b58decode(l.table), sv(l.writable.length), Buffer.from(l.writable), sv(l.readonly.length), Buffer.from(l.readonly)]));
  return Buffer.concat(parts);
}
const wire = (msg, n = 1) => Buffer.concat([sv(n), Buffer.alloc(64 * n), msg]);
const SYS = S.PROGRAMS.SYSTEM, TOKEN = S.PROGRAMS.TOKEN;

async function solanaTests(ctx) {
  const E = require('ethers');
  const { Wallet: W } = require('../../src/wallet');
  const { Store } = require('../../src/store');
  const MASTER = 'Solana-Master-Pass-77!';

  // ---------- 1. base58 і ключі ----------
  ok(S.b58encode(Buffer.from('Hello World!')) === '2NEpo7TZRRrLZSi2U' && S.b58decode('2NEpo7TZRRrLZSi2U').toString() === 'Hello World!', 'solana: base58 — відомий вектор');
  ok(S.b58encode(Buffer.from([0, 0, 1])) === '112' && S.b58decode('112').equals(Buffer.from([0, 0, 1])), 'solana: base58 зберігає початкові нулі');
  let badB58 = false; try { S.b58decode('0OIl'); } catch { badB58 = true; }
  ok(badB58 && !S.isAddress('abc') && S.isAddress(key(3)), 'solana: некоректний base58/адреса відхиляються');
  const seed = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
  ok(S.slip10(seed, []).toString('hex') === '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7'
    && S.slip10(seed, [0]).toString('hex') === '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3', 'solana: SLIP-0010 Ed25519 — офіційні тестові вектори');
  ok(S.keypairFromSeed(S.slip10(seed, [0])).publicKey.toString('hex') === '8c8a13df77a28f3445213a0f432fde644acaa215fc72dcdf300d5efaa85d350c', 'solana: публічний ключ Ed25519 за вектором SLIP-0010');
  const abandon = Buffer.from(E.Mnemonic.fromPhrase('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about').computeSeed().slice(2), 'hex');
  const kp0 = S.deriveAccount(abandon, 0);
  ok(kp0.address === 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', 'solana: m/44\'/501\'/0\'/0\' для стандартної фрази дає адресу Phantom/Solflare');
  ok(S.deriveAccount(abandon, 1).address !== kp0.address, 'solana: різні рахунки — різні адреси');
  const sg = S.sign(kp0.secret, Buffer.from('hi'));
  ok(S.verify(kp0.publicKey, Buffer.from('hi'), sg) && !S.verify(kp0.publicKey, Buffer.from('ho'), sg), 'solana: підпис Ed25519 перевіряється');

  // ---------- 2. розбір і розшифровка ----------
  const me = kp0.address, other = key(5), mint = key(6), acc1 = key(7), unknown = key(8);
  const transferMsg = message({ keys: [me, other, SYS], ro: 0, rou: 1, ins: [{ program: 2, accounts: [0, 1], data: Buffer.concat([u32(2), u64(1_500_000_000)]) }] });
  const pt = S.parseTransaction(wire(transferMsg));
  const dsc = S.describe(pt.parsed, [me]);
  ok(pt.parsed.version === 'legacy' && pt.parsed.instructions.length === 1 && pt.parsed.keys[0] === me, 'solana: розбір legacy-транзакції');
  ok(dsc.lines.some(l => /Переказ 1\.5 SOL/.test(l[1])) && dsc.outgoing === 1_500_000_000n && !dsc.danger && dsc.warnings.length === 0, 'solana: переказ SOL розшифровано, сума й напрямок показані');

  const mk = (keys, ins, extra = {}) => S.describe(S.parseTransaction(wire(message({ keys, ins, ...extra }))).parsed, [me]);
  const setAuth = mk([me, acc1, TOKEN], [{ program: 2, accounts: [1, 0], data: Buffer.concat([Buffer.from([6, 2, 1]), Buffer.alloc(32, 5)]) }], { rou: 1 });
  ok(setAuth.danger && setAuth.warnings.some(w => /SetAuthority/.test(w)), 'solana: SetAuthority — червоне попередження (дрейнер)');
  const approve = mk([me, acc1, other, TOKEN], [{ program: 3, accounts: [1, 2, 0], data: Buffer.concat([Buffer.from([4]), u64(10)]) }], { rou: 1 });
  ok(approve.danger && approve.warnings.some(w => /право витрачати/.test(w)), 'solana: Approve токенів — попередження про делегування');
  const close = mk([me, acc1, other, TOKEN], [{ program: 3, accounts: [1, 2, 0], data: Buffer.from([9]) }], { rou: 1 });
  ok(close.danger && close.warnings.some(w => /НЕ вам/.test(w)), 'solana: CloseAccount з виплатою не вам — попередження');
  const assign = mk([me, SYS], [{ program: 1, accounts: [0], data: Buffer.concat([u32(1), Buffer.alloc(32, 4)]) }], { rou: 1 });
  ok(assign.danger && assign.warnings.some(w => /передає власність/.test(w)), 'solana: System Assign вашого акаунта — попередження');
  const unk = mk([me, unknown, acc1], [{ program: 1, accounts: [0, 2], data: Buffer.from([1, 2, 3]) }], { rou: 1 });
  ok(!unk.danger && unk.warnings.some(w => /невідомі програми/.test(w)), 'solana: невідома програма — попередження без паніки');
  const tc = mk([me, acc1, mint, other, TOKEN], [{ program: 4, accounts: [1, 2, 3, 0], data: Buffer.concat([Buffer.from([12]), u64(2_500_000), Buffer.from([6])]) }], { rou: 1 });
  ok(tc.lines.some(l => /Переказ токенів 2\.5 /.test(l[1])) && !tc.danger, 'solana: TransferChecked — кількість з урахуванням decimals');
  const v0 = mk([me, other, SYS], [{ program: 2, accounts: [0, 1], data: Buffer.concat([u32(2), u64(1)]) }], { rou: 1, v0: [{ table: key(11), writable: [0], readonly: [1] }] });
  ok(S.parseTransaction(wire(message({ keys: [me, other, SYS], rou: 1, ins: [{ program: 2, accounts: [0, 1], data: Buffer.concat([u32(2), u64(1)]) }], v0: [{ table: key(11), writable: [0], readonly: [1] }] }))).parsed.version === 0
    && v0.warnings.some(w => /адресні таблиці/.test(w)), 'solana: версія v0 з адресними таблицями — попередження про приховані акаунти');

  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  ok(throws(() => S.parseTransaction(wire(transferMsg).subarray(0, 120))), 'solana: обірвана транзакція відхиляється');
  ok(throws(() => S.parseTransaction(Buffer.concat([wire(transferMsg), Buffer.from([1])]))), 'solana: зайві байти після транзакції відхиляються');
  ok(throws(() => S.parseTransaction(wire(message({ keys: [me, other, SYS], rou: 1, ins: [{ program: 9, accounts: [0], data: Buffer.alloc(1) }] })))), 'solana: програма поза списком акаунтів відхиляється');
  ok(throws(() => S.parseTransaction(wire(message({ keys: [me, other, SYS], rou: 1, ins: [{ program: 2, accounts: [0, 9], data: Buffer.alloc(12) }] })))), 'solana: акаунт інструкції поза списком відхиляється');
  ok(throws(() => S.parseTransaction(wire(transferMsg, 2))), 'solana: кількість підписів має збігатися із заголовком');

  // ---------- 3. підпис ----------
  const sig1 = S.signTransaction(kp0.secret, me, wire(transferMsg));
  ok(S.verify(kp0.publicKey, transferMsg, sig1.signature) && sig1.signedWire.subarray(1, 65).equals(sig1.signature) && sig1.signedWire.length === wire(transferMsg).length, 'solana: підпис транзакції стоїть у слоті підписанта і перевіряється');
  const twoSig = wire(message({ keys: [other, me, SYS], numSigs: 2, rou: 1, ins: [{ program: 2, accounts: [1, 0], data: Buffer.concat([u32(2), u64(1)]) }] }), 2);
  const sig2 = S.signTransaction(kp0.secret, me, twoSig);
  ok(sig2.index === 1 && sig2.signedWire.subarray(1, 65).equals(Buffer.alloc(64)) && !sig2.signedWire.subarray(65, 129).equals(Buffer.alloc(64)), 'solana: другий підписант — підписується лише свій слот');
  ok(throws(() => S.signTransaction(kp0.secret, key(40), wire(transferMsg))), 'solana: не підписує, якщо рахунок не є підписантом');
  ok(S.parseTransaction(S.unsignedWire(transferMsg)).parsed.keys[0] === me, 'solana: транзакція без підписів для симуляції');

  // ---------- 4. наскрізно: сторінка → гаманець ----------
  const real = { vault: ctx.vault, wallet: ctx.wallet, settings: ctx.settingsStore };
  ctx.settingsStore = new Store('t-solana-settings', JSON.parse(JSON.stringify(real.settings.data)), tmp('sset'));
  ctx.vault = new Vault({ dir: tmp('svault'), onChange: () => { ctx.pushAll(); ctx.wallet.onVaultChange(); } });
  ctx.wallet = new W(ctx, { allowInsecureRpc: true });
  const wal = ctx.wallet;
  await ctx.vault.create(MASTER);
  const phrase = wal.create();
  const addr = wal.solAddresses()[0];
  const seedHex = Buffer.from(E.Mnemonic.fromPhrase(phrase).computeSeed().slice(2), 'hex');
  const myKp = S.deriveAccount(seedHex, 0);
  ok(addr === myKp.address && wal.solAddresses().length === 1, 'solana: адреса Solana виводиться з тієї самої фрази');
  ok(JSON.stringify(wal.info().sol.addresses) === JSON.stringify([addr]), 'solana: сторінка гаманця отримує адресу Solana');
  wal.addAccount();
  ok(wal.solAddresses().length === 2 && wal.solAddresses()[0] === addr && wal.solAddresses()[1] !== addr, 'solana: додатковий рахунок має власну адресу Solana');

  // мок Solana RPC (шлях визначає кластер)
  const rpcCalls = [];
  let simMode = 'ok';
  const rpc = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
      rpcCalls.push({ path: req.url, method: j.method, params: j.params });
      const r = (result) => ({ jsonrpc: '2.0', id: j.id, result });
      let out;
      switch (j.method) {
        case 'getBalance': out = r({ value: 10_000_000_000 }); break;
        case 'simulateTransaction': out = r({ value: simMode === 'err' ? { err: { InstructionError: [0, 'Custom'] }, accounts: null } : { err: null, accounts: [{ lamports: 8_499_995_000 }] } }); break;
        case 'sendTransaction': { const w = Buffer.from(j.params[0], 'base64'); out = r(S.b58encode(w.subarray(1, 65))); break; }
        default: out = { jsonrpc: '2.0', id: j.id, error: { code: -32601, message: 'no ' + j.method } };
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out));
    });
  });
  await new Promise(r => rpc.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${rpc.address().port}`;
  wal.setSolRpc('mainnet-beta', `${base}/main`);
  wal.setSolRpc('devnet', `${base}/devnet`);

  const html = '<html><head><title>dapp</title></head><body>dapp</body></html>';
  const mkSite = async () => {
    const s = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
    await new Promise(r => s.listen(0, '127.0.0.1', r));
    return { s, url: `http://127.0.0.1:${s.address().port}/`, origin: `http://127.0.0.1:${s.address().port}` };
  };
  const A = await mkSite(), B = await mkSite();
  const w = [...ctx.windows][0];
  const waitApproval = async () => { for (let i = 0; i < 60 && !w.approval; i++) await sleep(100); return w.approval; };
  const leaks = [];
  const scan = (x) => { const s = JSON.stringify(x); if (s.includes(phrase.split(' ').slice(0, 3).join(' ')) || s.includes(S.slip10(seedHex, [44, 501, 0, 0]).toString('hex'))) leaks.push(s.slice(0, 80)); };
  const run = (wc, expr) => wc.executeJavaScript(`(async () => { try { return { ok: await (${expr}) }; } catch (e) { return { err: e.code, msg: String(e.message) }; } })()`);
  const decide = async (approve) => { const a = w.approval; scan(a.spec); return w.decide(a.id, approve, MASTER); };
  const bytesExpr = (buf) => `new Uint8Array(${JSON.stringify([...buf])})`;
  // фальшива web3.js-транзакція: serialize() віддає дроти, підпис ставиться в signatures[0]
  const fakeTx = (buf) => `({ serialize: () => ${bytesExpr(buf)}, signatures: [{ publicKey: { toBase58: () => '${addr}' }, signature: null }] })`;

  w.exec('newTab'); w.exec('go', A.url); await sleep(1800);
  const wcA = w.wc();
  ok(await wcA.executeJavaScript('typeof window.solana') === 'object' && await wcA.executeJavaScript('window.solana.isW3IR === true'), 'solana: провайдер window.solana доступний сторінці');
  ok(await wcA.executeJavaScript(`new Promise(r => dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: { register: (x) => r(x.name + ':' + Object.keys(x.features).length + ':' + x.chains.join()) } })))`) === 'W3IR Wallet:6:solana:mainnet,solana:devnet,solana:testnet', 'solana: wallet-standard — гаманець реєструється (6 можливостей, 3 мережі)');
  ok(await wcA.executeJavaScript('window.solana.isConnected') === false && await wcA.executeJavaScript('window.solana.publicKey') === null, 'solana: до підключення публічного ключа немає');
  ok((await run(wcA, `solana.connect({ onlyIfTrusted: true })`)).err === 4100 && !w.approval, 'solana: connect(onlyIfTrusted) без довіри → 4100 без вікна');

  // підключення
  let pr = run(wcA, `solana.connect().then(r => r.publicKey.toBase58())`);
  const ap = await waitApproval();
  ok(ap && ap.spec.kind === 'connect' && ap.spec.origin === A.origin && ap.spec.lines.some(l => l[1] === addr), 'solana: запит підключення показано з origin від браузера і адресою');
  await decide(true);
  let res = await pr;
  ok(res.ok === addr, 'solana: після підтвердження сайт бачить лише публічну адресу');
  ok((await run(wcA, `solana.connect({ onlyIfTrusted: true }).then(r => r.publicKey.toBase58())`)).ok === addr && !w.approval, 'solana: підключений сайт відновлює сесію без нового вікна');
  ok((await wcA.executeJavaScript('window.solana.isConnected')) === true && (await wcA.executeJavaScript('window.solana.publicKey.toBase58()')) === addr, 'solana: isConnected/publicKey відображають стан');

  // повідомлення
  const msg = Buffer.from('Увійти в dApp: nonce 4242');
  pr = run(wcA, `solana.signMessage(${bytesExpr(msg)}).then(r => ({ sig: Array.from(r.signature), pk: r.publicKey.toBase58() }))`);
  const apM = await waitApproval();
  ok(apM.spec.lines.some(l => l[1] === msg.toString()), 'solana: текст повідомлення показано користувачу');
  await decide(true);
  res = await pr;
  ok(res.ok && res.ok.pk === addr && S.verify(myKp.publicKey, msg, Buffer.from(res.ok.sig)), 'solana: підпис повідомлення коректний (Ed25519)');
  scan(res);
  res = await run(wcA, `solana.signMessage(${bytesExpr(wire(transferMsg))})`);
  ok(res.err === -32602 && /схожі на транзакцію/.test(res.msg) && !w.approval, 'solana: транзакцію не можна підписати як «повідомлення»');
  res = await run(wcA, `solana.signMessage(${bytesExpr(transferMsg)})`);
  ok(res.err === -32602 && !w.approval, 'solana: повідомлення транзакції (без підписів) теж відхиляється');

  // транзакція: підпис
  const myTransfer = message({ keys: [addr, other, SYS], rou: 1, ins: [{ program: 2, accounts: [0, 1], data: Buffer.concat([u32(2), u64(1_500_000_000)]) }] });
  pr = run(wcA, `solana.signTransaction(${fakeTx(wire(myTransfer))}).then(t => Array.from(t.signatures[0].signature))`);
  const apT = await waitApproval();
  const L = apT.spec.lines;
  ok(L.some(l => /Переказ 1\.5 SOL/.test(l[1])) && L.some(l => l[0] === 'Симуляція' && l[1] === 'успішно') && L.some(l => l[0] === 'Зміна балансу SOL' && /^-1\.500005 SOL/.test(l[1])), 'solana: у підтвердженні — переказ, результат симуляції і зміна балансу');
  ok(L.some(l => l[0] === 'Мережа' && l[1] === 'Mainnet Beta') && !apT.spec.danger, 'solana: мережа показана, звичайний переказ без тривоги');
  ok(rpcCalls.some(c => c.method === 'simulateTransaction' && c.path === '/main'), 'solana: симуляція виконана через RPC вибраної мережі');
  await decide(true);
  res = await pr;
  ok(res.ok && S.verify(myKp.publicKey, myTransfer, Buffer.from(res.ok)), 'solana: підписана транзакція містить коректний підпис гаманця');
  scan(res);

  // транзакція: відправка
  const sendsBefore = rpcCalls.filter(c => c.method === 'sendTransaction').length;
  pr = run(wcA, `solana.signAndSendTransaction(${fakeTx(wire(myTransfer))}).then(r => r.signature)`);
  await waitApproval();
  await decide(true);
  res = await pr;
  const sent = rpcCalls.filter(c => c.method === 'sendTransaction');
  const sentWire = sent.length ? Buffer.from(sent[sent.length - 1].params[0], 'base64') : Buffer.alloc(0);
  ok(sent.length === sendsBefore + 1 && S.verify(myKp.publicKey, myTransfer, sentWire.subarray(1, 65)) && res.ok === S.b58encode(sentWire.subarray(1, 65)), 'solana: signAndSend — підписану транзакцію надіслано в мережу, повернено підпис');

  // дрейнер: SetAuthority
  const drain = message({ keys: [addr, acc1, TOKEN], rou: 1, ins: [{ program: 2, accounts: [1, 0], data: Buffer.concat([Buffer.from([6, 2, 1]), Buffer.alloc(32, 5)]) }] });
  pr = run(wcA, `solana.signAndSendTransaction(${fakeTx(wire(drain))})`);
  const apD = await waitApproval();
  ok(apD.spec.danger === true && apD.spec.warnings.some(x => /SetAuthority/.test(x)), 'solana: SetAuthority — тривога у вікні підтвердження');
  await decide(false);
  res = await pr;
  ok(res.err === 4001 && rpcCalls.filter(c => c.method === 'sendTransaction').length === sendsBefore + 1, 'solana: відхилення → 4001, у мережу нічого не надіслано');

  // симуляція з помилкою
  simMode = 'err';
  pr = run(wcA, `solana.signTransaction(${fakeTx(wire(myTransfer))})`);
  const apE = await waitApproval();
  ok(apE.spec.danger === true && apE.spec.warnings.some(x => /завершиться помилкою/.test(x)) && apE.spec.lines.some(l => l[0] === 'Симуляція' && /ПОМИЛКА/.test(l[1])), 'solana: невдала симуляція — попередження й червоний стан');
  await decide(false);
  await pr;
  simMode = 'ok';

  // чужі транзакції та мережі
  const foreign = message({ keys: [other, acc1, SYS], rou: 1, ins: [{ program: 2, accounts: [0, 1], data: Buffer.concat([u32(2), u64(1)]) }] });
  res = await run(wcA, `solana.signTransaction(${fakeTx(wire(foreign))})`);
  ok(res.err === -32602 && /не потребує підпису/.test(res.msg) && !w.approval, 'solana: транзакція без нашого підпису відхиляється без вікна');
  res = await run(wcA, `solana.signAllTransactions([${fakeTx(wire(myTransfer))}, ${fakeTx(wire(foreign))}])`);
  ok(res.err === -32602 && !w.approval, 'solana: у пакеті одна чужа транзакція → весь пакет відхилено без вікна');
  pr = run(wcA, `solana.signAllTransactions([${fakeTx(wire(myTransfer))}, ${fakeTx(wire(myTransfer))}]).then(r => r.length)`);
  const apAll = await waitApproval();
  ok(apAll.spec.lines.filter(l => /Транзакція$/.test(l[0])).length === 2, 'solana: пакет — у вікні перелічено обидві транзакції');
  await decide(true);
  ok((await pr).ok === 2, 'solana: signAllTransactions повертає всі підписані транзакції');

  // wallet-standard: підпис у devnet
  pr = wcA.executeJavaScript(`new Promise(async (resolve) => {
    try {
      let wl; dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: { register: (x) => { wl = x; } } }));
      const account = wl.accounts[0];
      const out = await wl.features['solana:signTransaction'].signTransaction({ account, transaction: ${bytesExpr(wire(myTransfer))}, chain: 'solana:devnet' });
      resolve({ ok: Array.from(out[0].signedTransaction) });
    } catch (e) { resolve({ err: e.code, msg: String(e.message) }); }
  })`);
  const apS = await waitApproval();
  ok(apS.spec.lines.some(l => l[0] === 'Мережа' && l[1] === 'Devnet') && rpcCalls.some(c => c.path === '/devnet' && c.method === 'simulateTransaction'), 'solana: wallet-standard — chain solana:devnet вибирає Devnet для симуляції');
  await decide(true);
  res = await pr;
  ok(res.ok && S.verify(myKp.publicKey, myTransfer, Buffer.from(res.ok).subarray(1, 65)), 'solana: wallet-standard signTransaction повертає підписану транзакцію');
  pr = wcA.executeJavaScript(`new Promise(async (resolve) => {
    try {
      let wl; dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: { register: (x) => { wl = x; } } }));
      const out = await wl.features['solana:signAndSendTransaction'].signAndSendTransaction({ account: wl.accounts[0], transaction: ${bytesExpr(wire(myTransfer))}, chain: 'solana:devnet' });
      resolve({ ok: Array.from(out[0].signature) });
    } catch (e) { resolve({ err: e.code, msg: String(e.message) }); }
  })`);
  await waitApproval();
  await decide(true);
  res = await pr;
  ok(res.ok && res.ok.length === 64 && S.verify(myKp.publicKey, myTransfer, Buffer.from(res.ok)), 'solana: wallet-standard signAndSendTransaction повертає 64-байтовий підпис');

  // інший сайт: без підключення нічого
  w.exec('newTab'); w.exec('go', B.url); await sleep(1800);
  const wcB = w.wc();
  for (const [name, expr] of [['signMessage', `solana.signMessage(${bytesExpr(msg)})`], ['signTransaction', `solana.signTransaction(${fakeTx(wire(myTransfer))})`], ['signAndSendTransaction', `solana.signAndSendTransaction(${fakeTx(wire(myTransfer))})`]]) {
    const r = await run(wcB, expr);
    ok(r.err === 4100 && !w.approval, `solana: ${name} без підключення → 4100, вікно не відкривається`);
  }

  // блокування сховища
  w.exec('switchTab', w.tabs.find(t => t.view.webContents === wcA).id);
  ctx.vault.lock();
  await sleep(300);
  ok(await wcA.executeJavaScript('window.solana.isConnected') === false, 'solana: при блокуванні сховища сайт отримує disconnect');
  res = await run(wcA, `solana.signMessage(${bytesExpr(msg)})`);
  ok(res.err === 4100 && rpcCalls.filter(c => c.method === 'sendTransaction').length === sendsBefore + 2, 'solana: заблокований гаманець нічого не підписує');
  await ctx.vault.unlock(MASTER);
  ctx.vault.nextAllowed = 0;

  // сторінка гаманця показує розділ Solana
  w.exec('newTab'); w.exec('go', 'w3ir://wallet'); await sleep(2500);
  const pageText = await w.wc().executeJavaScript('document.body.innerText');
  ok(pageText.includes(addr) && /Solana/.test(pageText) && pageText.includes(wal.solAddresses()[1]), 'solana: сторінка гаманця показує розділ Solana з адресами рахунків');
  w.exec('switchTab', w.tabs.find(t => t.view.webContents === wcA).id);

  // відключення сайту та журнал
  ok(wal.solInfo().connections.length === 1 && wal.info().log.some(l => /Solana/.test(l.action)), 'solana: підключений сайт і журнал дій ведуться');
  wal.disconnectSite(A.origin);
  await sleep(200);
  ok(wal.solAccountsFor(A.origin).length === 0, 'solana: після відключення сайт знову нічого не бачить');
  ok(leaks.length === 0, 'solana: фраза й приватний ключ не потрапили в жодне повідомлення/відповідь');

  // налаштування мережі
  wal.setSolCluster('devnet');
  ok(wal.solCluster() === 'devnet' && wal.solClusters().length === 3, 'solana: активну мережу можна змінити');
  let badC = ''; try { wal.setSolCluster('moon'); } catch (e) { badC = e.message; }
  ok(/Невідома мережа/.test(badC), 'solana: невідома мережа відхиляється');
  let badR = ''; try { wal.setSolRpc('devnet', 'http://evil.example'); } catch (e) { badR = e.message; }
  ok(/RPC має бути/.test(badR), 'solana: небезпечний (http) RPC відхиляється');

  A.s.close(); B.s.close(); rpc.close();
  ctx.settingsStore.flush();
  Object.assign(ctx, { vault: real.vault, wallet: real.wallet, settingsStore: real.settings });
}

module.exports = { solanaTests };
