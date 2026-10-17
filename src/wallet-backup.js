'use strict';
// Зашифрована резервна копія гаманця (файл, який користувач сам зберігає). Окремий пароль резервної копії (не майстер-пароль):
// scrypt (N=2^17, r=8, p=1) → AES-256-GCM, заголовок входить в автентифікацію. Без пароля вміст не прочитати.
const crypto = require('crypto');

const MAGIC = Buffer.from('W3IRBK1\n', 'latin1');
const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const MIN_PASSWORD = 12;
const MAX_FILE = 1024 * 1024;

const kdf = (password, salt) => crypto.scryptSync(String(password).normalize('NFKC'), salt, 32, SCRYPT);

function encryptBackup(obj, password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new Error(`Пароль резервної копії має містити щонайменше ${MIN_PASSWORD} символів.`);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', kdf(password, salt), iv);
  c.setAAD(MAGIC);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), ct]);
}

function decryptBackup(buf, password) {
  if (!Buffer.isBuffer(buf) || buf.length < MAGIC.length + 16 + 12 + 16 + 2 || buf.length > MAX_FILE || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Це не файл резервної копії W3IR.');
  if (typeof password !== 'string' || !password) throw new Error('Вкажіть пароль резервної копії.');
  let o = MAGIC.length;
  const salt = buf.subarray(o, o += 16), iv = buf.subarray(o, o += 12), tag = buf.subarray(o, o += 16), ct = buf.subarray(o);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', kdf(password, salt), iv);
    d.setAAD(MAGIC);
    d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
  } catch { throw new Error('Хибний пароль або файл пошкоджено.'); }
}

module.exports = { encryptBackup, decryptBackup, MIN_PASSWORD, MAX_FILE };
