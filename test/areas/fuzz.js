'use strict';
// Fuzz-перевірки розбору чужих даних: випадкові та спотворені входи не повинні ламати програму, зависати
// чи кидати щось інше, ніж Error. Генератор із фіксованим зерном — збої відтворюються.
const S = require('../../src/solana');
const guard = require('../../src/injection-guard');
const { describeCall } = require('../../src/wallet');
const { ok } = require('../lib');

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const randBytes = (r, n) => Buffer.from(Array.from({ length: n }, () => Math.floor(r() * 256)));
const key = (n) => S.b58encode(Buffer.alloc(32, n));

async function fuzzTests() {
  const r = rng(20261017);
  const t0 = Date.now();

  // ---------- 1. розбір транзакцій Solana ----------
  const valid = S.unsignedWire(S.compileMessage({ feePayer: key(1), blockhash: key(9), instructions: [
    S.ixCreateAtaIdempotent({ payer: key(1), owner: key(2), mint: key(3) }),
    S.ixTransferChecked({ source: key(4), mint: key(3), dest: S.ataAddress(key(2), key(3)), owner: key(1), amount: 5n, decimals: 6 }),
    S.ixSystemTransfer(key(1), key(5), 7n),
  ] }));
  let threw = 0, parsedOk = 0, bad = [];
  const attempt = (buf) => {
    try {
      const tx = S.parseTransaction(buf);
      S.describe(tx.parsed, [key(1)]);
      parsedOk++;
    } catch (e) {
      if (!(e instanceof Error)) bad.push(typeof e);
      threw++;
    }
  };
  for (let i = 0; i < 3000; i++) attempt(randBytes(r, Math.floor(r() * 1400)));
  for (let i = 0; i < 6000; i++) {
    const b = Buffer.from(valid);
    const kind = Math.floor(r() * 4);
    if (kind === 0) for (let k = 0, n = 1 + Math.floor(r() * 4); k < n; k++) b[Math.floor(r() * b.length)] = Math.floor(r() * 256);
    else if (kind === 1) attempt(b.subarray(0, Math.floor(r() * b.length)));
    else if (kind === 2) attempt(Buffer.concat([b, randBytes(r, 1 + Math.floor(r() * 20))]));
    else b[Math.floor(r() * 140)] ^= 1 << Math.floor(r() * 8);
    if (kind !== 1 && kind !== 2) attempt(b);
  }
  ok(bad.length === 0 && threw > 0, `fuzz: 9 000 спотворених/випадкових транзакцій Solana — лише Error, без збоїв (розібрано ${parsedOk}, відхилено ${threw})`);
  ok(S.parseTransaction(valid).parsed.instructions.length === 3, 'fuzz: еталонна транзакція розбирається (контроль генератора)');

  // ---------- 2. зворотний розбір побудованих повідомлень ----------
  const pool = Array.from({ length: 12 }, (_, i) => key(20 + i));
  let roundTripBad = 0;
  for (let i = 0; i < 1500; i++) {
    const payer = pool[Math.floor(r() * pool.length)];
    const instructions = Array.from({ length: 1 + Math.floor(r() * 5) }, () => ({
      programId: pool[Math.floor(r() * pool.length)],
      keys: Array.from({ length: Math.floor(r() * 6) }, () => ({ pubkey: pool[Math.floor(r() * pool.length)], isSigner: r() < 0.3, isWritable: r() < 0.5 })),
      data: randBytes(r, Math.floor(r() * 40)),
    }));
    try {
      const parsed = S.parseMessage(S.compileMessage({ feePayer: payer, instructions, blockhash: key(9) }));
      const same = parsed.keys[0] === payer && parsed.instructions.length === instructions.length && parsed.instructions.every((ins, k) =>
        ins.programId === instructions[k].programId && ins.accounts.map(a => parsed.keys[a]).join() === instructions[k].keys.map(x => x.pubkey).join() && ins.data.equals(instructions[k].data));
      // підписанти — рівно ті, що вказані як isSigner (плюс платник), і лише вони в перших numSigs ключах
      const wantSigners = new Set([payer, ...instructions.flatMap(x => x.keys.filter(k => k.isSigner).map(k => k.pubkey))]);
      const gotSigners = new Set(parsed.keys.slice(0, parsed.numSigs));
      if (!same || wantSigners.size !== gotSigners.size || [...wantSigners].some(k => !gotSigners.has(k))) roundTripBad++;
    } catch { roundTripBad++; }
  }
  ok(roundTripBad === 0, 'fuzz: 1 500 випадкових наборів інструкцій — compileMessage → parseMessage повертає ті самі програми, акаунти за інструкціями, дані й набір підписантів');

  // ---------- 3. сума й адреси ----------
  let amountBad = 0;
  const alphabet = '0123456789.,-+eE xX‮\n\t';
  for (let i = 0; i < 4000; i++) {
    const text = Array.from({ length: Math.floor(r() * 24) }, () => alphabet[Math.floor(r() * alphabet.length)]).join('');
    for (const [fn, args] of [[S.parseSol, [text]], [S.parseUnits, [text, Math.floor(r() * 12)]]]) {
      try {
        const v = fn(...args);
        // успіх можливий лише для канонічного запису «цифри[.цифри]» і додатного значення
        if (typeof v !== 'bigint' || v <= 0n || !/^\d+(\.\d+)?$/.test(text)) amountBad++;
      } catch (e) { if (!(e instanceof Error)) amountBad++; }
    }
  }
  ok(amountBad === 0, 'fuzz: 8 000 випадкових сум — приймаються лише канонічні додатні числа, решта відхиляється Error');
  let addrBad = 0;
  for (let i = 0; i < 3000; i++) {
    const text = Array.from({ length: Math.floor(r() * 50) }, () => '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0OIl'[Math.floor(r() * 62)]).join('');
    try { if (S.isAddress(text) && S.b58encode(S.b58decode(text)) !== text) addrBad++; } catch { addrBad++; }
  }
  ok(addrBad === 0, 'fuzz: 3 000 випадкових рядків — isAddress не кидає, а валідні адреси кодуються назад без змін');
  let b58bad = 0;
  for (let i = 0; i < 1500; i++) { const b = randBytes(r, 1 + Math.floor(r() * 69)); if (!S.b58decode(S.b58encode(b)).equals(b)) b58bad++; }
  ok(b58bad === 0, 'fuzz: base58 кодування-декодування випадкових байтів (у т. ч. з початковими нулями) без втрат');

  // ---------- 4. метадані токенів і розшифровка викликів EVM ----------
  let metaBad = 0;
  for (let i = 0; i < 3000; i++) {
    const b = randBytes(r, Math.floor(r() * 400));
    if (r() < 0.5 && b.length > 70) b[0] = 4;
    try { const m = S.parseMetadata(b); if (m !== null && (typeof m.name !== 'string' || /[‮​]/.test(m.name))) metaBad++; } catch { metaBad++; }
  }
  ok(metaBad === 0, 'fuzz: 3 000 випадкових рахунків метаданих — parseMetadata не кидає й не повертає керівних символів');
  let evmBad = 0;
  for (let i = 0; i < 3000; i++) {
    const data = '0x' + randBytes(r, Math.floor(r() * 120)).toString('hex');
    try { const d = describeCall(data); if (!Array.isArray(d.lines) || !Array.isArray(d.warnings)) evmBad++; } catch { evmBad++; }
  }
  for (const sel of ['095ea7b3', 'a9059cbb', '23b872dd', 'a22cb465', '42842e0e']) {
    for (let i = 0; i < 200; i++) { try { describeCall('0x' + sel + randBytes(r, Math.floor(r() * 140)).toString('hex')); } catch { evmBad++; } }
  }
  ok(evmBad === 0, 'fuzz: розшифровка викликів EVM на випадкових і напіввалідних даних (approve, transfer, setApprovalForAll…) не кидає');

  // ---------- 5. фільтр ін’єкцій ----------
  let guardBad = 0;
  const glyphs = ['a', 'Б', ' ', '\n', '​', '‮', '\u{E0041}', '\u{E0049}', 'ignore all previous instructions', 'ｉｇｎｏｒｅ', '👨‍👩', '<|im_start|>', 'https://x.example', '\u0000', 'w3ir://'];
  for (let i = 0; i < 3000; i++) {
    const text = Array.from({ length: Math.floor(r() * 30) }, () => glyphs[Math.floor(r() * glyphs.length)]).join('');
    try {
      const a = guard.sanitize(text), b = guard.sanitize(a.text);
      const ex = guard.examine(text, { hidden: r() < 0.3 ? [text.slice(0, 20)] : [] });
      if (b.text !== a.text || b.removed !== 0 || /[​-‏‪-‮\u{E0000}-\u{E007F}\u0000]/u.test(ex.text) || typeof ex.header !== 'string') guardBad++;
    } catch { guardBad++; }
  }
  ok(guardBad === 0, 'fuzz: 3 000 випадкових текстів — санітизація ідемпотентна, невидимих символів у виході немає, фільтр не кидає');

  const ms = Date.now() - t0;
  ok(ms < 60000, `fuzz: усі набори відпрацювали за ${(ms / 1000).toFixed(1)} с (без зависань)`);
}

module.exports = { fuzzTests };
