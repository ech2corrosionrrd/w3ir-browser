'use strict';
// Генератор QR-кодів без залежностей (ISO/IEC 18004): режим «байти», корекція помилок рівня M, версії 1–10 (до 213 байтів),
// вибір найкращої маски за штрафами. Призначений для адрес гаманця й коротких посилань.
// Коректність перевіряється круговими тестами з незалежним декодером (jsQR, лише в devDependencies).

// Кодові слова даних і корекції на блок для рівня M: [блоків групи 1, даних на блок, блоків групи 2, даних на блок, корекції на блок]
const BLOCKS_M = {
  1: [1, 16, 0, 0, 10], 2: [1, 28, 0, 0, 16], 3: [1, 44, 0, 0, 26], 4: [2, 32, 0, 0, 18], 5: [2, 43, 0, 0, 24],
  6: [4, 27, 0, 0, 16], 7: [4, 31, 0, 0, 18], 8: [2, 38, 2, 39, 22], 9: [3, 36, 2, 37, 22], 10: [4, 43, 1, 44, 26],
};
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

// ---------- поле Галуа GF(256), поліном 0x11D ----------
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11D; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) { next[j] ^= poly[j]; next[j + 1] ^= gmul(poly[j], EXP[i]); }
    poly = next;
  }
  return poly;
}
function rsRemainder(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const rem = new Array(ecLen).fill(0);
  for (const b of data) {
    const factor = b ^ rem.shift();
    rem.push(0);
    for (let i = 0; i < ecLen; i++) rem[i] ^= gmul(gen[i + 1], factor);
  }
  return rem;
}

const capacity = (v) => { const [g1, d1, g2, d2] = BLOCKS_M[v]; return g1 * d1 + g2 * d2; };

// ---------- кодові слова ----------
function encodeData(bytes, version) {
  const bits = [];
  const put = (value, len) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const total = capacity(version) * 8;
  put(0, Math.min(4, total - bits.length));
  while (bits.length % 8) bits.push(0);
  const words = [];
  for (let i = 0; i < bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0; words.length < capacity(version); pad++) words.push(pad % 2 ? 0x11 : 0xEC);
  return words;
}

function interleave(words, version) {
  const [g1, d1, g2, d2, ec] = BLOCKS_M[version];
  const blocks = [];
  let pos = 0;
  for (let i = 0; i < g1 + g2; i++) {
    const len = i < g1 ? d1 : d2;
    const data = words.slice(pos, pos + len);
    pos += len;
    blocks.push({ data, ec: rsRemainder(data, ec) });
  }
  const out = [];
  for (let i = 0; i < Math.max(d1, d2); i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

// ---------- матриця ----------
function bchFormat(data) { // 5 біт даних → 15 біт із кодом BCH і маскою
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  return ((data << 10) | rem) ^ 0x5412;
}
function bchVersion(version) {
  let rem = version << 12;
  for (let i = 17; i >= 12; i--) if ((rem >>> i) & 1) rem ^= 0x1F25 << (i - 12);
  return (version << 12) | rem;
}

function build(version, words, mask) {
  const n = 17 + 4 * version;
  const m = Array.from({ length: n }, () => new Array(n).fill(false));
  const fn = Array.from({ length: n }, () => new Array(n).fill(false)); // службові модулі (не дані)
  const set = (x, y, v) => { if (x >= 0 && y >= 0 && x < n && y < n) { m[y][x] = v; fn[y][x] = true; } };
  const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const d = Math.max(Math.abs(dx), Math.abs(dy)); set(cx + dx, cy + dy, d !== 2 && d !== 4); } };
  finder(3, 3); finder(n - 4, 3); finder(3, n - 4);
  for (let i = 8; i < n - 8; i++) { set(i, 6, i % 2 === 0); set(6, i, i % 2 === 0); }
  const al = ALIGN[version];
  for (const cy of al) for (const cx of al) {
    if ((cx === 6 && cy === 6) || (cx === 6 && cy === n - 7) || (cx === n - 7 && cy === 6)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  set(8, n - 8, true); // «темний модуль»
  // резервуємо області формату (значення — нижче)
  for (let i = 0; i < 9; i++) { set(8, i, false); set(i, 8, false); }
  for (let i = 0; i < 8; i++) { set(n - 1 - i, 8, false); set(8, n - 1 - i, false); }
  set(8, n - 8, true);
  if (version >= 7) for (let i = 0; i < 18; i++) { set(Math.floor(i / 3), n - 11 + (i % 3), false); set(n - 11 + (i % 3), Math.floor(i / 3), false); }

  // дані: змійкою з правого нижнього кута по два стовпчики
  const bits = [];
  for (const w of words) for (let i = 7; i >= 0; i--) bits.push((w >>> i) & 1);
  const masks = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0, (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];
  let k = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < n; v++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? n - 1 - v : v;
        if (fn[y][x]) continue;
        const bit = k < bits.length ? bits[k++] === 1 : false;
        m[y][x] = bit !== masks[mask](x, y);
      }
    }
  }
  // формат (рівень M = 00) і версія
  const fmt = bchFormat((0b00 << 3) | mask);
  for (let i = 0; i < 15; i++) {
    const bit = ((fmt >>> i) & 1) === 1;
    if (i < 6) m[i][8] = bit; else if (i < 8) m[i + 1][8] = bit; else m[n - 15 + i][8] = bit;
    if (i < 8) m[8][n - 1 - i] = bit; else if (i < 9) m[8][15 - i] = bit; else m[8][15 - i - 1] = bit;
  }
  m[n - 8][8] = true;
  if (version >= 7) {
    const vi = bchVersion(version);
    for (let i = 0; i < 18; i++) { const bit = ((vi >>> i) & 1) === 1; m[n - 11 + (i % 3)][Math.floor(i / 3)] = bit; m[Math.floor(i / 3)][n - 11 + (i % 3)] = bit; }
  }
  return m;
}

function penalty(m) {
  const n = m.length;
  let score = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < n; a++) {
      let run = 1;
      for (let b = 1; b < n; b++) {
        const cur = pass ? m[b][a] : m[a][b], prev = pass ? m[b - 1][a] : m[a][b - 1];
        if (cur === prev) { run++; if (run === 5) score += 3; else if (run > 5) score++; } else run = 1;
      }
    }
  }
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
  const pat = [true, false, true, true, true, false, true];
  const hit = (get) => { for (let i = 0; i + 6 < n; i++) if (pat.every((v, j) => get(i + j) === v)) { const before = [i - 4, i - 3, i - 2, i - 1].every(q => q >= 0 && !get(q)); const after = [i + 7, i + 8, i + 9, i + 10].every(q => q < n && !get(q)); if (before || after) return true; } return false; };
  for (let a = 0; a < n; a++) { if (hit((q) => m[a][q])) score += 40; if (hit((q) => m[q][a])) score += 40; }
  let dark = 0;
  for (const row of m) for (const c of row) if (c) dark++;
  score += Math.floor(Math.abs(dark * 100 / (n * n) - 50) / 5) * 10;
  return score;
}

// → { size, rows: ['1010…', …] } (1 = темний модуль), без «тихої зони»
function encode(text) {
  const bytes = Buffer.from(String(text), 'utf8');
  let version = 0;
  for (let v = 1; v <= 10; v++) if (bytes.length + 2 + (v >= 10 ? 1 : 0) <= capacity(v)) { version = v; break; }
  if (!version) throw new Error('Текст завеликий для QR-коду (до 213 байтів).');
  const words = interleave(encodeData(bytes, version), version);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = build(version, words, mask);
    const p = penalty(m);
    if (!best || p < best.p) best = { p, m, mask };
  }
  return { version, mask: best.mask, size: best.m.length, rows: best.m.map(r => r.map(c => (c ? '1' : '0')).join('')) };
}

module.exports = { encode, capacity };
