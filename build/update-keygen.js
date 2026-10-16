'use strict';
// Генерує пару ключів Ed25519 для підпису оновлень.
//  * приватний ключ  -> build/keys/update-private.pem  (НЕ публікувати, зробити резервну копію!)
//  * публічний ключ  -> src/update-key.js              (вбудовується в браузер)
// Повторний запуск НЕ перезаписує наявні ключі: зміна ключа зламає автооновлення вже встановлених копій.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const priv = path.join(__dirname, 'keys', 'update-private.pem');
const pubJs = path.join(__dirname, '..', 'src', 'update-key.js');

if (fs.existsSync(priv) || fs.existsSync(pubJs)) {
  console.log('Ключі вже існують — нічого не змінено. (Щоб замінити ключ, видаліть обидва файли вручну, пам\u2019ятаючи про наслідки.)');
  process.exit(0);
}
fs.mkdirSync(path.dirname(priv), { recursive: true });
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const pem = publicKey.export({ type: 'spki', format: 'pem' });
fs.writeFileSync(pubJs, `'use strict';\n// Публічний ключ для перевірки підписів оновлень (приватний ключ зберігається окремо і не потрапляє в збірку).\nmodule.exports = ${JSON.stringify(pem)};\n`);
const fp = crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
console.log('Ключі створено. Відбиток публічного ключа:', fp);
console.log('ВАЖЛИВО: збережіть копію', priv, 'у надійному місці — без нього неможливо випускати оновлення.');
