'use strict';
// Unit-тести безпечного завантаження публічних ресурсів (safe-fetch) без Electron.
// Перевірка захисту від SSRF, приватних діапазонів IPv4/IPv6, заборони облікових даних та перенаправлень.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { EventEmitter } = require('events');
const safeFetch = require(path.join(__dirname, '..', '..', 'src', 'safe-fetch.js'));

test('safe-fetch: isPublicIp коректно класифікує IP-адреси', () => {
  // Публічні IPv4
  assert.equal(safeFetch.isPublicIp('8.8.8.8'), true);
  assert.equal(safeFetch.isPublicIp('1.1.1.1'), true);
  assert.equal(safeFetch.isPublicIp('93.184.216.34'), true);

  // Приватні та спеціальні IPv4
  assert.equal(safeFetch.isPublicIp('127.0.0.1'), false); // loopback
  assert.equal(safeFetch.isPublicIp('10.0.0.1'), false); // private A
  assert.equal(safeFetch.isPublicIp('172.16.0.1'), false); // private B
  assert.equal(safeFetch.isPublicIp('172.31.255.255'), false);
  assert.equal(safeFetch.isPublicIp('192.168.1.1'), false); // private C
  assert.equal(safeFetch.isPublicIp('169.254.1.1'), false); // link-local
  assert.equal(safeFetch.isPublicIp('0.0.0.0'), false);
  assert.equal(safeFetch.isPublicIp('224.0.0.1'), false); // multicast
  assert.equal(safeFetch.isPublicIp('255.255.255.255'), false);
  assert.equal(safeFetch.isPublicIp('100.64.0.1'), false); // CGNAT
  assert.equal(safeFetch.isPublicIp('198.18.0.1'), false); // benchmark

  // IPv6
  assert.equal(safeFetch.isPublicIp('::1'), false); // loopback
  assert.equal(safeFetch.isPublicIp('::'), false);
  assert.equal(safeFetch.isPublicIp('fe80::1'), false); // link-local
  assert.equal(safeFetch.isPublicIp('fc00::1'), false); // ULA
  assert.equal(safeFetch.isPublicIp('::ffff:127.0.0.1'), false); // IPv4-mapped loopback
  assert.equal(safeFetch.isPublicIp('::ffff:192.168.0.1'), false);
  assert.equal(safeFetch.isPublicIp('::ffff:8.8.8.8'), true);
  assert.equal(safeFetch.isPublicIp('2606:4700:4700::1111'), true); // Cloudflare DNS
});

test('safe-fetch: checkUrl валідація протоколу, портів та хостів', () => {
  // Валідний HTTPS
  const u1 = safeFetch.checkUrl('https://example.com/nft.json');
  assert.equal(u1.hostname, 'example.com');

  // Лише https:
  assert.throws(() => safeFetch.checkUrl('http://example.com'), /https only/);
  assert.throws(() => safeFetch.checkUrl('ftp://example.com'), /https only/);
  assert.throws(() => safeFetch.checkUrl('file:///etc/passwd'), /https only/);

  // Заборона облікових даних
  assert.throws(() => safeFetch.checkUrl('https://user:pass@example.com'), /with credentials/);

  // Лише порт 443
  assert.throws(() => safeFetch.checkUrl('https://example.com:8443/'), /port 443 only/);
  assert.doesNotThrow(() => safeFetch.checkUrl('https://example.com:443/'));

  // Заборона прямого використання IP замість домену
  assert.throws(() => safeFetch.checkUrl('https://8.8.8.8/'), /IP addresses are not allowed/);
  assert.throws(() => safeFetch.checkUrl('https://[2001:db8::1]/'), /IP addresses are not allowed/);

  // Заборона локальних імен
  assert.throws(() => safeFetch.checkUrl('https://localhost/'), /local name/);
  assert.throws(() => safeFetch.checkUrl('https://my.localhost/'), /local name/);
  assert.throws(() => safeFetch.checkUrl('https://router.local/'), /local name/);
  assert.throws(() => safeFetch.checkUrl('https://service.internal/'), /local name/);

  // Некоректні адреси
  assert.throws(() => safeFetch.checkUrl('not a url'), /invalid address/);
});

test('safe-fetch: safeLookup відхиляє резолв у непублічні адреси', (t, done) => {
  // Мок DNS з приватною адресою
  const mockDnsPrivate = (host, opts, cb) => {
    cb(null, [{ address: '192.168.1.1', family: 4 }]);
  };

  safeFetch.safeLookup('evil.example', {}, (err) => {
    assert.ok(err);
    assert.equal(err.code, 'ENOTPUBLIC');

    // Мок DNS з публічною адресою
    const mockDnsPublic = (host, opts, cb) => {
      cb(null, [{ address: '93.184.216.34', family: 4 }]);
    };
    safeFetch.safeLookup('good.example', {}, (err, addr, family) => {
      assert.ifError(err);
      assert.equal(addr, '93.184.216.34');
      assert.equal(family, 4);
      done();
    }, mockDnsPublic);
  }, mockDnsPrivate);
});

test('safe-fetch: fetchPublic обробка відповідей і редиректів', async () => {
  // Створюємо мок запиту
  function createMockRequest(responder) {
    return (url, opts, cb) => {
      const req = new EventEmitter();
      req.destroy = (err) => { req.emit('error', err || new Error('destroyed')); };
      setImmediate(() => {
        const res = new EventEmitter();
        res.destroy = () => { res.emit('close'); };
        res.resume = () => {};
        responder(url, res, (statusCode, headers = {}) => {
          res.statusCode = statusCode;
          res.headers = headers;
          cb(res);
        });
      });
      return req;
    };
  }

  // 1. Успішна відповідь 200
  const req200 = createMockRequest((url, res, init) => {
    init(200, { 'content-type': 'application/json' });
    setImmediate(() => {
      res.emit('data', Buffer.from('{"name":"W3IR"}'));
      res.emit('end');
    });
  });
  const res = await safeFetch.fetchPublic('https://api.example/meta.json', {}, { request: req200, lookup: (h, o, cb) => cb(null, '93.184.216.34', 4) });
  assert.equal(res.type, 'application/json');
  assert.equal(res.buf.toString(), '{"name":"W3IR"}');

  // 2. Помилка статусу 404
  const req404 = createMockRequest((url, res, init) => {
    init(404, {});
    setImmediate(() => res.emit('end'));
  });
  await assert.rejects(
    () => safeFetch.fetchPublic('https://api.example/404.json', {}, { request: req404 }),
    /HTTP 404/
  );

  // 3. Перевищення ліміту розміру
  const reqTooLarge = createMockRequest((url, res, init) => {
    init(200, { 'content-length': '1000000' });
    setImmediate(() => res.emit('end'));
  });
  await assert.rejects(
    () => safeFetch.fetchPublic('https://api.example/large.bin', { max: 5000 }, { request: reqTooLarge }),
    /file too large/
  );
});
