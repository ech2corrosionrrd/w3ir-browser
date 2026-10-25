'use strict';
// Solana без сторонніх бібліотек: base58, ключі Ed25519 за SLIP-0010 (m/44'/501'/N'/0', як у Phantom/Solflare),
// розбір і підпис транзакцій (legacy та v0), розшифровка інструкцій з попередженнями про шахрайські шаблони.
// Лише чиста логіка (без мережі й сховища) — вона повністю покрита тестами.
const crypto = require('crypto');
const { sanitize } = require('./injection-guard');

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function b58encode(input) {
  const buf = Buffer.from(input);
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  return '1'.repeat(zeros) + s;
}

function b58decode(str) {
  if (typeof str !== 'string' || !str || str.length > 200) throw new Error('Некоректний base58');
  let n = 0n;
  for (const c of str) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error('Некоректний base58');
    n = n * 58n + BigInt(i);
  }
  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return Buffer.concat([Buffer.alloc(zeros), n === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex')]);
}

const isAddress = (s) => { try { return b58decode(s).length === 32; } catch { return false; } };

// ---------- ключі ----------
const HARDENED = 0x80000000;

// SLIP-0010 для Ed25519: усі індекси «загартовані»
function slip10(seed, path) {
  let I = crypto.createHmac('sha512', 'ed25519 seed').update(seed).digest();
  let k = I.subarray(0, 32), c = I.subarray(32);
  for (const idx of path) {
    const data = Buffer.alloc(37);
    k.copy(data, 1);
    data.writeUInt32BE((idx | HARDENED) >>> 0, 33);
    I = crypto.createHmac('sha512', c).update(data).digest();
    k = I.subarray(0, 32); c = I.subarray(32);
  }
  return Buffer.from(k);
}

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

function keypairFromSeed(seed32) {
  const secret = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed32]), format: 'der', type: 'pkcs8' });
  const spki = crypto.createPublicKey(secret).export({ format: 'der', type: 'spki' });
  const publicKey = Buffer.from(spki.subarray(spki.length - 32));
  return { secret, publicKey, address: b58encode(publicKey) };
}

function generateKeypair() {
  return keypairFromSeed(crypto.randomBytes(32));
}

// Рахунок №index: m/44'/501'/index'/0' (перший рахунок збігається з Phantom/Solflare для тієї самої фрази)
// Шляхи Solana: phantom — m/44'/501'/i'/0' (Phantom, Solflare, Backpack); bip44 — m/44'/501'/i' (Ledger Live, старі гаманці)
const SOL_PATHS = { phantom: (i) => [44, 501, i, 0], bip44: (i) => [44, 501, i] };
function deriveAccount(bip39Seed, index, kind = 'phantom') {
  const f = SOL_PATHS[kind];
  if (!f) throw new Error('Невідомий шлях деривації Solana');
  return keypairFromSeed(slip10(bip39Seed, f(index)));
}

const sign = (secret, bytes) => crypto.sign(null, Buffer.from(bytes), secret);
const verify = (publicKey, bytes, signature) => {
  const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey)]), format: 'der', type: 'spki' });
  return crypto.verify(null, Buffer.from(bytes), pub, Buffer.from(signature));
};

// ---------- розбір транзакцій ----------
function readShortVec(buf, off) {
  let len = 0;
  for (let size = 0; size < 3; size++) {
    const b = buf[off + size];
    if (b === undefined) throw new Error('Обірвана транзакція');
    len |= (b & 0x7f) << (size * 7);
    if (!(b & 0x80)) return [len, size + 1];
  }
  throw new Error('Некоректна довжина');
}

function parseMessage(msg) {
  msg = Buffer.from(msg);
  const need = (o, n) => { if (o + n > msg.length) throw new Error('Обірване повідомлення транзакції'); };
  let o = 0, version = 'legacy';
  need(0, 1);
  if (msg[0] & 0x80) {
    if ((msg[0] & 0x7f) !== 0) throw new Error('Непідтримувана версія транзакції');
    version = 0; o = 1;
  }
  need(o, 3);
  const numSigs = msg[o], numReadonlySigned = msg[o + 1], numReadonlyUnsigned = msg[o + 2];
  o += 3;
  let [n, s] = readShortVec(msg, o); o += s;
  if (n > 256) throw new Error('Забагато акаунтів');
  const keys = [];
  for (let i = 0; i < n; i++) { need(o, 32); keys.push(b58encode(msg.subarray(o, o + 32))); o += 32; }
  if (numSigs < 1 || numSigs > keys.length || numReadonlySigned >= numSigs || numReadonlyUnsigned > keys.length - numSigs) throw new Error('Некоректний заголовок транзакції');
  need(o, 32);
  const blockhash = b58encode(msg.subarray(o, o + 32)); o += 32;
  const [ni, si] = readShortVec(msg, o); o += si;
  if (ni > 64) throw new Error('Забагато інструкцій');
  const raw = [];
  for (let i = 0; i < ni; i++) {
    need(o, 1);
    const programIdIndex = msg[o++];
    const [na, sa] = readShortVec(msg, o); o += sa;
    need(o, na);
    const accounts = [...msg.subarray(o, o + na)]; o += na;
    const [nd, sd] = readShortVec(msg, o); o += sd;
    need(o, nd);
    raw.push({ programIdIndex, accounts, data: Buffer.from(msg.subarray(o, o + nd)) }); o += nd;
  }
  const lookups = [];
  if (version === 0) {
    const [nl, sl] = readShortVec(msg, o); o += sl;
    if (nl > 16) throw new Error('Забагато адресних таблиць');
    for (let i = 0; i < nl; i++) {
      need(o, 32);
      const table = b58encode(msg.subarray(o, o + 32)); o += 32;
      const [nw, sw] = readShortVec(msg, o); o += sw; need(o, nw); const writable = [...msg.subarray(o, o + nw)]; o += nw;
      const [nr, sr] = readShortVec(msg, o); o += sr; need(o, nr); const readonly = [...msg.subarray(o, o + nr)]; o += nr;
      lookups.push({ table, writable, readonly });
    }
  }
  if (o !== msg.length) throw new Error('Зайві дані після транзакції');
  const total = keys.length + lookups.reduce((a, l) => a + l.writable.length + l.readonly.length, 0);
  for (const ins of raw) {
    if (ins.programIdIndex >= keys.length) throw new Error('Програма інструкції поза списком акаунтів');
    if (ins.accounts.some(a => a >= total)) throw new Error('Акаунт інструкції поза списком');
  }
  const instructions = raw.map(r => ({ ...r, programId: keys[r.programIdIndex] }));
  return { version, numSigs, numReadonlySigned, numReadonlyUnsigned, keys, blockhash, instructions, lookups, unresolved: total - keys.length };
}

// Повна транзакція: [кількість підписів][підписи 64Б…][повідомлення]
function parseTransaction(wire) {
  wire = Buffer.from(wire);
  if (wire.length < 100 || wire.length > 4096) throw new Error('Некоректний розмір транзакції');
  const [count, sz] = readShortVec(wire, 0);
  const start = sz + count * 64;
  if (count < 1 || start >= wire.length) throw new Error('Некоректні підписи транзакції');
  const message = wire.subarray(start);
  const parsed = parseMessage(message);
  if (parsed.numSigs !== count) throw new Error('Кількість підписів не збігається із заголовком');
  return { wire, sigCount: count, sigOffset: sz, message, parsed };
}

function encodeShortVec(n) {
  const out = [];
  for (;;) { const b = n & 0x7f; n >>= 7; if (n) out.push(b | 0x80); else { out.push(b); break; } }
  return Buffer.from(out);
}

// Транзакція без підписів (для симуляції)
function unsignedWire(message) {
  const p = parseMessage(message);
  return Buffer.concat([encodeShortVec(p.numSigs), Buffer.alloc(64 * p.numSigs), Buffer.from(message)]);
}

// Підписує транзакцію ключем акаунта: потрібен збіг адреси з одним із необхідних підписантів
function signTransaction(secret, address, wire) {
  const tx = parseTransaction(wire);
  const idx = tx.parsed.keys.slice(0, tx.parsed.numSigs).indexOf(address);
  if (idx < 0) throw new Error('Ця транзакція не потребує підпису цього рахунку');
  const signature = sign(secret, tx.message);
  const out = Buffer.from(tx.wire);
  signature.copy(out, tx.sigOffset + idx * 64);
  return { signedWire: out, signature, index: idx };
}


// ---------- адреси, похідні від програми (PDA) і метадані Metaplex ----------
const P_FIELD = (1n << 255n) - 19n;
const modpow = (b, e, m) => { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; };
const D_CURVE = (P_FIELD - 121665n * modpow(121666n, P_FIELD - 2n, P_FIELD) % P_FIELD) % P_FIELD;

// Чи є 32 байти точкою на кривій Ed25519 (PDA мають бути поза кривою: для них не існує приватного ключа)
function isOnCurve(bytes) {
  const b = Buffer.from(bytes);
  if (b.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? b[i] & 0x7f : b[i]);
  y %= P_FIELD;
  const y2 = y * y % P_FIELD;
  const u = (y2 - 1n + P_FIELD) % P_FIELD;
  const v = (D_CURVE * y2 + 1n) % P_FIELD;
  const x2 = u * modpow(v, P_FIELD - 2n, P_FIELD) % P_FIELD;
  if (x2 === 0n) return true;
  return modpow(x2, (P_FIELD - 1n) / 2n, P_FIELD) === 1n; // x² має бути квадратичним лишком
}

function findProgramAddress(seeds, programId) {
  const pid = Buffer.isBuffer(programId) ? programId : b58decode(programId);
  if (seeds.length > 16 || seeds.some(x => Buffer.from(x).length > 32)) throw new Error('Некоректні seed-и PDA');
  for (let bump = 255; bump >= 0; bump--) {
    const h = crypto.createHash('sha256');
    for (const x of seeds) h.update(Buffer.from(x));
    h.update(Buffer.from([bump])).update(pid).update('ProgramDerivedAddress');
    const out = h.digest();
    if (!isOnCurve(out)) return { address: b58encode(out), bump };
  }
  throw new Error('PDA не знайдено');
}

const METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
const metadataPda = (mint) => findProgramAddress([Buffer.from('metadata'), b58decode(METADATA_PROGRAM), b58decode(mint)], METADATA_PROGRAM).address;

// Рахунок метаданих Metaplex (Borsh): key u8, update authority 32, mint 32, name/symbol/uri — рядки з префіксом довжини u32
function parseMetadata(data) {
  try {
    const b = Buffer.from(data);
    if (b.length < 70 || b[0] !== 4) return null;
    let o = 65;
    const str = (max) => {
      const n = b.readUInt32LE(o); o += 4;
      if (n > max || o + n > b.length) throw new Error('bad');
      const t = b.subarray(o, o + n).toString('utf8').replace(/\u0000/g, '').trim(); o += n;
      return t;
    };
    const name = str(64), symbol = str(32), uri = str(300);
    // рядки задає творець токена: прибираємо невидимі й керівні символи (підміна напрямку тексту, нульова ширина)
    const cleanText = (t) => sanitize(t).text.replace(/[\u0000-\u001f]/g, ' ').trim();
    return { mint: b58encode(b.subarray(33, 65)), name: cleanText(name), symbol: cleanText(symbol), uri: sanitize(uri).text.replace(/[\u0000-\u001f\s]/g, '') };
  } catch { return null; }
}


// ---------- побудова переказу SOL ----------
// Сума у форматі «1.5» → лампорти (BigInt); не більше 9 знаків після коми, більше нуля
function parseSol(text) {
  if (typeof text !== 'string' || !/^\d{1,12}(\.\d{1,9})?$/.test(text)) throw new Error('Некоректна сума.');
  const [whole, frac = ''] = text.split('.');
  const lamports = BigInt(whole) * 1_000_000_000n + BigInt(frac.padEnd(9, '0'));
  if (lamports <= 0n) throw new Error('Сума має бути більшою за нуль.');
  return lamports;
}

// Кількість токенів «12.5» → мінімальні одиниці з урахуванням decimals (BigInt, без похибок); не більше u64
function parseUnits(text, decimals) {
  decimals = Number(decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) throw new Error('Некоректна кількість знаків токена.');
  const re = decimals === 0 ? /^\d{1,30}$/ : new RegExp(String.raw`^\d{1,30}(\.\d{1,${decimals}})?$`);
  if (typeof text !== 'string' || !re.test(text)) throw new Error('Некоректна сума.');
  const [whole, frac = ''] = text.split('.');
  const v = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0'));
  if (v <= 0n) throw new Error('Сума має бути більшою за нуль.');
  if (v > 0xffffffffffffffffn) throw new Error('Сума завелика.');
  return v;
}

// ---------- універсальний будівник legacy-повідомлень та інструкції ----------
// instructions: [{ programId, keys: [{ pubkey, isSigner, isWritable }], data }]. Акаунти впорядковуються за правилами Solana:
// підписанти з записом, підписанти лише для читання, решта з записом, решта лише для читання (платник комісії — перший).
function compileMessage({ feePayer, instructions, blockhash }) {
  const meta = new Map();
  const touch = (pubkey, signer, writable) => {
    const m = meta.get(pubkey) || { signer: false, writable: false };
    meta.set(pubkey, { signer: m.signer || signer, writable: m.writable || writable });
  };
  touch(feePayer, true, true);
  for (const ins of instructions) {
    for (const k of ins.keys) touch(k.pubkey, !!k.isSigner, !!k.isWritable);
    touch(ins.programId, false, false);
  }
  const all = [...meta.entries()].map(([pubkey, m], order) => ({ pubkey, ...m, order }));
  const rank = (m) => (m.signer ? (m.writable ? 0 : 1) : (m.writable ? 2 : 3));
  all.sort((x, y) => rank(x) - rank(y) || x.order - y.order);
  if (all[0].pubkey !== feePayer) throw new Error('Платник комісії має бути першим');
  const bh = b58decode(blockhash);
  if (bh.length !== 32) throw new Error('Некоректний blockhash');
  if (all.length > 64) throw new Error('Забагато акаунтів');
  const index = new Map(all.map((m, i) => [m.pubkey, i]));
  const numSigners = all.filter(m => m.signer).length;
  const numReadonlySigned = all.filter(m => m.signer && !m.writable).length;
  const numReadonlyUnsigned = all.filter(m => !m.signer && !m.writable).length;
  const parts = [Buffer.from([numSigners, numReadonlySigned, numReadonlyUnsigned]), encodeShortVec(all.length), ...all.map(m => b58decode(m.pubkey)), bh, encodeShortVec(instructions.length)];
  for (const ins of instructions) {
    const data = Buffer.from(ins.data);
    parts.push(Buffer.from([index.get(ins.programId)]), encodeShortVec(ins.keys.length), Buffer.from(ins.keys.map(k => index.get(k.pubkey))), encodeShortVec(data.length), data);
  }
  return Buffer.concat(parts);
}

const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const ixSystemTransfer = (from, to, lamports) => ({ programId: P.SYSTEM, keys: [{ pubkey: from, isSigner: true, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }], data: Buffer.concat([Buffer.from([2, 0, 0, 0]), u64(lamports)]) });
const ixSystemCreateAccount = ({ from, newAccount, lamports, space, programId }) => ({
  programId: P.SYSTEM,
  keys: [
    { pubkey: from, isSigner: true, isWritable: true },
    { pubkey: newAccount, isSigner: true, isWritable: true },
  ],
  data: Buffer.concat([u32(0), u64(lamports), u64(space), b58decode(programId)]),
});
// Бюджет обчислень (програма ComputeBudget): ліміт одиниць (tag 2) і ціна одиниці в мікро-лампортах (tag 3, пріоритетна комісія)
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const ixSetComputeUnitLimit = (units) => ({ programId: 'ComputeBudget111111111111111111111111111111', keys: [], data: Buffer.concat([Buffer.from([2]), u32(units)]) });
const ixSetComputeUnitPrice = (microLamports) => ({ programId: 'ComputeBudget111111111111111111111111111111', keys: [], data: Buffer.concat([Buffer.from([3]), u64(microLamports)]) });
// Домени .sol (Solana Name Service): акаунт імені — PDA за хешем «SPL Name Service»+назва у програмі імен із батьківським акаунтом .sol
const NAME_PROGRAM = 'namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX';
const SOL_TLD = '58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx';
const snsAccount = (label) => findProgramAddress([crypto.createHash('sha256').update('SPL Name Service' + label).digest(), Buffer.alloc(32), b58decode(SOL_TLD)], NAME_PROGRAM).address;
// Розбір акаунта імені: [батьківський акаунт 32][власник 32][клас 32]…
function parseNameAccount(data) {
  if (!Buffer.isBuffer(data) || data.length < 96) return null;
  return { parent: b58encode(data.subarray(0, 32)), owner: b58encode(data.subarray(32, 64)) };
}

// TransferChecked (tag 12): [джерело, mint, одержувач, власник]; decimals перевіряє сама програма
const ixTransferChecked = ({ source, mint, dest, owner, amount, decimals, programId = P.TOKEN }) => ({
  programId, keys: [{ pubkey: source, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: dest, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }],
  data: Buffer.concat([Buffer.from([12]), u64(amount), Buffer.from([decimals])]),
});
// Асоційований токен-акаунт: PDA за [власник, програма токенів, mint] у програмі ATA
const ataAddress = (owner, mint, tokenProgram = P.TOKEN) => findProgramAddress([b58decode(owner), b58decode(tokenProgram), b58decode(mint)], P.ATA).address;
// CreateIdempotent (tag 1): не завершується помилкою, якщо акаунт уже існує
const ixCreateAtaIdempotent = ({ payer, owner, mint, tokenProgram = P.TOKEN }) => ({
  programId: P.ATA,
  keys: [{ pubkey: payer, isSigner: true, isWritable: true }, { pubkey: ataAddress(owner, mint, tokenProgram), isSigner: false, isWritable: true }, { pubkey: owner, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: P.SYSTEM, isSigner: false, isWritable: false }, { pubkey: tokenProgram, isSigner: false, isWritable: false }],
  data: Buffer.from([1]),
});

// Інструкції Stake Program (створення, делегування, деактивація, виведення)
const SYSVAR_RENT = 'SysvarRent111111111111111111111111111111111';
const SYSVAR_CLOCK = 'SysvarC1ock11111111111111111111111111111111';
const SYSVAR_STAKE_HISTORY = 'SysvarStakeHistory1111111111111111111111111';
const STAKE_CONFIG = 'StakeConfig11111111111111111111111111111111';

const ixStakeInitialize = ({ stakeAccount, staker, withdrawer }) => ({
  programId: P.STAKE,
  keys: [
    { pubkey: stakeAccount, isSigner: false, isWritable: true },
    { pubkey: SYSVAR_RENT, isSigner: false, isWritable: false },
  ],
  data: Buffer.concat([u32(0), b58decode(staker), b58decode(withdrawer), Buffer.alloc(48)]),
});

const ixStakeDelegate = ({ stakeAccount, voteAccount, authorizedPubkey }) => ({
  programId: P.STAKE,
  keys: [
    { pubkey: stakeAccount, isSigner: false, isWritable: true },
    { pubkey: voteAccount, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_CLOCK, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_STAKE_HISTORY, isSigner: false, isWritable: false },
    { pubkey: STAKE_CONFIG, isSigner: false, isWritable: false },
    { pubkey: authorizedPubkey, isSigner: true, isWritable: false },
  ],
  data: u32(2),
});

const ixStakeDeactivate = ({ stakeAccount, authorizedPubkey }) => ({
  programId: P.STAKE,
  keys: [
    { pubkey: stakeAccount, isSigner: false, isWritable: true },
    { pubkey: SYSVAR_CLOCK, isSigner: false, isWritable: false },
    { pubkey: authorizedPubkey, isSigner: true, isWritable: false },
  ],
  data: u32(5),
});

const ixStakeWithdraw = ({ stakeAccount, to, authorizedPubkey, lamports }) => ({
  programId: P.STAKE,
  keys: [
    { pubkey: stakeAccount, isSigner: false, isWritable: true },
    { pubkey: to, isSigner: false, isWritable: true },
    { pubkey: SYSVAR_CLOCK, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_STAKE_HISTORY, isSigner: false, isWritable: false },
    { pubkey: authorizedPubkey, isSigner: true, isWritable: false },
  ],
  data: Buffer.concat([u32(4), u64(lamports)]),
});

const ixStakeAuthorize = ({ stakeAccount, authorizedPubkey, newAuthorizedPubkey, stakeAuthorizeType = 0 }) => ({
  programId: P.STAKE,
  keys: [
    { pubkey: stakeAccount, isSigner: false, isWritable: true },
    { pubkey: SYSVAR_CLOCK, isSigner: false, isWritable: false },
    { pubkey: authorizedPubkey, isSigner: true, isWritable: false },
  ],
  data: Buffer.concat([u32(1), b58decode(newAuthorizedPubkey), u32(stakeAuthorizeType)]),
});

// Повідомлення legacy-транзакції: System Program Transfer від from до to
function buildTransferMessage({ from, to, lamports, blockhash }) {
  if (from === to) throw new Error('Не можна надсилати на той самий рахунок.');
  return compileMessage({ feePayer: from, instructions: [ixSystemTransfer(from, to, lamports)], blockhash });
}

// ---------- розшифровка інструкцій ----------
const P = {
  SYSTEM: '11111111111111111111111111111111',
  STAKE: 'Stake11111111111111111111111111111111111111',
  TOKEN: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  TOKEN22: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ATA: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  BUDGET: 'ComputeBudget111111111111111111111111111111',
  MEMO: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  MEMO_OLD: 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
};

const short = (a) => (a && a.length > 12 ? a.slice(0, 4) + '…' + a.slice(-4) : a || '?');

function formatUnits(v, decimals) {
  const s = v.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals), frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return decimals && frac ? `${whole}.${frac}` : whole;
}
const sol = (lamports) => formatUnits(BigInt(lamports), 9);

const AUTHORITY_TYPES = ['право мінтингу', 'право заморожування', 'власник токен-акаунта', 'право закриття токен-акаунта'];

// → { lines: [[назва, значення]], warnings: [], danger: bool, outgoing: BigInt (лампорти зі своїх рахунків) }
function describe(parsed, ours = []) {
  const mine = new Set(ours);
  const lines = [], warnings = [];
  let danger = false, outgoing = 0n, tokensOut = 0;
  const tokenTransfers = []; // токени, що йдуть зі своїх акаунтів: { mint, amount, decimals } (mint = null, якщо інструкція його не вказує)
  const warn = (t, isDanger) => { if (!warnings.includes(t)) warnings.push(t); if (isDanger) danger = true; };
  const key = (ins, i) => parsed.keys[ins.accounts[i]];
  const who = (a) => (mine.has(a) ? `${short(a)} (ваш рахунок)` : a || '?');
  const unknownPrograms = new Set();

  parsed.instructions.forEach((ins) => {
    const d = ins.data;
    const pid = ins.programId;
    const add = (text) => lines.push([`Дія ${lines.filter(l => /^Дія /.test(l[0])).length + 1}`, text]);
    try {
      if (pid === P.SYSTEM) {
        const tag = d.length >= 4 ? d.readUInt32LE(0) : -1;
        if (tag === 2 && d.length >= 12) {
          const amount = d.readBigUInt64LE(4), from = key(ins, 0), to = key(ins, 1);
          add(`Переказ ${sol(amount)} SOL: ${who(from)} → ${who(to)}`);
          if (mine.has(from)) outgoing += amount;
        } else if (tag === 0 && d.length >= 52) {
          add(`Створення акаунта ${short(key(ins, 1))}: ${sol(d.readBigUInt64LE(4))} SOL, власник-програма ${short(b58encode(d.subarray(20, 52)))}`);
          if (mine.has(key(ins, 0))) outgoing += d.readBigUInt64LE(4);
        } else if (tag === 1 || tag === 10) {
          const target = key(ins, 0);
          add(`Зміна власника акаунта ${who(target)} (System Assign)`);
          if (mine.has(target)) warn('Інструкція передає власність над ВАШИМ акаунтом іншій програмі — типовий прийом шахраїв для крадіжки коштів.', true);
        } else if (tag === 8 || tag === 9) {
          add(`Виділення місця в акаунті ${who(key(ins, 0))}`);
        } else if (tag === 11 && d.length >= 12) {
          const amount = d.readBigUInt64LE(4);
          add(`Переказ ${sol(amount)} SOL (TransferWithSeed): ${who(key(ins, 0))} → ${who(key(ins, 2))}`);
          warn('Переказ із похідного акаунта (WithSeed): перевірте суму й отримувача.', false);
          if (mine.has(key(ins, 1))) outgoing += amount; // базовий ключ — ваш, отже акаунт керується вами
        } else if (tag === 3 && d.length >= 44) {
          const seedLen = Number(d.readBigUInt64LE(36));
          if (seedLen > 32 || d.length < 44 + seedLen + 8) throw new Error('bad seed');
          const amount = d.readBigUInt64LE(44 + seedLen);
          add(`Створення акаунта ${short(key(ins, 1))} (CreateAccountWithSeed): ${sol(amount)} SOL`);
          if (mine.has(key(ins, 0))) outgoing += amount;
        } else if (tag === 4) {
          add('Довговічний nonce (AdvanceNonce): транзакція не втрачає чинності');
          warn('Транзакція з довговічним nonce не втрачає чинності: той, хто її отримає, зможе надіслати її в будь-який момент пізніше. Підписуйте лише на довіреному сайті.', !mine.has(key(ins, 2)));
        } else if (tag === 5 || tag === 6 || tag === 7 || tag === 12 || tag === 13) {
          add(`Операція з nonce-акаунтом (System ${tag})`);
        } else add(`System Program: інструкція ${tag}`);
      } else if (pid === P.TOKEN || pid === P.TOKEN22) {
        const t = d[0];
        const prog = pid === P.TOKEN22 ? 'Token-2022' : 'SPL Token';
        const withFee = pid === P.TOKEN22 && t === 26 && d[1] === 1 && d.length >= 19; // TransferCheckedWithFee
        if ((t === 3 && d.length >= 9 && mine.has(key(ins, 2))) || (t === 12 && d.length >= 10 && mine.has(key(ins, 3))) || (withFee && mine.has(key(ins, 3)))) tokensOut++;
        if (t === 3 && d.length >= 9 && mine.has(key(ins, 2))) tokenTransfers.push({ mint: null, amount: d.readBigUInt64LE(1), decimals: null, source: key(ins, 0) });
        else if (t === 12 && d.length >= 10 && mine.has(key(ins, 3))) tokenTransfers.push({ mint: key(ins, 1), amount: d.readBigUInt64LE(1), decimals: d[9] });
        else if (withFee && mine.has(key(ins, 3))) tokenTransfers.push({ mint: key(ins, 1), amount: d.readBigUInt64LE(2), decimals: d[10] });
        if (t === 3 && d.length >= 9) add(`Переказ токенів (${d.readBigUInt64LE(1)} у мінімальних одиницях): ${short(key(ins, 0))} → ${short(key(ins, 1))}, підпис ${who(key(ins, 2))}`);
        else if (t === 12 && d.length >= 10) add(`Переказ токенів ${formatUnits(d.readBigUInt64LE(1), d[9])} (mint ${short(key(ins, 1))}): ${short(key(ins, 0))} → ${short(key(ins, 2))}, підпис ${who(key(ins, 3))}`);
        else if ((t === 4 && d.length >= 9) || (t === 13 && d.length >= 10)) {
          const delegate = key(ins, t === 4 ? 1 : 2);
          add(`Дозвіл ${short(delegate)} витрачати ваші токени (до ${d.readBigUInt64LE(1)} у мінімальних одиницях)`);
          warn('Інструкція дає іншому адресу право витрачати ваші токени без нових підтверджень, доки ви не скасуєте дозвіл (Revoke).', true);
        } else if (t === 5) add('Скасування дозволу на витрату токенів (Revoke)');
        else if (t === 6) {
          const kind = AUTHORITY_TYPES[d[1]] || `тип ${d[1]}`;
          const newAuth = d[2] === 1 && d.length >= 35 ? b58encode(d.subarray(3, 35)) : null;
          add(`Зміна повноважень (${kind}) на ${newAuth ? who(newAuth) : 'нікого'}`);
          warn(`SetAuthority: передає ${kind} токена чи акаунта. Шахраї використовують це, щоб забрати токен-акаунт назавжди. Підтверджуйте, лише якщо повністю розумієте наслідки.`, true);
        } else if (t === 9) {
          add(`Закриття токен-акаунта ${short(key(ins, 0))}, залишок SOL піде на ${who(key(ins, 1))}`);
          if (!mine.has(key(ins, 1))) warn('Токен-акаунт закривається, а SOL надходить НЕ вам.', true);
        } else if (t === 8 || t === 15) add(`Спалення токенів (${prog})`);
        else if (t === 7 || t === 14) add(`Випуск токенів (MintTo, ${prog})`);
        else if (t === 1 || t === 16 || t === 18) add(`Ініціалізація токен-акаунта (${prog})`);
        else if (t === 17) add('Синхронізація wSOL (SyncNative)');
        else if (withFee) add(`Переказ токенів ${formatUnits(d.readBigUInt64LE(2), d[10])} із комісією ${formatUnits(d.readBigUInt64LE(11), d[10])} (mint ${short(key(ins, 1))}): ${short(key(ins, 0))} → ${short(key(ins, 2))}, підпис ${who(key(ins, 3))}`);
        else if (pid === P.TOKEN22 && t === 34 && d[1] === 1) {
          add('Вимкнення CPI Guard для токен-акаунта');
          warn('Інструкція вимикає CPI Guard: захист, що не дає програмам витрачати токени з акаунта без вашого прямого підпису. Підтверджуйте, лише якщо повністю розумієте наслідки.', true);
        } else if (pid === P.TOKEN22 && t === 27) {
          add('Конфіденційна операція з токенами (Token-2022)');
          warn('Конфіденційні операції приховують суми: гаманець не може показати, що саме відбудеться. Підтверджуйте лише на довіреному сайті.', false);
        }
        else add(`${prog}: інструкція ${t}`);
      } else if (pid === P.ATA) {
        add(`Створення токен-акаунта ${short(key(ins, 1))} для ${who(key(ins, 2))} (mint ${short(key(ins, 3))})`);
      } else if (pid === P.BUDGET) {
        if (d[0] === 2 && d.length >= 5) lines.push(['Ліміт обчислень', String(d.readUInt32LE(1))]);
        else if (d[0] === 3 && d.length >= 9) lines.push(['Пріоритетна комісія', `${d.readBigUInt64LE(1)} мікро-лампортів за одиницю`]);
        else lines.push(['Бюджет обчислень', `інструкція ${d[0]}`]);
      } else if (pid === P.MEMO || pid === P.MEMO_OLD) {
        lines.push(['Примітка (Memo)', d.toString('utf8').replace(/[\u0000-\u001f]/g, ' ').slice(0, 200)]);
      } else if (pid === P.STAKE) {
        const tag = d.length >= 4 ? d.readUInt32LE(0) : -1;
        const stakeAuthorize = (stakeAcc, newAuth, authType) => {
          const role = authType === 1 ? 'право виведення коштів (Withdrawer)' : 'керування стейкінгом (Staker)';
          add(`Зміна повноважень стейку ${short(stakeAcc)}: ${role} передається на ${who(newAuth)}`);
          if (authType === 1 && !mine.has(newAuth)) {
            warn('УВАГА: Ця дія передає право виведення коштів зі стейку іншій адресі! Це призведе до повної втрати застейканих SOL.', true);
          }
        };
        if (tag === 0 && d.length >= 68) {
          const stakeAcc = key(ins, 0);
          const withdrawer = b58encode(d.subarray(36, 68));
          add(`Ініціалізація стейк-акаунта ${short(stakeAcc)} (виведення коштів: ${who(withdrawer)})`);
          if (!mine.has(withdrawer)) warn('УВАГА: Ця дія передає право виведення коштів зі стейку іншій адресі! Це призведе до повної втрати застейканих SOL.', true);
        } else if (tag === 9) {
          const withdrawer = key(ins, 3);
          add(`Ініціалізація стейк-акаунта ${short(key(ins, 0))} (виведення коштів: ${who(withdrawer)})`);
          if (!mine.has(withdrawer)) warn('УВАГА: Ця дія передає право виведення коштів зі стейку іншій адресі! Це призведе до повної втрати застейканих SOL.', true);
        } else if (tag === 2) {
          const stakeAcc = key(ins, 0);
          const voteAcc = key(ins, 1);
          add(`Делегування стейку ${short(stakeAcc)} валідатору ${short(voteAcc)}`);
        } else if (tag === 5) {
          const stakeAcc = key(ins, 0);
          add(`Деактивація стейку ${short(stakeAcc)} (початок періоду виходу)`);
        } else if (tag === 4 && d.length >= 12) {
          const amount = d.readBigUInt64LE(4);
          const stakeAcc = key(ins, 0);
          const to = key(ins, 1);
          add(`Виведення ${sol(amount)} SOL зі стейку ${short(stakeAcc)} на ${who(to)}`);
          if (!mine.has(to)) warn('Виведення стейку на чужу адресу: застейкані SOL надійдуть НЕ вам.', true);
        } else if ((tag === 1 || tag === 8) && d.length >= 40) {
          stakeAuthorize(key(ins, 0), b58encode(d.subarray(4, 36)), d.readUInt32LE(36));
        } else if ((tag === 10 || tag === 11) && d.length >= 8) {
          // Checked-варіанти: нова адреса не в даних, а серед акаунтів інструкції (4-й), тип повноваження — у даних
          stakeAuthorize(key(ins, 0), key(ins, 3), d.readUInt32LE(4));
        } else if (tag === 3 && d.length >= 12) {
          const amount = d.readBigUInt64LE(4);
          add(`Розділення стейку ${short(key(ins, 0))}: ${sol(amount)} SOL у новий акаунт ${short(key(ins, 1))}`);
        } else if (tag === 7) {
          add(`Об’єднання стейк-акаунтів ${short(key(ins, 0))} та ${short(key(ins, 1))}`);
        } else {
          add(`Stake Program: інструкція ${tag}`);
        }
      } else {
        unknownPrograms.add(pid);
        add(`Виклик програми ${pid} (${ins.accounts.length} акаунтів, ${d.length} байт даних)`);
      }
    } catch { add(`Не вдалося розшифрувати інструкцію програми ${short(pid)}`); warn('Частину інструкцій розшифрувати не вдалося — підтверджуйте лише на довірених сайтах.', false); }
  });

  if (unknownPrograms.size) warn(`Транзакція викликає невідомі програми (${[...unknownPrograms].map(short).join(', ')}): їхню дію гаманець не може пояснити. Підтверджуйте лише на довіреному сайті.`, false);
  if (parsed.unresolved > 0) warn(`Транзакція використовує адресні таблиці (${parsed.unresolved} акаунтів): частина адрес прихована від попереднього перегляду.`, false);
  if (outgoing > 0n) lines.unshift(['Спишеться з ваших рахунків', `${sol(outgoing)} SOL (без комісії мережі)`]);
  // переказ токенів зі своїх акаунтів виносимо нагору, щоб його не заховали серед інших рядків
  if (tokensOut > 0) lines.unshift(['Токени підуть з ваших акаунтів', `переказів: ${tokensOut} (суми — серед дій нижче)`]);
  return { lines, warnings, danger, outgoing, tokenTransfers };
}

module.exports = {
  b58encode, b58decode, isAddress, parseSol, parseUnits, buildTransferMessage, compileMessage, ixSystemTransfer, ixSystemCreateAccount, ixSetComputeUnitLimit, ixSetComputeUnitPrice, snsAccount, parseNameAccount, NAME_PROGRAM, SOL_TLD, ixTransferChecked, ixCreateAtaIdempotent, ataAddress, u64, isOnCurve, findProgramAddress, metadataPda, parseMetadata, METADATA_PROGRAM, slip10, keypairFromSeed, deriveAccount, SOL_PATHS, sign, verify,
  parseMessage, parseTransaction, unsignedWire, signTransaction, encodeShortVec, describe, formatUnits, sol, short, PROGRAMS: P,
  generateKeypair, ixStakeInitialize, ixStakeDelegate, ixStakeDeactivate, ixStakeWithdraw, ixStakeAuthorize, SYSVAR_RENT, SYSVAR_CLOCK, SYSVAR_STAKE_HISTORY, STAKE_CONFIG,
};
