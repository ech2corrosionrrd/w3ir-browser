'use strict';
// Генерує маніфести winget (схема 1.12.0) для поточного релізу й, за бажанням, відкриває PR у microsoft/winget-pkgs.
//   node build/winget.js                    — створити dist/winget/manifests/w/W3IR/Browser/<версія>/
//   node build/winget.js --validate         — + перевірка `winget validate`
//   node build/winget.js --submit           — + форк, гілка й pull request через gh CLI (потрібна авторизація gh)
// Прапорці --tested / --cla відмічають відповідні пункти шаблону PR; ставте їх лише якщо це правда.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const REPO = 'ech2corrosionrrd/w3ir-browser';
const ID = 'W3IR.Browser';
const PRODUCT_CODE = 'b34667a1-fbbf-5ed2-9d20-3b7154cdcd62'; // ключ видалення NSIS (виводиться з appId, стабільний між версіями)
const MV = '1.12.0';

const root = path.join(__dirname, '..');
const version = require('../package.json').version;
const latest = yaml.load(fs.readFileSync(path.join(root, 'dist', 'release', 'latest.yml'), 'utf8'));
if (latest.version !== version) { console.error(`dist/release/latest.yml (${latest.version}) не відповідає package.json (${version}). Виконайте npm run release.`); process.exit(1); }

const installerName = latest.files[0].url;
const installerPath = path.join(root, 'dist', 'release', installerName);
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(installerPath)).digest('hex').toUpperCase();
const releaseDate = new Date(latest.releaseDate).toISOString().slice(0, 10);
const tag = 'v' + version;
const url = `https://github.com/${REPO}/releases/download/${tag}/${installerName}`;
const schema = (t) => `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${t}.${MV}.schema.json\n`;

const files = {
  [`${ID}.yaml`]: schema('version') + `
PackageIdentifier: ${ID}
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: ${MV}
`,
  [`${ID}.installer.yaml`]: schema('installer') + `
PackageIdentifier: ${ID}
PackageVersion: ${version}
Platform:
- Windows.Desktop
MinimumOSVersion: 10.0.0.0
InstallerType: nullsoft
Scope: user
InstallModes:
- interactive
- silent
- silentWithProgress
InstallerSwitches:
  Upgrade: --updated
UpgradeBehavior: install
ProductCode: ${PRODUCT_CODE}
ReleaseDate: ${releaseDate}
Installers:
- Architecture: x64
  InstallerUrl: ${url}
  InstallerSha256: ${sha256}
ManifestType: installer
ManifestVersion: ${MV}
`,
  [`${ID}.locale.en-US.yaml`]: schema('defaultLocale') + `
PackageIdentifier: ${ID}
PackageVersion: ${version}
PackageLocale: en-US
Publisher: W3IR
PublisherUrl: https://github.com/ech2corrosionrrd
PublisherSupportUrl: https://github.com/${REPO}/issues
PackageName: W3IR Browser
PackageUrl: https://github.com/${REPO}
License: Freeware
ShortDescription: Chromium-based browser with built-in ad blocking, password manager, Web3 wallet, profiles and encrypted bookmark sync.
Description: >-
  W3IR Browser is a privacy-focused Windows browser built on Chromium. It includes ad and tracker blocking, HTTPS-first browsing,
  an encrypted password manager, a Web3 (EVM) wallet, profiles, reader mode, a command palette, GitHub integration,
  encrypted bookmark sync through a folder you choose, and signed automatic updates.
Moniker: w3ir
Tags:
- adblock
- browser
- chromium
- electron
- password-manager
- privacy
- web3
ReleaseNotesUrl: https://github.com/${REPO}/releases/tag/${tag}
ManifestType: defaultLocale
ManifestVersion: ${MV}
`,
  [`${ID}.locale.uk-UA.yaml`]: schema('locale') + `
PackageIdentifier: ${ID}
PackageVersion: ${version}
PackageLocale: uk-UA
Publisher: W3IR
PublisherUrl: https://github.com/ech2corrosionrrd
PublisherSupportUrl: https://github.com/${REPO}/issues
PackageName: W3IR Browser
PackageUrl: https://github.com/${REPO}
License: Безкоштовне ПЗ
ShortDescription: Браузер на основі Chromium із блокуванням реклами, менеджером паролів, гаманцем Web3, профілями та зашифрованою синхронізацією закладок.
Description: >-
  W3IR Browser — браузер для Windows із упором на приватність. Має блокування реклами й трекерів, режим «Спершу HTTPS»,
  зашифрований менеджер паролів, гаманець Web3 (EVM), профілі, режим читання, палітру команд, інтеграцію з GitHub,
  зашифровану синхронізацію закладок через обрану теку та підписані автоматичні оновлення.
Tags:
- блокування-реклами
- браузер
- приватність
ManifestType: locale
ManifestVersion: ${MV}
`,
};

const first = ID.split('.')[0];
const dir = path.join(root, 'dist', 'winget', 'manifests', first[0].toLowerCase(), ...ID.split('.'), version);
fs.rmSync(path.join(root, 'dist', 'winget'), { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text.replace(/^\n/m, '\n').replace(/\r?\n/g, '\n'));
console.log('Маніфести створено:', dir);
console.log('  SHA256 інсталятора:', sha256);

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const has = (f) => process.argv.includes(f);

let validated = false;
if (has('--validate') || has('--submit')) {
  // winget validate запускаємо в окремому процесі Node: після нього наступні child_process у тому ж процесі падають (libuv: AssignProcessToJobObject)
  const code = 'const r=require("child_process").spawnSync("winget",["validate","--manifest",process.argv[1]],{encoding:"utf8"});process.stdout.write((r.stdout||"")+(r.stderr||""));process.exit(r.status||0)';
  const r = run(process.execPath, ['-e', code, dir]);
  process.stdout.write(r.stdout || '');
  if (r.status !== 0) { console.error('winget validate не пройшов.'); process.exit(1); }
  validated = true;
}

if (has('--submit')) {
  const me = run('gh', ['api', 'user', '--jq', '.login']).stdout.trim();
  if (!me) { console.error('gh не авторизовано'); process.exit(1); }
  const gh = (args, input) => {
    const r = run('gh', args, { input });
    if (r.status !== 0) { console.error('gh', args.slice(0, 3).join(' '), '→', r.stderr || r.stdout); process.exit(1); }
    return r.stdout.trim();
  };
  const branch = `${ID}-${version}`.toLowerCase();
  const upstream = 'microsoft/winget-pkgs';
  const fork = `${me}/winget-pkgs`;

  const existing = gh(['pr', 'list', '--repo', upstream, '--author', me, '--search', `${ID} ${version} in:title`, '--state', 'open', '--json', 'url', '--jq', '.[0].url']);
  if (existing) { console.log('PR уже існує:', existing); process.exit(0); }

  run('gh', ['repo', 'fork', upstream, '--clone=false']);
  // форк має бути синхронним з upstream
  run('gh', ['repo', 'sync', fork, '--source', upstream]);
  const sha = gh(['api', `repos/${upstream}/git/ref/heads/master`, '--jq', '.object.sha']);
  const mk = run('gh', ['api', '-X', 'POST', `repos/${fork}/git/refs`, '-f', `ref=refs/heads/${branch}`, '-f', `sha=${sha}`]);
  if (mk.status !== 0 && !/already exists/i.test(mk.stderr + mk.stdout)) { console.error('Не вдалося створити гілку:', mk.stderr || mk.stdout); process.exit(1); }

  const rel = `manifests/${first[0].toLowerCase()}/${ID.split('.').join('/')}/${version}`;
  for (const [name, text] of Object.entries(files)) {
    const body = JSON.stringify({ message: `New package: ${ID} version ${version}`, branch, content: Buffer.from(text.replace(/\r?\n/g, '\n')).toString('base64') });
    gh(['api', '-X', 'PUT', `repos/${fork}/contents/${rel}/${name}`, '--input', '-'], body);
  }
  const tick = (b) => (b ? '[x]' : '[ ]');
  const prBody = `## 📖 Description
New package: **${ID}** version **${version}** — W3IR Browser, a Chromium-based (Electron) Windows browser.
Installer: NSIS (per-user), hosted in GitHub Releases: ${url}
The installer is not signed with an Authenticode certificate yet; releases are signed with the publisher's own Ed25519 key for the built-in updater.

## ✅ Checklist
- ${tick(has('--cla'))} Signed the [Contributor License Agreement](https://cla.opensource.microsoft.com)
- [ ] Linked to an issue (if applicable)

## 📦 Manifest Checklist
- [x] Checked that there aren't other open [pull requests](https://github.com/microsoft/winget-pkgs/pulls) for the same manifest update/change
- [x] This PR only modifies one (1) manifest
- ${tick(validated)} Validated manifest locally with \`winget validate --manifest <path>\`
- ${tick(has('--tested'))} Tested manifest locally with \`winget install --manifest <path>\`
- [x] Manifest conforms to the [1.12 schema](https://github.com/microsoft/winget-pkgs/tree/master/doc/manifest/schema/1.12.0)
`;
  const pr = gh(['pr', 'create', '--repo', upstream, '--head', `${me}:${branch}`, '--base', 'master', '--title', `New package: ${ID} version ${version}`, '--body-file', '-'], prBody);
  console.log('Pull request:', pr);
}
