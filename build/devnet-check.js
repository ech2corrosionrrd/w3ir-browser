'use strict';
// Перевірка будівників транзакцій Solana на ЖИВІЙ мережі Devnet (без реальних коштів):
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe build/devnet-check.js [rpc-url]
// Створюється одноразова пара ключів, отримується безкоштовний airdrop, виконуються: переказ SOL, створення токена (mint),
// асоційованих токен-акаунтів, випуск і переказ токенів (TransferChecked). Мережа сама відхилить хибно побудовану
// транзакцію, тож успіх підтверджує коректність compileMessage, PDA (ATA), інструкцій і підписів. Код виходу 1 — є збій.
const crypto = require('crypto');
const S = require('../src/solana');

const RPC = process.argv[2] || 'https://api.devnet.solana.com';
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

const kp = () => S.keypairFromSeed(crypto.randomBytes(32));

// Підписує всіма вказаними ключами, надсилає й чекає підтвердження
async function sendTx(message, signers, label) {
  let wire = S.unsignedWire(message);
  const parsed = S.parseMessage(message);
  for (const k of signers) wire = S.signTransaction(k.secret, k.address, wire).signedWire;
  // симуляція перед відправкою — так само, як робить гаманець
  const sim = await rpc('simulateTransaction', [wire.toString('base64'), { encoding: 'base64', sigVerify: true, commitment: 'processed' }]);
  if (sim.value.err) throw new Error(`${label}: симуляція: ${JSON.stringify(sim.value.err)} ${(sim.value.logs || []).slice(-3).join(' | ')}`);
  const sig = await rpc('sendTransaction', [wire.toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
  for (let i = 0; i < 60; i++) {
    const st = (await rpc('getSignatureStatuses', [[sig]])).value[0];
    if (st && st.err) throw new Error(`${label}: помилка в мережі ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return { sig, accounts: parsed.keys.length };
    await sleep(1000);
  }
  throw new Error(`${label}: не підтверджено за 60 с`);
}

const latest = async () => (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
const balance = async (a) => (await rpc('getBalance', [a, { commitment: 'confirmed' }])).value;

(async () => {
  const a = kp(), b = kp();
  console.log('RPC', RPC, '\nвідправник', a.address, '\nодержувач', b.address);

  // 1. безкоштовні тестові SOL
  let funded = 0;
  for (const amount of [1_000_000_000, 500_000_000, 200_000_000, 100_000_000, 50_000_000]) {
    try {
      const sig = await rpc('requestAirdrop', [a.address, amount]);
      for (let i = 0; i < 40 && !funded; i++) { await sleep(1000); funded = await balance(a.address); }
      if (funded) { console.log('airdrop', amount, 'підпис', sig.slice(0, 16) + '…'); break; }
    } catch (e) { console.log('airdrop не вдався:', e.message); await sleep(2000); }
  }
  if (!funded) { console.log('SKIP: Devnet не видав тестові SOL (ліміт faucet). Повторіть пізніше або вкажіть інший RPC.'); process.exit(2); }

  // 2. переказ SOL
  const t0 = await sendTx(S.buildTransferMessage({ from: a.address, to: b.address, lamports: 12_345_678n, blockhash: await latest() }), [a], 'переказ SOL');
  check(await balance(b.address) === 12_345_678, 'переказ SOL: баланс одержувача точно збігається із сумою', t0.sig.slice(0, 12));

  // 3. створення mint (CreateAccount + InitializeMint2), ATA для обох, випуск токенів
  const mint = kp();
  const decimals = 6;
  const rent = await rpc('getMinimumBalanceForRentExemption', [82]);
  const createMint = { programId: S.PROGRAMS.SYSTEM, keys: [{ pubkey: a.address, isSigner: true, isWritable: true }, { pubkey: mint.address, isSigner: true, isWritable: true }],
    data: Buffer.concat([Buffer.from([0, 0, 0, 0]), S.u64(rent), S.u64(82), S.b58decode(S.PROGRAMS.TOKEN)]) };
  const initMint = { programId: S.PROGRAMS.TOKEN, keys: [{ pubkey: mint.address, isSigner: false, isWritable: true }], data: Buffer.concat([Buffer.from([20, decimals]), S.b58decode(a.address), Buffer.from([0])]) };
  const ataA = S.ataAddress(a.address, mint.address), ataB = S.ataAddress(b.address, mint.address);
  const mintTo = { programId: S.PROGRAMS.TOKEN, keys: [{ pubkey: mint.address, isSigner: false, isWritable: true }, { pubkey: ataA, isSigner: false, isWritable: true }, { pubkey: a.address, isSigner: true, isWritable: false }], data: Buffer.concat([Buffer.from([7]), S.u64(1_000_000_000)]) };
  const msg1 = S.compileMessage({ feePayer: a.address, blockhash: await latest(), instructions: [createMint, initMint, S.ixCreateAtaIdempotent({ payer: a.address, owner: a.address, mint: mint.address }), mintTo] });
  const t1 = await sendTx(msg1, [a, mint], 'створення токена');
  const info = (await rpc('getAccountInfo', [mint.address, { encoding: 'jsonParsed' }])).value;
  check(info && info.owner === S.PROGRAMS.TOKEN && info.data.parsed.info.decimals === decimals && info.data.parsed.info.supply === '1000000000', 'токен створено: власник програма Token, decimals і випуск збігаються', t1.sig.slice(0, 12));
  check(S.parseMessage(msg1).numSigs === 2 && S.parseMessage(msg1).keys[0] === a.address, 'compileMessage: два підписанти, платник комісії першим');

  // 4. токен-акаунт одержувача створює переказ (CreateIdempotent) і переказує токени
  const amount = 123_456_789n; // 123.456789 при 6 знаках
  const msg2 = S.compileMessage({ feePayer: a.address, blockhash: await latest(), instructions: [
    S.ixCreateAtaIdempotent({ payer: a.address, owner: b.address, mint: mint.address }),
    S.ixTransferChecked({ source: ataA, mint: mint.address, dest: ataB, owner: a.address, amount, decimals }),
  ] });
  const t2 = await sendTx(msg2, [a], 'переказ токенів');
  const accs = (await rpc('getTokenAccountsByOwner', [b.address, { programId: S.PROGRAMS.TOKEN }, { encoding: 'jsonParsed', commitment: 'confirmed' }])).value;
  const parsed = accs[0] && accs[0].account.data.parsed.info;
  check(accs.length === 1 && parsed.mint === mint.address && parsed.tokenAmount.amount === '123456789' && parsed.tokenAmount.decimals === 6, 'токени дійшли: відповідь getTokenAccountsByOwner має очікувану форму (mint, tokenAmount.amount, decimals)', t2.sig.slice(0, 12));
  check(accs[0].pubkey === ataB, 'адреса асоційованого токен-акаунта (PDA) збігається з тією, що створила мережа');

  // 5. повторне створення ATA не ламає транзакцію (idempotent)
  await sendTx(S.compileMessage({ feePayer: a.address, blockhash: await latest(), instructions: [S.ixCreateAtaIdempotent({ payer: a.address, owner: b.address, mint: mint.address })] }), [a], 'повторне створення ATA');
  check(true, 'CreateIdempotent повторно не завершується помилкою');

  // 6. розшифровка власних транзакцій і історія
  const d = S.describe(S.parseMessage(msg2), [a.address]);
  check(d.lines.some(l => /Переказ токенів 123\.456789/.test(l[1])) && d.lines.some(l => /Створення токен-акаунта/.test(l[1])), 'describe: розпізнає створення токен-акаунта й переказ 123.456789');
  const hist = await rpc('getSignaturesForAddress', [a.address, { limit: 10 }]);
  check(hist.length >= 4 && hist.every(h => typeof h.signature === 'string' && 'slot' in h), 'getSignaturesForAddress: історія рахунку доступна', String(hist.length));

  console.log(failed ? `\nЗБОЇ: ${failed}` : '\nУсе пройшло на живій мережі Devnet.');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('ПОМИЛКА:', e.message, e.data ? JSON.stringify(e.data).slice(0, 300) : ''); process.exit(1); });
