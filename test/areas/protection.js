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

// Автосон вкладок: налаштований час, винятки (закріплена, відео, незбережене введення)
async function sleepTests(ctx) {
  const w = [...ctx.windows][0];
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>sleep</title><input id="a" type="text"><textarea id="b"></textarea><p>x</p>'); });
  await new Promise(r => srv.listen(0, r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const prevMin = ctx.cfg().sleepMinutes;
  const prevOn = ctx.cfg().sleepTabs;
  ctx.cfg().sleepTabs = true;
  const open = async () => { w.exec('newTab'); w.exec('go', url); await sleep(2500); return w.active(); };
  const old = (t, min) => { t.lastActive = Date.now() - min * 60000; };
  try {
    ctx.cfg().sleepMinutes = 15;
    const t1 = await open();
    await open(); // t1 стає фоновою
    old(t1, 10);
    await w.sleepIdle();
    ok(!t1.sleep, 'sleep: вкладка, неактивна 10 хв, при порозі 15 хв не засинає');
    old(t1, 16);
    await w.sleepIdle();
    ok(!!t1.sleep, 'sleep: вкладка, неактивна 16 хв, при порозі 15 хв засинає');

    ctx.cfg().sleepMinutes = 30;
    const t2 = await open(); await open();
    old(t2, 20);
    await w.sleepIdle();
    ok(!t2.sleep, 'sleep: налаштований поріг 30 хв працює (20 хв — ще не спить)');
    old(t2, 31);
    await w.sleepIdle();
    ok(!!t2.sleep, 'sleep: налаштований поріг 30 хв працює (31 хв — спить)');

    ctx.cfg().sleepMinutes = 5;
    const t3 = await open(); await open();
    t3.pinned = true; old(t3, 60);
    await w.sleepIdle();
    ok(!t3.sleep, 'sleep: закріплена вкладка не засинає');
    t3.pinned = false;

    const t4 = await open(); await open();
    t4.playing = true; old(t4, 60);
    await w.sleepIdle();
    ok(!t4.sleep, 'sleep: вкладка з відео чи звуком не засинає');
    t4.playing = false;

    const t5 = await open();
    await t5.view.webContents.executeJavaScript(`document.getElementById('a').value = 'незбережений текст'`);
    await open();
    old(t5, 60);
    await w.sleepIdle();
    ok(!t5.sleep, 'sleep: вкладка з незбереженим введенням у формі не засинає');
    await t5.view.webContents.executeJavaScript(`document.getElementById('a').value = ''`);
    await w.sleepIdle();
    ok(!!t5.sleep, 'sleep: після очищення поля вкладка знову може заснути');

    const active = w.active();
    old(active, 600);
    await w.sleepIdle();
    ok(!active.sleep, 'sleep: активна вкладка не засинає');
  } finally {
    ctx.cfg().sleepMinutes = prevMin;
    ctx.cfg().sleepTabs = prevOn;
    srv.close();
  }
}

// Стартова сторінка: швидкий доступ до всіх розділів, стан, закладки; доступ до її даних лише з неї
async function startPageTests(ctx) {
  const fs = require('fs');
  const path = require('path');
  const w = [...ctx.windows].find(x => !x.incognito && !x.agent);
  const before = ctx.bookmarksStore.data.slice();
  ctx.bookmarksStore.data.push({ url: 'https://start-test-a.example/', title: 'Тестова закладка А', added: Date.now() - 1000, mod: 0 }, { url: 'https://start-test-b.example/', title: 'Тестова закладка Б', added: Date.now(), mod: 0 });
  try {
    const t = w.createTab('w3ir://newtab', { activate: true });
    await sleep(2200);
    const wc = t.view.webContents;
    const dom = await wc.executeJavaScript(`({
      hrefs: [...document.querySelectorAll('.lc')].map(a => a.getAttribute('href')),
      pills: document.querySelectorAll('.status .pill').length,
      bms: [...document.querySelectorAll('.bm .bn')].map(e => e.textContent),
      tip: document.querySelector('.tip-t').textContent.length > 10,
      keys: document.querySelectorAll('.key').length,
      clock: document.querySelector('.clock').textContent.length >= 4,
      search: !!document.querySelector('form.search input'),
    })`);
    const pagesDir = path.join(__dirname, '..', '..', 'pages');
    const names = dom.hrefs.map(h => h.replace('w3ir://', ''));
    ok(dom.hrefs.length === 12 && new Set(dom.hrefs).size === 12, `start: 12 різних швидких запусків (${dom.hrefs.length})`);
    ok(names.every(n => fs.existsSync(path.join(pagesDir, n + '.html'))), `start: кожен запуск веде на наявну сторінку (${names.filter(n => !fs.existsSync(path.join(pagesDir, n + '.html'))).join() || 'усі є'})`);
    ok(dom.pills === 5 && dom.keys === 6 && dom.tip && dom.clock && dom.search, `start: стан, поради, клавіші, годинник і пошук присутні (${JSON.stringify({ p: dom.pills, k: dom.keys, tip: dom.tip, clock: dom.clock, search: dom.search })})`);
    ok(dom.bms[0] === 'Тестова закладка Б' && dom.bms.includes('Тестова закладка А'), `start: останні закладки показані, найновіша першою (${dom.bms.slice(0, 2).join(' | ')})`);
    // дані стартової сторінки віддаються лише їй
    const probe = async (page, expr) => {
      const tt = w.createTab('w3ir://' + page, { activate: false });
      await sleep(1400);
      const r = await tt.view.webContents.executeJavaScript(`(${expr}).then(() => 'ok', () => 'denied')`);
      w.closeTab(tt.id);
      return r;
    };
    ok(await probe('newtab', `w3ir.invoke('startinfo', {})`) === 'ok' && await probe('settings', `w3ir.invoke('startinfo', {})`) === 'denied' && await probe('history', `w3ir.invoke('startinfo', {})`) === 'denied', 'start: startinfo доступний лише стартовій сторінці');
    const info = await wc.executeJavaScript(`w3ir.invoke('startinfo', {})`);
    ok(!/mnemonic|phrase|privateKey|token/i.test(JSON.stringify(info)), 'start: у даних стартової сторінки немає секретів');
  } finally {
    ctx.bookmarksStore.data.length = 0;
    ctx.bookmarksStore.data.push(...before);
  }
}

module.exports = { protectionTests: async (ctx) => { await protectionTests(ctx); await sleepTests(ctx); await startPageTests(ctx); } };
