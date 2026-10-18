'use strict';
// Unit-тести режимів захисту (src/protection.js) без Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const p = require(path.join(__dirname, '..', '..', 'src', 'protection.js'));

// спрощений siteKey: останні дві мітки домену (для тестів достатньо)
const siteKey = (h) => String(h).split('.').slice(-2).join('.');

test('protection: рівні й безпечне значення за замовчуванням', () => {
  assert.deepEqual(p.LEVELS, ['standard', 'strict', 'maximum']);
  assert.equal(p.level('strict'), 'strict');
  for (const bad of [undefined, null, '', 'MAXIMUM', 'off', 5]) assert.equal(p.level(bad), 'standard', String(bad));
  assert.equal(p.isStrict('standard'), false);
  assert.equal(p.isStrict('strict'), true);
  assert.equal(p.isStrict('maximum'), true);
  assert.equal(p.isStrict('сміття'), false);
});

test('protection: політика WebRTC зростає з рівнем', () => {
  assert.equal(p.webrtcPolicy('standard'), 'default');
  assert.equal(p.webrtcPolicy('strict'), 'default_public_interface_only');
  assert.equal(p.webrtcPolicy('maximum'), 'disable_non_proxied_udp');
  assert.equal(p.webrtcPolicy('x'), 'default');
});

test('protection: пресети вмикають перемикачі приватності лише для суворих режимів', () => {
  assert.deepEqual(p.PRESETS.standard, {});
  for (const lv of ['strict', 'maximum']) {
    for (const k of ['adblock', 'sendGpc', 'httpsFirst', 'stripTracking', 'safeBrowsing']) assert.equal(p.PRESETS[lv][k], true, `${lv}.${k}`);
  }
});

test('protection: стороннім вважається запит на інший сайт', () => {
  assert.equal(p.isThirdParty('https://cdn.tracker.net/a.js', 'news.example.com', siteKey), true);
  assert.equal(p.isThirdParty('https://static.example.com/a.js', 'news.example.com', siteKey), false, 'піддомен того ж сайту');
  assert.equal(p.isThirdParty('https://example.com/a.js', 'example.com', siteKey), false);
  assert.equal(p.isThirdParty('https://tracker.net/', '', siteKey), false, 'верхній сайт невідомий');
  assert.equal(p.isThirdParty('не адреса', 'example.com', siteKey), false);
});

test('protection: вхід Google виключений з обмежень', () => {
  assert.equal(p.isThirdParty('https://accounts.google.com/o/oauth2', 'news.example.com', siteKey), false);
  assert.equal(p.isThirdParty('https://news.example.com/x', 'accounts.google.com', siteKey), false);
  assert.equal(p.isThirdParty('https://accounts.youtube.com/', 'example.org', siteKey), false);
});

test('protection: cookie прибираються з запитів і відповідей незалежно від регістру', () => {
  const req = { Cookie: 'a=1', 'cookie': 'b=2', Accept: '*/*' };
  assert.equal(p.stripCookieRequest(req), true);
  assert.deepEqual(req, { Accept: '*/*' });
  assert.equal(p.stripCookieRequest({ Accept: '*/*' }), false);
  const res = { 'Set-Cookie': ['a=1'], 'set-cookie': ['b=2'], 'Content-Type': ['text/html'] };
  assert.equal(p.stripSetCookie(res), true);
  assert.deepEqual(res, { 'Content-Type': ['text/html'] });
  assert.equal(p.stripSetCookie(undefined), false);
  assert.equal(p.stripCookieRequest(null), false);
});

test('protection: Referer до сторонніх сайтів прибирається', () => {
  const h = { Referer: 'https://site.example/path/page?token=secret#x', Accept: '*/*' };
  assert.equal(p.dropReferrer(h), true);
  assert.deepEqual(h, { Accept: '*/*' });
  assert.equal(p.dropReferrer({ referer: 'http://a.b/x' }), true);
  assert.equal(p.dropReferrer({ Accept: '*/*' }), false);
  assert.equal(p.dropReferrer(undefined), false);
});
