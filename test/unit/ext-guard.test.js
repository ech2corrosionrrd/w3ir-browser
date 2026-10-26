'use strict';
// Unit-тести захисту розширень (src/ext-guard.js) без Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hashDir, readManifest, summarize } = require(path.join(__dirname, '..', '..', 'src', 'ext-guard.js'));

const mk = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-'));
  for (const [rel, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body); }
  return dir;
};

test('ext-guard: хеш стабільний і змінюється при будь-якій зміні вмісту', () => {
  const dir = mk({ 'manifest.json': '{"name":"x"}', 'bg.js': 'a', 'sub/c.js': 'b' });
  try {
    const h = hashDir(dir);
    assert.equal(h, hashDir(dir), 'повторний підрахунок дає той самий хеш');
    fs.writeFileSync(path.join(dir, 'bg.js'), 'a!');
    const h2 = hashDir(dir);
    assert.notEqual(h, h2, 'зміна вмісту');
    fs.writeFileSync(path.join(dir, 'new.js'), '');
    assert.notEqual(h2, hashDir(dir), 'новий файл');
    fs.rmSync(path.join(dir, 'new.js'));
    fs.renameSync(path.join(dir, 'sub', 'c.js'), path.join(dir, 'sub', 'd.js'));
    assert.notEqual(h2, hashDir(dir), 'перейменування файлу');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ext-guard: дозволи описуються, широкі позначаються', () => {
  const m = { name: 'Ext', version: '1.2', manifest_version: 3, permissions: ['storage', 'cookies', 'tabs'], host_permissions: ['https://*/*'], content_scripts: [{ matches: ['https://a.example/*', '<all_urls>'] }], background: { service_worker: 'bg.js' } };
  const s = summarize(m);
  assert.equal(s.name, 'Ext');
  assert.equal(s.manifestVersion, 3);
  assert.ok(s.background);
  assert.ok(s.perms.includes('https://a.example/*') && s.perms.includes('storage'));
  assert.deepEqual(s.risky.sort(), ['<all_urls>', 'cookies', 'https://*/*', 'tabs'].sort());
  const quiet = summarize({ name: 'Q', version: '1', permissions: ['storage'], host_permissions: ['https://a.example/*'] });
  assert.deepEqual(quiet.risky, []);
});

test('ext-guard: пошкоджені й нетипові дані не ламають розбір', () => {
  assert.deepEqual(summarize({}).perms, []);
  assert.deepEqual(summarize({ permissions: 'x', host_permissions: [1, null], content_scripts: 'no' }).perms, []);
  const dir = mk({ 'manifest.json': 'не json' });
  try { assert.throws(() => readManifest(dir)); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const ok = mk({ 'manifest.json': '{"name":"n","version":"1"}' });
  try { assert.equal(readManifest(ok).name, 'n'); } finally { fs.rmSync(ok, { recursive: true, force: true }); }
});
