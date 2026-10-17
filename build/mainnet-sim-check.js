'use strict';
// Перевірка будівників транзакцій Solana на справжньому середовищі виконання mainnet БЕЗ коштів і без підписів:
// simulateTransaction із sigVerify:false виконує транзакцію на реальному стані від імені існуючого гаманця-власника USDC.
// Якщо порядок акаунтів, заголовок, PDA асоційованого токен-акаунта чи кодування інструкцій хибні — мережа відхилить симуляцію.
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe build/mainnet-sim-check.js [rpc-url]
const crypto = require('crypto');
const S = require('../src/solana');

const RPC = process.argv[2] || 'https://api.mainnet-beta.solana.com';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (cond, name, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!cond) failed++; };

async function rpc(method, params, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await r.json().catch(() => ({}));
    if (j.error && (j.error.code === 429 || /too many|rate/i.test(j.error.message || ''))) { await sleep(4000 * (i + 1)); continue; }
    if (j.error) { const e = new Error(j.error.message); e.data = j.error.data; throw e; }
    return j.result;
  }
  throw new Error('RPC: ліміт запитів, повторіть пізніше');
}

const simulate = async (message) => (await rpc('simulateTransaction', [S.unsignedWire(message).toString('base64'), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }])).value;

(async () => {
  console.log('RPC', RPC);
  // 1. справжні власники USDC: з нещодавніх транзакцій mint (легкі запити, не getTokenLargestAccounts)
  let matches = 0, holder = null, seen = 0;
  const sigs = (await rpc('getSignaturesForAddress', [USDC, { limit: 25, commitment: 'confirmed' }])).filter(x => !x.err).map(x => x.signature);
  for (const sig of sigs) {
    if (holder && matches >= 3) break;
    if (sigs.indexOf(sig) > 18 && holder) break;
    const tx = await rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]).catch(() => null);
    if (!tx || !tx.meta) continue;
    const keys = tx.transaction.message.accountKeys.map(k => (typeof k === 'string' ? k : k.pubkey));
    for (const tb of tx.meta.postTokenBalances || []) {
      if (tb.mint !== USDC || !tb.owner || !(BigInt(tb.uiTokenAmount.amount) > 1_000_000n)) continue;
      seen++;
      if (S.ataAddress(tb.owner, USDC) === keys[tb.accountIndex]) {
        matches++;
        if (!holder) {
          // платником комісії може бути лише звичайний акаунт System Program із достатнім балансом (не PDA програми)
          const acc = (await rpc('getAccountInfo', [tb.owner, { encoding: 'base64', commitment: 'confirmed' }])).value;
          if (acc && acc.owner === S.PROGRAMS.SYSTEM && !acc.executable && acc.lamports >= 10_000_000) holder = { owner: tb.owner, ata: keys[tb.accountIndex], amount: BigInt(tb.uiTokenAmount.amount) };
        }
      }
    }
  }
  check(matches >= 1, 'PDA асоційованого токен-акаунта збігається зі справжніми ATA власників USDC із нещодавніх транзакцій', `${matches} із ${seen}`);
  if (!holder) { console.log('SKIP: не знайдено власника з ATA'); process.exit(2); }
  const solBal = (await rpc('getBalance', [holder.owner])).value;
  console.log('власник', holder.owner, 'SOL', solBal, 'USDC', holder.amount);
  if (solBal < 10_000_000) { console.log('SKIP: у власника замало SOL для симуляції'); process.exit(2); }

  const bh = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
  const stranger = S.keypairFromSeed(crypto.randomBytes(32)).address;

  // 2. переказ SOL: симуляція має пройти й показати зменшення балансу
  const m1 = S.buildTransferMessage({ from: holder.owner, to: stranger, lamports: 5_000_000n, blockhash: bh });
  const s1 = await simulate(m1);
  check(!s1.err, 'симуляція переказу SOL на реальному стані без помилок', s1.err ? JSON.stringify(s1.err) : '');

  // 3. переказ USDC новому одержувачу: CreateIdempotent ATA + TransferChecked (decimals 6)
  const strangerAta = S.ataAddress(stranger, USDC);
  const m2 = S.compileMessage({ feePayer: holder.owner, blockhash: bh, instructions: [
    S.ixCreateAtaIdempotent({ payer: holder.owner, owner: stranger, mint: USDC }),
    S.ixTransferChecked({ source: holder.ata, mint: USDC, dest: strangerAta, owner: holder.owner, amount: 1n, decimals: 6 }),
  ] });
  const s2 = await simulate(m2);
  check(!s2.err, 'симуляція створення ATA + TransferChecked USDC виконується мережею', s2.err ? JSON.stringify(s2.err) + ' ' + (s2.logs || []).slice(-3).join(' | ') : '');
  check((s2.logs || []).some(l => /CreateIdempotent|Initialize the associated token account/i.test(l)), 'у журналі виконання є створення асоційованого токен-акаунта (CreateIdempotent)');

  // 4. негативні перевірки: мережа ПОВИННА відхилити хибні варіанти (доводить, що перевірка справді працює)
  const wrongAta = S.compileMessage({ feePayer: holder.owner, blockhash: bh, instructions: [
    S.ixTransferChecked({ source: holder.ata, mint: USDC, dest: S.ataAddress(stranger, USDC), owner: holder.owner, amount: 1n, decimals: 6 }), // одержувач ATA не існує
  ] });
  const s3 = await simulate(wrongAta);
  check(!!s3.err, 'переказ у неіснуючий токен-акаунт мережа відхиляє (без CreateIdempotent)');
  const wrongDecimals = S.compileMessage({ feePayer: holder.owner, blockhash: bh, instructions: [
    S.ixCreateAtaIdempotent({ payer: holder.owner, owner: stranger, mint: USDC }),
    S.ixTransferChecked({ source: holder.ata, mint: USDC, dest: strangerAta, owner: holder.owner, amount: 1n, decimals: 9 }),
  ] });
  const s4 = await simulate(wrongDecimals);
  check(!!s4.err, 'хибні decimals у TransferChecked мережа відхиляє');
  const tooMuch = S.compileMessage({ feePayer: holder.owner, blockhash: bh, instructions: [
    S.ixCreateAtaIdempotent({ payer: holder.owner, owner: stranger, mint: USDC }),
    S.ixTransferChecked({ source: holder.ata, mint: USDC, dest: strangerAta, owner: holder.owner, amount: holder.amount + 1n, decimals: 6 }),
  ] });
  const s5 = await simulate(tooMuch);
  check(!!s5.err, 'переказ більший за баланс мережа відхиляє');

  console.log(failed ? `\nЗБОЇ: ${failed}` : '\nУсе пройшло на справжньому середовищі виконання mainnet (симуляція).');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('ПОМИЛКА:', e.message, e.data ? JSON.stringify(e.data).slice(0, 300) : ''); process.exit(1); });
