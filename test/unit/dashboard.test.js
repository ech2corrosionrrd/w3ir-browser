'use strict';
// Unit-тести метрик панелі (src/dashboard.js) без Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const d = require(path.join(__dirname, '..', '..', 'src', 'dashboard.js'));

const proc = (type, privKb, wsKb, cpu, pid = 1) => ({ pid, type, cpu: { percentCPUUsage: cpu }, memory: { privateBytes: privKb, workingSetSize: wsKb } });

test('dashboard: процеси групуються за типом, пам\'ять у МБ', () => {
  const a = d.aggregateProcesses([
    proc('Browser', 100 * 1024, 300 * 1024, 2), proc('Tab', 20 * 1024, 80 * 1024, 1), proc('Tab', 30 * 1024, 90 * 1024, 3),
    proc('GPU', 32 * 1024, 100 * 1024, 0.5), proc('Utility', 7 * 1024, 50 * 1024, 0), proc('Zygote', 1024, 2048, 0),
  ], 4);
  const by = Object.fromEntries(a.groups.map(g => [g.key, g]));
  assert.equal(by.main.privMb, 100);
  assert.equal(by.tabs.n, 2);
  assert.equal(by.tabs.privMb, 50);
  assert.equal(by.other.n, 1, 'невідомий тип іде в «інше»');
  assert.equal(a.privMb, 190);
  assert.equal(a.groups[0].key, 'main', 'групи відсортовано за приватною пам\'яттю');
  assert.equal(a.cpu, 1.6, 'CPU нормується на кількість ядер');
});

test('dashboard: порожні, пошкоджені й екстремальні дані не ламають розрахунок', () => {
  assert.deepEqual(d.aggregateProcesses([], 8).groups, []);
  assert.equal(d.aggregateProcesses(undefined).privMb, 0);
  assert.equal(d.aggregateProcesses(null).cpu, 0);
  const odd = d.aggregateProcesses([{}, { type: 'Tab' }, { type: 'Tab', memory: { privateBytes: 'abc' }, cpu: { percentCPUUsage: NaN } }], 2);
  assert.equal(odd.privMb, 0);
  assert.equal(odd.cpu, 0);
  assert.equal(d.aggregateProcesses([proc('Tab', 1, 1, 900)], 1).cpu, 100, 'не більше 100 %');
});

test('dashboard: вкладки — інкогніто не показується, підраховуються стани', () => {
  const view = (pid) => ({ webContents: { getOSProcessId: () => pid } });
  const mk = (url, o = {}) => ({ url, view: view(o.pid || 0), sleep: o.sleep || null, pinned: !!o.pinned, playing: !!o.playing, blocked: o.blocked || 0 });
  const win = (tabs, incognito = false) => ({ incognito, tabs, tabUrl: (t) => t.url });
  const ctx = { windows: new Set([
    win([mk('https://news.example.com/a/b?token=secret', { pid: 11, blocked: 4 }), mk('w3ir://settings', { pid: 12 }), mk('https://sleepy.example/', { sleep: { url: 'x' }, pinned: true }), mk('https://video.example/', { pid: 13, playing: true })]),
    win([mk('https://private.example/secret-path', { pid: 21 })], true),
  ]) };
  const t = d.tabRows(ctx, new Map([[11, 120], [12, 40], [13, 80]]));
  assert.equal(t.total, 5);
  assert.equal(t.windows, 2);
  assert.equal(t.sleeping, 1);
  assert.equal(t.pinned, 1);
  assert.equal(t.playing, 1);
  assert.equal(t.rows.length, 4, 'вкладки інкогніто в списку відсутні');
  assert.ok(t.rows.every(r => !JSON.stringify(r).includes('secret')), 'шлях і параметри адреси не потрапляють у дані');
  assert.equal(t.rows[0].host, 'news.example.com');
  assert.equal(t.rows[0].mb, 120);
  assert.ok(t.rows.some(r => r.host === 'w3ir://settings'));
});
