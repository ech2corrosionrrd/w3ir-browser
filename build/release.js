'use strict';
// Підготовка релізу: бере збірку з dist/, додає підпис випускача в latest.yml і кладе готові файли в dist/release/.
//   node build/release.js                     — лише підготувати dist/release
//   node build/release.js --github owner/repo — додатково створити GitHub Release (потрібен gh CLI з авторизацією)
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { sign, verify, sha512File, fingerprint } = require('../src/update-verify');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const out = path.join(dist, 'release');
const keyFile = path.join(__dirname, 'keys', 'update-private.pem');
const publicPem = require('../src/update-key');

const fail = (m) => { console.error('ПОМИЛКА:', m); process.exit(1); };

const version = require('../package.json').version;
if (!fs.existsSync(keyFile)) fail('Немає приватного ключа підпису (build/keys/update-private.pem). Запустіть: npm run keygen');
const latestFile = path.join(dist, 'latest.yml');
if (!fs.existsSync(latestFile)) fail('dist/latest.yml не знайдено. Спершу виконайте збірку: npm run dist');

const info = yaml.load(fs.readFileSync(latestFile, 'utf8'));
if (info.version !== version) fail(`Версія в latest.yml (${info.version}) не збігається з package.json (${version}). Перезберіть: npm run dist`);
const entry = (info.files || []).find(f => /\.exe$/i.test(f.url));
if (!entry) fail('У latest.yml немає .exe');
const installer = path.join(dist, entry.url);
if (!fs.existsSync(installer)) fail('Не знайдено інсталятор ' + installer);

(async () => {
  const actual = await sha512File(installer);
  if (actual !== entry.sha512) fail('SHA-512 інсталятора не збігається з latest.yml — збірку змінено після створення.');
  const signature = sign(fs.readFileSync(keyFile, 'utf8'), version, actual);
  if (!verify(publicPem, version, actual, signature)) fail('Підпис не перевіряється вбудованим публічним ключем: приватний ключ не відповідає src/update-key.js.');
  info.w3irSignature = signature;
  info.w3irKeyId = fingerprint(publicPem);

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'latest.yml'), yaml.dump(info, { lineWidth: -1 }));
  fs.copyFileSync(installer, path.join(out, entry.url));
  const blockmap = installer + '.blockmap';
  if (fs.existsSync(blockmap)) fs.copyFileSync(blockmap, path.join(out, entry.url + '.blockmap'));
  const portable = fs.readdirSync(dist).find(f => /portable|^W3IR-Browser-\d.*\.exe$/i.test(f) && f !== entry.url);
  if (portable) fs.copyFileSync(path.join(dist, portable), path.join(out, portable));

  console.log(`Реліз ${version} підписано (ключ ${info.w3irKeyId}).`);
  console.log('Файли для публікації:', out);
  fs.readdirSync(out).forEach(f => console.log('  ', f));

  const gi = process.argv.indexOf('--github');
  if (gi > 0) {
    const repo = process.argv[gi + 1];
    const { publishDraft } = require('./publish-github');
    try {
      const url = await publishDraft({
        repo, tag: 'v' + version, dir: out, title: 'W3IR Browser ' + version,
        notes: `Автоматичне оновлення ${version}. Підпис випускача: ${info.w3irKeyId}.`,
      });
      console.log('GitHub Release опубліковано:', url);
    } catch (e) { fail(e.message); }
  } else {
    console.log('\nЗавантажте ці файли на ваш HTTPS-хостинг (або створіть GitHub Release) і вкажіть джерело в Налаштування → Оновлення.');
  }
})();
