'use strict';
// Локальний CI: ті самі перевірки, що були в .github/workflows/ci.yml, але на комп'ютері (хвилини GitHub Actions не витрачаються).
// Запуск: npm run ci. Швидкий режим без повного автотесту Electron: npm run ci -- --quick.
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const quick = process.argv.includes('--quick');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const run = (cmd, args) => spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' }).status === 0;
const out = (cmd, args) => { const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', shell: false }); return r.status === 0 ? r.stdout : ''; };

// Секрети не повинні потрапляти в репозиторій (дзеркало кроку з ci.yml)
function secretsClean() {
  const files = out('git', ['ls-files']).split(/\r?\n/).filter((f) => /\.(pem|key|pfx|p12)$/i.test(f) || /^build\/keys\//.test(f) || /vault\.(bin|pepper)$/.test(f));
  if (files.length) { console.error('Знайдено файли з секретами:\n' + files.join('\n')); return false; }
  const hit = out('git', ['grep', '-nIE', 'BEGIN (RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_', '--', '.', ':!.github', ':!build/ci-local.js']);
  if (hit.trim()) { console.error('Знайдено секрет:\n' + hit); return false; }
  return true;
}

const steps = [
  ['lint', () => run(npm, ['run', 'lint'])],
  ['unit-тести', () => run(npm, ['run', 'test:unit'])],
  ['переклади', () => run('node', ['build/i18n-extract.js', '--check'])],
  ['npm audit', () => run(npm, ['audit', '--omit=dev'])],
  ['секрети', secretsClean],
  ...(quick ? [] : [['автотест Electron', () => run(npm, ['test'])]]),
];

const failed = [];
for (const [name, fn] of steps) {
  console.log(`\n=== ${name} ===`);
  if (!fn()) { failed.push(name); console.error(`ПРОВАЛ: ${name}`); }
}
console.log(failed.length ? `\nЛокальний CI: провалено — ${failed.join(', ')}` : `\nЛокальний CI: усе зелене${quick ? ' (швидкий режим, без автотесту Electron)' : ''}.`);
process.exit(failed.length ? 1 : 0);
