'use strict';
const jsQR = require('jsqr');
const { encode, capacity } = require('../../src/qr');
const { ok } = require('../lib');

// Малює матрицю в RGBA із «тихою зоною» 4 модулі й масштабом, декодує незалежним декодером jsQR
function decode(qr, scale = 6) {
  const quiet = 4;
  const dim = (qr.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) {
    if (qr.rows[y][x] !== '1') continue;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const i = (((y + quiet) * scale + dy) * dim + (x + quiet) * scale + dx) * 4;
      data[i] = data[i + 1] = data[i + 2] = 0;
    }
  }
  const r = jsQR(data, dim, dim);
  return r ? r.data : null;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

async function qrTests() {
  const addresses = ['0x90F79bf6EB2c4f870365E785982E1f101E93b906', 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', 'bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'ethereum:0x90F79bf6EB2c4f870365E785982E1f101E93b906@1'];
  ok(addresses.every(a => decode(encode(a)) === a), 'qr: адреси гаманців і посилання кодуються й розпізнаються незалежним декодером');
  const sizes = [];
  const failed = [];
  for (let v = 1; v <= 10; v++) {
    // найдовший текст, що вміщується в цю версію, і найкоротший, що потребує саме її
    const max = capacity(v) - 2 - (v >= 10 ? 1 : 0);
    const r = rng(1000 + v);
    for (const len of [max, max - 1, Math.max(1, max - 7)]) {
      const text = Array.from({ length: len }, () => String.fromCharCode(33 + Math.floor(r() * 90))).join('');
      const qr = encode(text);
      sizes.push(qr.version);
      if (decode(qr) !== text) failed.push(`v${v} len ${len} (отримано версію ${qr.version})`);
    }
  }
  ok(failed.length === 0 && new Set(sizes).size === 10, 'qr: версії 1–10 (усі розміри, блоки корекції, вирівнювальні візерунки, інформація про версію) кодуються й декодуються без втрат', failed);
  const rr = rng(77);
  let bad = 0;
  for (let i = 0; i < 120; i++) {
    const text = Array.from({ length: 1 + Math.floor(rr() * 150) }, () => String.fromCharCode(32 + Math.floor(rr() * 95))).join('');
    if (decode(encode(text)) !== text) bad++;
  }
  ok(bad === 0, 'qr: 120 випадкових текстів довжиною до 150 символів — круговий тест без втрат');
  ok(decode(encode('Привіт, гаманцю! \u{1F510}')) === 'Привіт, гаманцю! \u{1F510}', 'qr: UTF-8 (кирилиця, емодзі) кодується як байти');
  let tooBig = false; try { encode('x'.repeat(300)); } catch { tooBig = true; }
  ok(tooBig && encode('a').version === 1 && encode('a').size === 21, 'qr: завеликий текст відхиляється; найменша версія 1 має розмір 21×21');
  const q = encode(addresses[0]);
  ok(q.rows.length === q.size && q.rows.every(r => r.length === q.size && /^[01]+$/.test(r)), 'qr: матриця квадратна, лише 0 і 1');
}

module.exports = { qrTests };
