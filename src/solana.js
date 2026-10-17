'use strict';
// Solana без сторонніх бібліотек: base58, ключі Ed25519 за SLIP-0010 (m/44'/501'/N'/0', як у Phantom/Solflare),
// розбір і підпис транзакцій (legacy та v0), розшифровка інструкцій з попередженнями про шахрайські шаблони.
// Лише чиста логіка (без мережі й сховища) — вона повністю покрита тестами.
const crypto = require('crypto');

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

// Рахунок №index: m/44'/501'/index'/0' (перший рахунок збігається з Phantom/Solflare для тієї самої фрази)
function deriveAccount(bip39Seed, index) {
  return keypairFromSeed(slip10(bip39Seed, [44, 501, index, 0]));
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

// ---------- розшифровка інструкцій ----------
const P = {
  SYSTEM: '11111111111111111111111111111111',
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
  let danger = false, outgoing = 0n;
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
          add(`Переказ SOL (TransferWithSeed): ${who(key(ins, 0))} → ${who(key(ins, 2))}`);
          warn('Переказ із похідного акаунта (WithSeed): перевірте суму й отримувача.', false);
        } else if (tag === 4 || tag === 5 || tag === 6 || tag === 7 || tag === 12 || tag === 13) {
          add(`Операція з nonce-акаунтом (System ${tag})`);
        } else add(`System Program: інструкція ${tag}`);
      } else if (pid === P.TOKEN || pid === P.TOKEN22) {
        const t = d[0];
        const prog = pid === P.TOKEN22 ? 'Token-2022' : 'SPL Token';
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
        else add(`${prog}: інструкція ${t}`);
      } else if (pid === P.ATA) {
        add(`Створення токен-акаунта ${short(key(ins, 1))} для ${who(key(ins, 2))} (mint ${short(key(ins, 3))})`);
      } else if (pid === P.BUDGET) {
        if (d[0] === 2 && d.length >= 5) lines.push(['Ліміт обчислень', String(d.readUInt32LE(1))]);
        else if (d[0] === 3 && d.length >= 9) lines.push(['Пріоритетна комісія', `${d.readBigUInt64LE(1)} мікро-лампортів за одиницю`]);
        else lines.push(['Бюджет обчислень', `інструкція ${d[0]}`]);
      } else if (pid === P.MEMO || pid === P.MEMO_OLD) {
        lines.push(['Примітка (Memo)', d.toString('utf8').replace(/[\u0000-\u001f]/g, ' ').slice(0, 200)]);
      } else {
        unknownPrograms.add(pid);
        add(`Виклик програми ${pid} (${ins.accounts.length} акаунтів, ${d.length} байт даних)`);
      }
    } catch { add(`Не вдалося розшифрувати інструкцію програми ${short(pid)}`); warn('Частину інструкцій розшифрувати не вдалося — підтверджуйте лише на довірених сайтах.', false); }
  });

  if (unknownPrograms.size) warn(`Транзакція викликає невідомі програми (${[...unknownPrograms].map(short).join(', ')}): їхню дію гаманець не може пояснити. Підтверджуйте лише на довіреному сайті.`, false);
  if (parsed.unresolved > 0) warn(`Транзакція використовує адресні таблиці (${parsed.unresolved} акаунтів): частина адрес прихована від попереднього перегляду.`, false);
  if (outgoing > 0n) lines.unshift(['Спишеться з ваших рахунків', `${sol(outgoing)} SOL (без комісії мережі)`]);
  return { lines, warnings, danger, outgoing };
}

module.exports = {
  b58encode, b58decode, isAddress, slip10, keypairFromSeed, deriveAccount, sign, verify,
  parseMessage, parseTransaction, unsignedWire, signTransaction, encodeShortVec, describe, formatUnits, sol, short, PROGRAMS: P,
};
