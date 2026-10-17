'use strict';
// Підпис оновлень Ed25519: випускач підписує «версія + SHA-512 інсталятора», браузер перевіряє підпис вбудованим публічним ключем.
// Навіть якщо зловмисник підмінить сервер, latest.yml і сам файл, без приватного ключа він не створить дійсний підпис.
const crypto = require('crypto');
const fs = require('fs');

const PREFIX = 'w3ir-update-v1';
const message = (version, sha512) => Buffer.from(`${PREFIX}\n${version}\n${sha512}`, 'utf8');

function sign(privatePem, version, sha512) {
  return crypto.sign(null, message(version, sha512), crypto.createPrivateKey(privatePem)).toString('base64');
}

function verify(publicPem, version, sha512, signatureB64) {
  try {
    if (typeof signatureB64 !== 'string' || signatureB64.length > 200) return false;
    const keys = Array.isArray(publicPem) ? publicPem : [publicPem];
    for (const key of keys) {
      if (!key) continue;
      try {
        if (crypto.verify(null, message(version, sha512), crypto.createPublicKey(key), Buffer.from(signatureB64, 'base64'))) return true;
      } catch { /* спробувати наступний ключ */ }
    }
    return false;
  } catch { return false; }
}

function sha512File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha512');
    fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('base64'))).on('error', reject);
  });
}

// Повертає null, якщо файл відповідає підписаній версії; інакше — текст причини
async function verifyFile({ publicPem, version, signature, file }) {
  if (!signature) return 'Оновлення не містить підпису випускача.';
  if (!/^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(String(version))) return 'Некоректний номер версії.';
  let actual;
  try { actual = await sha512File(file); } catch { return 'Не вдалося прочитати завантажений файл.'; }
  if (!verify(publicPem, version, actual, signature)) return 'Підпис оновлення недійсний — файл не від випускача або змінений.';
  return null;
}

function fingerprint(publicPem) {
  try {
    const key = Array.isArray(publicPem) ? publicPem[0] : publicPem;
    return crypto.createHash('sha256').update(crypto.createPublicKey(key).export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
  } catch { return ''; }
}

module.exports = { sign, verify, verifyFile, sha512File, fingerprint, message };
