'use strict';
// Режими захисту: сторонні cookie, Referer, WebRTC (src/protection.js) на справжніх запитах у вікні браузера.
const http = require('http');
const { ok, sleep } = require('../lib');

async function protectionTests(ctx) {
  const ses = ctx.session;
  const w = [...ctx.windows][0];
  const seen = []; // запити до «стороннього» сервера: { cookie, referer }
  // сторонній сервер (127.0.0.1) і сторінка (localhost): різні сайти за реєстрованим доменом
  const third = http.createServer((req, res) => {
    seen.push({ cookie: req.headers.cookie || '', referer: req.headers.referer || '' });
    res.setHeader('set-cookie', 'tp=1; SameSite=None; Secure; Path=/');
    res.setHeader('content-type', 'image/gif');
    res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
  });
  await new Promise(r => third.listen(0, r));
  const thirdOrigin = `http://127.0.0.1:${third.address().port}`;
  const page = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><title>prot</title><img src="${thirdOrigin}/p.gif?a=1">`);
  });
  await new Promise(r => page.listen(0, r));
  const pageUrl = `http://localhost:${page.address().port}/secret/path?token=zzz`;

  const prev = ctx.cfg().protection;
  const prevAdblock = ctx.cfg().adblock;
  ctx.cfg().adblock = false; // піксель-запит збігається з правилами EasyList; перевіряється саме режим захисту
  const reset = async () => {
    for (const c of await ses.cookies.get({ domain: '127.0.0.1' })) await ses.cookies.remove(thirdOrigin + '/', c.name);
    seen.length = 0;
    await ses.cookies.set({ url: thirdOrigin + '/', name: 'sid', value: '1', secure: true, sameSite: 'no_restriction' });
  };
  const load = async (level) => {
    ctx.cfg().protection = level;
    ctx.applyProtection();
    await reset();
    w.exec('newTab'); w.exec('go', pageUrl); await sleep(3500);
    return seen[seen.length - 1];
  };

  try {
    const std = await load('standard');
    ok(std && /sid=1/.test(std.cookie), `protection: у стандартному режимі сторонній запит несе cookie (${JSON.stringify(std && std.cookie)})`);
    const strict = await load('strict');
    ok(strict && strict.cookie === '', `protection: суворий режим прибирає cookie зі стороннього запиту (${JSON.stringify(strict && strict.cookie)})`);
    ok((await ses.cookies.get({ url: thirdOrigin + '/', name: 'tp' })).length === 0, 'protection: суворий режим не зберігає Set-Cookie від стороннього сервера');
    ok(strict && strict.referer === `http://localhost:${page.address().port}/`, `protection: суворий режим залишає типове скорочення Referer Chromium (${strict && strict.referer})`);
    const max = await load('maximum');
    ok(max && max.cookie === '' && max.referer === '', `protection: максимальний режим не надсилає Referer стороннім сайтам (${max && max.referer})`);
    ctx.setAdblockAllowed('localhost', true);
    const exempt = await load('strict');
    ctx.setAdblockAllowed('localhost', false);
    ok(exempt && /sid=1/.test(exempt.cookie), 'protection: на сайті з вимкненим блокувальником обмеження не діють');
    // політика WebRTC застосовується до вкладок
    const wc = w.active().view.webContents;
    ctx.cfg().protection = 'maximum'; ctx.applyProtection();
    ok(wc.getWebRTCIPHandlingPolicy() === 'disable_non_proxied_udp', `protection: максимальний режим вмикає політику WebRTC (${wc.getWebRTCIPHandlingPolicy()})`);
    ctx.cfg().protection = 'standard'; ctx.applyProtection();
    ok(wc.getWebRTCIPHandlingPolicy() === 'default', 'protection: стандартний режим повертає типову політику WebRTC');
    // сторінка налаштувань показує перемикач режимів і розділ «Стан функцій»
    w.exec('newTab'); w.exec('go', 'w3ir://settings'); await sleep(2500);
    const sw = w.active().view.webContents;
    const ui = await sw.executeJavaScript(`({ marks: document.querySelectorAll('.maturity').length, labels: [...new Set([...document.querySelectorAll('.maturity')].map(e => e.className.replace('maturity ', '')))].sort().join(), modes: [...document.querySelectorAll('select option')].map(o => o.value).filter(v => ['standard', 'strict', 'maximum'].includes(v)).join() })`);
    ok(ui.marks >= 10 && ui.labels === 'beta,experimental,stable', `protection: у налаштуваннях є розділ «Стан функцій» (${JSON.stringify(ui)})`);
    ok(ui.modes === 'standard,strict,maximum', `protection: у налаштуваннях є вибір режиму захисту (${ui.modes})`);
  } finally {
    ctx.cfg().protection = prev || 'standard';
    ctx.cfg().adblock = prevAdblock;
    ctx.applyProtection();
    third.close(); page.close();
  }
}

module.exports = { protectionTests };
