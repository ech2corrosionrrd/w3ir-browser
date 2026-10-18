'use strict';
// Unit-тести даних стартової сторінки (src/startpage.js) без Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const sp = require(path.join(__dirname, '..', '..', 'src', 'startpage.js'));

test('startpage: останні закладки — найновіші першими, лише http(s), без дублікатів', () => {
  const r = sp.recentBookmarks([
    { url: 'https://a.example/', title: 'A', added: 1 },
    { url: 'https://b.example/', title: 'B', added: 3 },
    { url: 'javascript:alert(1)', title: 'XSS', added: 9 },
    { url: 'file:///C:/secret.txt', title: 'file', added: 8 },
    { url: 'https://b.example/', title: 'B дубль', added: 2 },
    { url: 'http://c.example/x', title: 'C\u0000\u202e', added: 2 },
    null, { title: 'без адреси' },
  ], 8);
  assert.deepEqual(r.map(x => x.url), ['https://b.example/', 'http://c.example/x', 'https://a.example/']);
  assert.ok(!/[\u0000\u202e]/.test(r[1].title), 'керівні символи прибрано з назви');
});

test('startpage: ліміт і некоректні вхідні дані', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ url: 'https://s' + i + '.example/', title: 't' + i, added: i }));
  assert.equal(sp.recentBookmarks(many, 8).length, 8);
  assert.equal(sp.recentBookmarks(many, 8)[0].title, 't29');
  assert.deepEqual(sp.recentBookmarks(undefined), []);
  assert.deepEqual(sp.recentBookmarks('рядок'), []);
  assert.equal(sp.recentBookmarks([{ url: 'https://x.example/', title: 'я'.repeat(500), added: 1 }])[0].title.length, 120);
});

test('startpage: інформація не містить адрес вкладок інкогніто й даних гаманця', () => {
  const win = (tabs, incognito) => ({ incognito, tabs });
  const ctx = {
    windows: new Set([win([{ sleep: null }, { sleep: { url: 'x' } }], false), win([{ sleep: null }, { sleep: null }, { sleep: null }], true)]),
    wallet: { exists: () => true }, vault: { status: () => 'locked' },
    stats: { blocked: 5, cookies: 3, https: 2, threats: 1 },
    downloads: { summary: () => ({ active: 2, percent: 40 }) },
    cfg: () => ({ protection: 'strict', adblock: true, safeBrowsing: true, searchEngine: 'duckduckgo' }),
    ENGINES: { google: { name: 'Google' }, duckduckgo: { name: 'DuckDuckGo' } },
    bookmarks: () => [{ url: 'https://a.example/', title: 'A', added: 1 }],
  };
  const i = sp.info(ctx, { version: '9.9.9' });
  assert.deepEqual(i.tabs, { total: 2, sleeping: 1 }, 'вкладки інкогніто не враховуються');
  assert.equal(i.wallet, 'locked');
  assert.equal(i.protection.blocked, 11);
  assert.equal(i.protection.mode, 'strict');
  assert.deepEqual(i.downloads, { active: 2, percent: 40 });
  assert.equal(i.engine, 'DuckDuckGo');
  assert.equal(i.bookmarkCount, 1);
  assert.equal(i.version, '9.9.9');
  ctx.wallet = null;
  assert.equal(sp.info(ctx, { version: '1' }).wallet, 'none');
  ctx.wallet = { exists: () => true }; ctx.vault = { status: () => 'unlocked' };
  assert.equal(sp.info(ctx, { version: '1' }).wallet, 'ready');
});
