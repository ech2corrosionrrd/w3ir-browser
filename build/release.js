'use strict';
// Підготовка релізу: бере збірку з dist/, додає підпис випускача в latest.yml і кладе готові файли в dist/release/.
//   node build/release.js                     — лише підготувати dist/release
//   node build/release.js --github owner/repo — додатково створити GitHub Release (потрібен gh CLI з авторизацією)
//   node build/release.js --from-ci ...       — замість локальної збірки взяти артефакт workflow «Build» для поточного коміту (див. docs/RELEASING.md)
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

// Артефакт збірки GitHub Actions для ПОТОЧНОГО коміту (збірка й комміт мають збігатися), у dist/
function fetchCiBuild(repo) {
  const { execFileSync } = require('child_process');
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8' }).trim();
  if (run('git', ['status', '--porcelain'])) fail('Є незакомічені зміни: збірку CI порівнюють із закоміченим кодом.');
  const sha = run('git', ['rev-parse', 'HEAD']);
  if (run('git', ['branch', '-r', '--contains', sha]) === '') fail('Поточний коміт не запушено: спершу git push, потім запустіть workflow «Build».');
  const runs = JSON.parse(run('gh', ['run', 'list', '--repo', repo, '--workflow', 'build.yml', '--json', 'databaseId,headSha,conclusion,status', '--limit', '30']));
  const ok = runs.find(r => r.headSha === sha && r.conclusion === 'success');
  if (!ok) fail(`Немає успішної збірки CI для коміту ${sha.slice(0, 7)}. Запустіть: gh workflow run build.yml --repo ${repo} (потім зачекайте завершення).`);
  fs.rmSync(dist, { recursive: true, force: true });
  run('gh', ['run', 'download', String(ok.databaseId), '--repo', repo, '--name', 'dist', '--dir', dist]);
  const sums = fs.readFileSync(path.join(dist, 'SHA256SUMS.txt'), 'utf8');
  const crypto = require('crypto');
  for (const line of sums.split(/\r?\n/).filter(Boolean)) {
    const [hash, name] = line.split(/\s+\*?/);
    const file = path.join(dist, name);
    if (!fs.existsSync(file)) fail('У артефакті немає файлу з SHA256SUMS: ' + name);
    if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== hash.toLowerCase()) fail('Контрольна сума не збігається: ' + name);
  }
  console.log(`Взято збірку GitHub Actions #${ok.databaseId} для коміту ${sha.slice(0, 7)}; контрольні суми перевірено.`);
}
const ci = process.argv.indexOf('--from-ci');
if (ci > 0) fetchCiBuild(process.argv[ci + 1] || fail('Вкажіть репозиторій: --from-ci owner/repo'));

const version = require('../package.json').version;
if (!fs.existsSync(keyFile)) fail('Немає приватного ключа підпису (build/keys/update-private.pem). Запустіть: npm run keygen');
// Для пре-релізу (1.2.3-beta.1) electron-builder пише <канал>.yml (beta.yml), для стабільного — latest.yml
const channel = /-([a-z]+)/i.exec(version);
const channelFile = channel ? channel[1].toLowerCase() + '.yml' : 'latest.yml';
const latestFile = path.join(dist, channelFile);
if (!fs.existsSync(latestFile)) fail(`dist/${channelFile} не знайдено. Спершу виконайте збірку: npm run dist`);

const info = yaml.load(fs.readFileSync(latestFile, 'utf8'));
if (info.version !== version) fail(`Версія в ${channelFile} (${info.version}) не збігається з package.json (${version}). Перезберіть: npm run dist`);
const entry = (info.files || []).find(f => /\.exe$/i.test(f.url));
if (!entry) fail(`У ${channelFile} немає .exe`);
const installer = path.join(dist, entry.url);
if (!fs.existsSync(installer)) fail('Не знайдено інсталятор ' + installer);

(async () => {
  const actual = await sha512File(installer);
  if (actual !== entry.sha512) fail('SHA-512 інсталятора не збігається з ' + channelFile + ' — збірку змінено після створення.');
  const signature = sign(fs.readFileSync(keyFile, 'utf8'), version, actual);
  if (!verify(publicPem, version, actual, signature)) fail('Підпис не перевіряється вбудованим публічним ключем: приватний ключ не відповідає src/update-key.js.');
  info.w3irSignature = signature;
  info.w3irKeyId = fingerprint(publicPem);

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, channelFile), yaml.dump(info, { lineWidth: -1 }));
  fs.copyFileSync(installer, path.join(out, entry.url));
  const blockmap = installer + '.blockmap';
  if (fs.existsSync(blockmap)) fs.copyFileSync(blockmap, path.join(out, entry.url + '.blockmap'));
  const portable = fs.readdirSync(dist).find(f => f === `W3IR-Browser-${version}-portable.exe`);
  if (portable) fs.copyFileSync(path.join(dist, portable), path.join(out, portable));

  const crypto = require('crypto');
  const sumLines = [];
  for (const f of fs.readdirSync(out)) {
    if (f.endsWith('.exe') || f === channelFile) {
      const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(out, f))).digest('hex');
      sumLines.push(`${h}  ${f}`);
    }
  }
  fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), sumLines.join('\n') + '\n');

  console.log(`Реліз ${version} підписано (ключ ${info.w3irKeyId}).`);
  console.log('Файли для публікації:', out);
  fs.readdirSync(out).forEach(f => console.log('  ', f));

  const gi = process.argv.indexOf('--github');
  if (gi > 0) {
    const repo = process.argv[gi + 1];
    const { publishDraft } = require('./publish-github');
    const sha256List = sumLines.filter(l => l.includes('.exe')).map(l => {
      const [h, f] = l.split(/\s+/);
      return `- \`${f}\`: \`${h}\``;
    }).join('\n');
    try {
      const url = await publishDraft({
        repo, tag: 'v' + version, dir: out, title: 'W3IR Browser ' + version, prerelease: /-/.test(version), manifest: channelFile,
        notes: `W3IR Browser ${version}\n\nПідпис випускача: \`${info.w3irKeyId}\`\n\n### Контрольні суми SHA-256:\n${sha256List}\n\nБраузер працює повністю локально та не збирає жодної телеметрії.\nПеревірка походження збірки: \`gh attestation verify <інсталятор> --repo ${repo}\``,
      });
      console.log('GitHub Release опубліковано:', url);
    } catch (e) { fail(e.message); }
  } else {
    console.log('\nЗавантажте ці файли на ваш HTTPS-хостинг (або створіть GitHub Release) і вкажіть джерело в Налаштування → Оновлення.');
  }
})();
