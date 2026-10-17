'use strict';
// Завантаження файлів із довільних https-сайтів головним процесом (метадані й зображення NFT) із захистом від SSRF: локальні й приватні
// адреси відхиляються НА МОМЕНТ З'ЄДНАННЯ (перевірка в lookup, тож підміна DNS між перевіркою й запитом неможлива), лише https і порт
// 443, без облікових даних в адресі, до 3 перенаправлень (кожне перевіряється), ліміти розміру й часу. Зовнішній сайт бачить ваш IP:
// тому функція вмикається лише налаштуванням користувача.
const https = require('https');
const dns = require('dns');

const MAX_REDIRECTS = 3;

// Приватні, локальні, службові діапазони IPv4
function isPrivateV4(a) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (!m) return true;
  const [o1, o2] = [Number(m[1]), Number(m[2])];
  if ([m[1], m[2], m[3], m[4]].some(x => Number(x) > 255)) return true;
  return o1 === 0 || o1 === 10 || o1 === 127 || (o1 === 100 && o2 >= 64 && o2 <= 127) || (o1 === 169 && o2 === 254) || (o1 === 172 && o2 >= 16 && o2 <= 31)
    || (o1 === 192 && o2 === 0) || (o1 === 192 && o2 === 168) || (o1 === 198 && (o2 === 18 || o2 === 19)) || o1 >= 224;
}
function isPublicIp(ip) {
  const a = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!a) return false;
  if (a.includes(':')) {
    if (a === '::' || a === '::1') return false;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return !isPrivateV4(mapped[1]);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
    if (hex) { const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16); return !isPrivateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`); }
    if (/^(fc|fd|fe[89ab]|ff|64:ff9b|2001:db8|2002:)/.test(a)) return false;
    return true;
  }
  return !isPrivateV4(a);
}

// lookup для https.request: відхиляє імена, що вказують хоч на одну непублічну адресу
function safeLookup(hostname, options, cb, resolver = dns.lookup) {
  resolver(hostname, { all: true }, (err, list) => {
    if (err) return cb(err);
    const addrs = Array.isArray(list) ? list : [{ address: list, family: 4 }];
    if (!addrs.length || addrs.some(x => !isPublicIp(x.address))) { const e = new Error('address is not public'); e.code = 'ENOTPUBLIC'; return cb(e); }
    if (options && options.all) return cb(null, addrs);
    return cb(null, addrs[0].address, addrs[0].family);
  });
}

function checkUrl(u) {
  let url;
  try { url = new URL(u); } catch { throw new Error('invalid address'); }
  if (url.protocol !== 'https:') throw new Error('https only');
  if (url.username || url.password) throw new Error('address with credentials');
  if (url.port && url.port !== '443') throw new Error('port 443 only');
  if (/^\[|^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) throw new Error('IP addresses are not allowed');
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local') || url.hostname.endsWith('.internal')) throw new Error('local name');
  return url;
}

// deps (для тестів): { request, lookup }
function fetchPublic(startUrl, { max = 400 * 1024, timeout = 8000, redirects = MAX_REDIRECTS } = {}, deps = {}) {
  const request = deps.request || https.get;
  const lookup = deps.lookup || safeLookup;
  const once = (u, left) => new Promise((resolve, reject) => {
    let url;
    try { url = checkUrl(u); } catch (e) { return reject(e); }
    let done = false;
    const fail = (e) => { if (!done) { done = true; reject(e); } };
    const req = request(url, { lookup, timeout, headers: { accept: '*/*', 'user-agent': 'Mozilla/5.0' }, agent: false }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (left <= 0) return fail(new Error('too many redirects'));
        let next;
        try { next = new URL(res.headers.location, url).toString(); } catch { return fail(new Error('invalid redirect')); }
        return once(next, left - 1).then(r => { if (!done) { done = true; resolve(r); } }, fail);
      }
      if (status !== 200) { res.resume(); return fail(new Error('HTTP ' + status)); }
      const len = Number(res.headers['content-length']);
      if (Number.isFinite(len) && len > max) { res.destroy(); return fail(new Error('file too large')); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > max) { res.destroy(); fail(new Error('file too large')); } else chunks.push(c); });
      res.on('end', () => { if (!done) { done = true; resolve({ buf: Buffer.concat(chunks), type: String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase() }); } });
      res.on('error', fail);
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', fail);
  });
  return once(startUrl, redirects);
}

module.exports = { fetchPublic, safeLookup, isPublicIp, checkUrl };
