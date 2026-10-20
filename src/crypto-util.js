// @ts-check
'use strict';
// Спільні криптопримітиви: scrypt (KDF) + AES-256-GCM.
const crypto = require('crypto');

/**
 * @typedef {Object} KdfParams
 * @property {number} n
 * @property {number} r
 * @property {number} p
 */

const KDF_DEFAULT = { n: 1 << 17, r: 8, p: 1 };
const MAXMEM = 512 * 1024 * 1024;

function validKdf(k) {
  return k && Number.isInteger(k.n) && k.n >= (1 << 14) && k.n <= (1 << 20) && (k.n & (k.n - 1)) === 0
    && Number.isInteger(k.r) && k.r >= 1 && k.r <= 16 && Number.isInteger(k.p) && k.p >= 1 && k.p <= 4;
}

function deriveKey(secret, salt, kdf = KDF_DEFAULT) {
  if (!validKdf(kdf)) return Promise.reject(new Error('bad kdf params'));
  return new Promise((resolve, reject) => {
    crypto.scrypt(secret, salt, 32, { N: kdf.n, r: kdf.r, p: kdf.p, maxmem: MAXMEM }, (e, k) => (e ? reject(e) : resolve(k)));
  });
}

function encrypt(key, plaintext, aad) {
  const iv = crypto.randomBytes(12); // новий випадковий IV для кожного шифрування
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { iv, tag: c.getAuthTag(), ct };
}

function decrypt(key, { iv, tag, ct }, aad) {
  if (iv.length !== 12 || tag.length !== 16) throw new Error('bad envelope');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]); // кидає помилку, якщо дані змінено або ключ хибний
}

const b64 = (b) => Buffer.from(b).toString('base64');
const unb64 = (s) => Buffer.from(String(s), 'base64');
const norm = (s) => Buffer.from(String(s).normalize('NFKC'), 'utf8');
// Атомарний запис: тимчасовий файл → fsync → (за потреби) резервна копія попередньої версії → rename.
// backup: true зберігає попередній вміст як <файл>.bak (для сховища паролів: пошкодження основного файлу не знищує паролі)
const writeAtomic = (fs, file, data, { backup = false } = {}) => {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (backup) { try { if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak'); } catch { /* резервна копія не критична */ } }
  fs.renameSync(tmp, file);
};

module.exports = { KDF_DEFAULT, validKdf, deriveKey, encrypt, decrypt, b64, unb64, norm, writeAtomic };
