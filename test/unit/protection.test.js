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

test('protection: округлення вимірів екрана (roundDimension)', () => {
  assert.equal(p.roundDimension(1920), 1900);
  assert.equal(p.roundDimension(1080), 1100);
  assert.equal(p.roundDimension(1440), 1400);
  assert.equal(p.roundDimension(2560), 2600);
  assert.equal(p.roundDimension(1366), 1400);
  assert.equal(p.roundDimension(0), 100);
});

test('protection: мікрошум Canvas (applyCanvasNoise)', () => {
  const buf = new Uint8Array(64).fill(128);
  const copy = new Uint8Array(buf);
  assert.equal(p.applyCanvasNoise(buf), true);
  // Значення змінилися в окремих байтах
  assert.notDeepEqual(buf, copy);
  // Зміни мінімальні (+1 або -1, тобто інверсія молодшого біта)
  for (let i = 0; i < buf.length; i++) {
    assert.ok(Math.abs(buf[i] - copy[i]) <= 1);
  }
  // Занадто короткий масив не модифікується
  assert.equal(p.applyCanvasNoise(new Uint8Array(8)), false);
  assert.equal(p.applyCanvasNoise(null), false);
});

test('protection: мікрошум AudioContext (applyAudioNoise) та WebGL спуфінг', () => {
  const buf = new Float32Array(64).fill(0.5);
  const copy = new Float32Array(buf);
  assert.equal(p.applyAudioNoise(buf), true);
  assert.notDeepEqual(buf, copy);
  for (let i = 0; i < buf.length; i++) {
    assert.ok(Math.abs(buf[i] - copy[i]) < 0.0001);
  }
  assert.equal(p.applyAudioNoise(new Float32Array(8)), false);
  assert.equal(p.applyAudioNoise(null), false);
  assert.ok(p.WEBGL_SPOOF.vendor && p.WEBGL_SPOOF.renderer);
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

test('protection: shieldSummary підсумовує стан захисту для панелі Shield', () => {
  // Стандартний режим, захист активний
  const s1 = p.shieldSummary({ adblock: true, siteAllowed: false, protection: 'standard', fingerprintProtection: false });
  assert.equal(s1.protLevel, 'standard');
  assert.equal(s1.adblockActive, true);
  assert.equal(s1.fpActive, false);
  assert.equal(s1.thirdPartyCookiesBlocked, false);
  assert.equal(s1.webrtc, 'default');

  // Суворий режим (блокуються сторонні cookie, WebRTC лише публічний інтерфейс)
  const s2 = p.shieldSummary({ adblock: true, siteAllowed: false, protection: 'strict', fingerprintProtection: true, stripTracking: true, httpsFirst: true });
  assert.equal(s2.protLevel, 'strict');
  assert.equal(s2.adblockActive, true);
  assert.equal(s2.fpActive, true);
  assert.equal(s2.thirdPartyCookiesBlocked, true);
  assert.equal(s2.webrtc, 'default_public_interface_only');
  assert.equal(s2.stripTracking, true);
  assert.equal(s2.httpsFirst, true);

  // Максимальний режим (відбитки активні автоматично, WebRTC лише через проксі)
  const s3 = p.shieldSummary({ adblock: true, siteAllowed: false, protection: 'maximum' });
  assert.equal(s3.protLevel, 'maximum');
  assert.equal(s3.fpActive, true);
  assert.equal(s3.webrtc, 'disable_non_proxied_udp');

  // Сайт у списку дозволених (siteAllowed = true) вимикає блокування на цьому сайті
  const s4 = p.shieldSummary({ adblock: true, siteAllowed: true, protection: 'strict', fingerprintProtection: true });
  assert.equal(s4.adblockActive, false);
  assert.equal(s4.fpActive, false);
  assert.equal(s4.thirdPartyCookiesBlocked, false);
});
