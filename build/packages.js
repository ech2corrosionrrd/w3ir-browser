'use strict';
// Генерує пакети для Scoop і Chocolatey з готового релізу (dist/release) — нічого не публікує.
//   node build/packages.js          — bucket/w3ir-browser.json (Scoop) і dist/packages/chocolatey/ (nuspec + tools)
//   node build/packages.js --pack   — + `choco pack` (потрібен встановлений Chocolatey)
// Scoop: користувач додає репозиторій як bucket (`scoop bucket add w3ir https://github.com/ech2corrosionrrd/w3ir-browser`),
// пакет бере портативну збірку. Chocolatey: інсталятор NSIS із тихим ключем /S; публікація в спільноту — вручну (docs/RELEASING.md).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = 'ech2corrosionrrd/w3ir-browser';
const root = path.join(__dirname, '..');
const version = require('../package.json').version;
const rel = path.join(root, 'dist', 'release');
const fail = (m) => { console.error(m); process.exit(1); };

if (/-/.test(version)) fail(`Версія ${version} є пре-релізом: Scoop і Chocolatey отримують лише стабільні версії.`);
const setupName = `W3IR-Browser-Setup-${version}.exe`;
const portableName = `W3IR-Browser-${version}-portable.exe`;
const sha = (f) => {
  const p = path.join(rel, f);
  if (!fs.existsSync(p)) fail(`Немає ${p}. Спершу виконайте npm run release.`);
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
};
const tag = 'v' + version;
const base = `https://github.com/${REPO}/releases/download/${tag}`;

// ---------- Scoop ----------
const scoop = {
  version,
  description: 'Chromium-based browser with built-in ad blocking, password manager, Web3 wallet, profiles and encrypted bookmark sync',
  homepage: `https://github.com/${REPO}`,
  license: 'MIT',
  url: `${base}/${portableName}#/W3IR-Browser.exe`,
  hash: sha(portableName),
  shortcuts: [['W3IR-Browser.exe', 'W3IR Browser']],
  checkver: 'github',
  autoupdate: {
    url: `https://github.com/${REPO}/releases/download/v$version/W3IR-Browser-$version-portable.exe#/W3IR-Browser.exe`,
    hash: { url: `https://github.com/${REPO}/releases/download/v$version/SHA256SUMS.txt`, regex: '$sha256\\s+\\*?$basename' },
  },
  notes: 'Портативна збірка не оновлює себе сама: оновлюйте через `scoop update w3ir-browser`.',
};
fs.mkdirSync(path.join(root, 'bucket'), { recursive: true });
fs.writeFileSync(path.join(root, 'bucket', 'w3ir-browser.json'), JSON.stringify(scoop, null, 4) + '\n');

// ---------- Chocolatey ----------
const choco = path.join(root, 'dist', 'packages', 'chocolatey');
fs.rmSync(choco, { recursive: true, force: true });
fs.mkdirSync(path.join(choco, 'tools'), { recursive: true });
fs.writeFileSync(path.join(choco, 'w3ir-browser.nuspec'), `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://schemas.microsoft.com/packaging/2015/06/nuspec.xsd">
  <metadata>
    <id>w3ir-browser</id>
    <version>${version}</version>
    <title>W3IR Browser</title>
    <authors>W3IR</authors>
    <owners>ech2corrosionrrd</owners>
    <copyright>Copyright (c) 2026 W3IR</copyright>
    <iconUrl>https://cdn.jsdelivr.net/gh/${REPO}@e5f32a4e08e23714983a2d8b23cdf4b083957c6f/build/brand/icon-512.png</iconUrl>
    <projectUrl>https://github.com/${REPO}</projectUrl>
    <licenseUrl>https://github.com/${REPO}/blob/main/LICENSE</licenseUrl>
    <requireLicenseAcceptance>false</requireLicenseAcceptance>
    <projectSourceUrl>https://github.com/${REPO}/tree/main</projectSourceUrl>
    <packageSourceUrl>https://github.com/${REPO}/tree/main/build</packageSourceUrl>
    <bugTrackerUrl>https://github.com/${REPO}/issues</bugTrackerUrl>
    <releaseNotes>https://github.com/${REPO}/blob/main/CHANGELOG.md</releaseNotes>
    <tags>browser chromium privacy adblock web3 wallet password-manager</tags>
    <summary>Chromium-based browser with built-in ad blocking, password manager and Web3 wallet</summary>
    <description>W3IR Browser is a Windows browser on Chromium/Electron with built-in ad and tracker blocking, a local encrypted password manager with 2FA, a Web3 wallet (EVM and Solana), profiles and encrypted bookmark sync. No telemetry. Installs per user. Note: the installer is not code-signed yet, so Windows SmartScreen may show a warning; verify the SHA-256 checksum published with each release.</description>
  </metadata>
  <files>
    <file src="tools\\**" target="tools" />
  </files>
</package>
`);
fs.writeFileSync(path.join(choco, 'tools', 'chocolateyinstall.ps1'), `$ErrorActionPreference = 'Stop'
$packageArgs = @{
  packageName    = $env:ChocolateyPackageName
  fileType       = 'exe'
  url64bit       = '${base}/${setupName}'
  checksum64     = '${sha(setupName)}'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}
Install-ChocolateyPackage @packageArgs
`);
fs.writeFileSync(path.join(choco, 'tools', 'chocolateyuninstall.ps1'), `$ErrorActionPreference = 'Stop'
$keys = Get-UninstallRegistryKey -SoftwareName 'W3IR Browser*'
foreach ($key in $keys) {
  $file = ($key.UninstallString -replace '"', '').Trim()
  Uninstall-ChocolateyPackage -PackageName $env:ChocolateyPackageName -FileType 'exe' -SilentArgs '/S' -File $file -ValidExitCodes @(0)
}
`);
console.log('Scoop: bucket/w3ir-browser.json');
console.log('Chocolatey: ' + choco);

if (process.argv.includes('--pack')) {
  const r = spawnSync('choco', ['pack', '--out', path.join(root, 'dist', 'packages')], { cwd: choco, encoding: 'utf8' });
  process.stdout.write(r.stdout || '');
  if (r.status !== 0) fail('choco pack не вдався: ' + (r.stderr || ''));
}
