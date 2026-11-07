'use strict';
// Адреса для пожертв: коректна адреса Solana, однакова в коді та в обох README (захист від підміни одного рядка).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DONATE, info } = require(path.join(__dirname, '..', '..', 'src', 'support.js'));

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const decode58 = (s) => {
  let n = 0n;
  for (const c of s) { const i = ALPHABET.indexOf(c); assert.ok(i >= 0, 'символ поза base58: ' + c); n = n * 58n + BigInt(i); }
  let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex;
  return Buffer.from(hex, 'hex');
};

test('адреса пожертв — коректна адреса Solana (32 байти)', () => {
  assert.equal(decode58(DONATE.address).length, 32);
  assert.equal(DONATE.chain, 'Solana');
});

test('адреса однакова в коді, README.md і docs/README-uk.md', () => {
  for (const f of ['README.md', 'docs/README-uk.md']) {
    const text = fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
    assert.ok(text.includes(DONATE.address), f + ': адреса пожертв не збігається');
    const others = (text.match(/\b[1-9A-HJ-NP-Za-km-z]{43,44}\b/g) || []).filter(a => a !== DONATE.address);
    assert.deepEqual(others, [], f + ': у файлі є інша схожа на адресу рядок');
  }
});

test('info() повертає QR адреси', () => {
  const r = info();
  assert.equal(r.ok, true);
  assert.equal(r.address, DONATE.address);
  assert.ok(r.qr && r.qr.size > 20 && r.qr.rows.length === r.qr.size);
});
