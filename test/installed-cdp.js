'use strict';
// Тест ВСТАНОВЛЕНОЇ збірки через CDP (docs/TESTING.md → «Тест встановленої збірки»).
// Запуск: ELECTRON_RUN_AS_NODE=1 node_modules\electron\dist\electron.exe test\installed-cdp.js
// Змінні: EXPECT_VERSION (очікувана версія, за замовчуванням 1.15.1), SHOTS (тека для скриншотів).
// Потрібен екземпляр із --remote-debugging-port=9333 і окремим --user-data-dir (не ваш робочий профіль).
const fs = require('fs');
const path = require('path');
const OUT = process.env.SHOTS;
const PORT = 9333;
const V = process.env.EXPECT_VERSION || '1.15.1';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, extra) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${!c && extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 300) : ''}`); };

const cdp = (ws) => new Promise((res, rej) => {
  const s = new WebSocket(ws); let id = 0; const pend = new Map();
  s.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  s.onerror = rej;
  s.onopen = () => res({ send: (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); s.send(JSON.stringify({ id: i, method, params })); }), close: () => s.close() });
});
const targets = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page');
const find = async (pred) => (await targets()).filter(pred);
async function ev(t, expr) {
  const c = await cdp(t.webSocketDebuggerUrl);
  const r = await Promise.race([c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }), new Promise(res => setTimeout(() => res({ result: { exceptionDetails: { text: 'timeout 20s' } } }), 20000))]);
  c.close();
  if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || r.result.exceptionDetails.text).slice(0, 200));
  return r.result && r.result.result ? r.result.result.value : undefined;
}
async function shot(t, name) {
  if (!OUT) return;
  const c = await cdp(t.webSocketDebuggerUrl);
  const r = await Promise.race([c.send('Page.captureScreenshot', { format: 'png' }), new Promise(res => setTimeout(() => res({}), 8000))]);
  c.close();
  if (r.result) fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64'));
}
// Справжній клік мишею з паузою між натисканням і відпусканням (як у людини; миттєві програмні кліки приховують помилки)
async function slowClick(t, x, y, hold = 150) {
  const c = await cdp(t.webSocketDebuggerUrl);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(hold);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  c.close();
}
async function waitFor(fn, ms = 10000, step = 250) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(step); } return null; }

(async () => {
  // ---- 1. запуск і основні цілі ----
  let ui = await waitFor(async () => (await find(t => t.url === 'w3ir://ui/index.html'))[0], 15000);
  ok(!!ui, 'запуск: вікно інтерфейсу створене');
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  ok(ver['User-Agent'].includes('W3IRBrowser/' + V) && /Electron\/\d+\./.test(ver['User-Agent']), `версія: ${V} (User-Agent браузера містить W3IRBrowser і Electron)`, ver['User-Agent']);
  // З 1.29.1 User-Agent чесний (з Electron/W3IRBrowser): особа Chrome діє лише на сторінках Google (інакше Cloudflare Turnstile не пускав)
  ok(/Chrome\//.test(await ev((await find(t => t.url.startsWith('w3ir://newtab')))[0] || ui, 'navigator.userAgent')), 'User-Agent містить Chrome (чесний User-Agent поза Google)');
  const newtab = await waitFor(async () => (await find(t => t.url.startsWith('w3ir://newtab')))[0], 10000);
  ok(!!newtab, 'нова вкладка відкрита');
  if (newtab) {
    ok(await ev(newtab, `document.querySelector('.brand-s .mark') && document.querySelector('.brand-s .mark').naturalWidth > 100 && document.querySelector('.brand-s .wordmark').naturalWidth > 100`), 'нова вкладка: знак і вордмарк бренду завантажені');
    ok(await ev(newtab, `document.documentElement.classList.contains('newtab') && getComputedStyle(document.documentElement).backgroundImage.includes('gradient')`), 'нова вкладка: фірмовий фон (градієнт)');
    await shot(newtab, 'i-newtab');
  }
  const uiState = await ev(ui, `typeof api + '|' + document.querySelectorAll('.tab').length + '|' + (document.getElementById('url') ? 'url' : '') + '|' + getComputedStyle(document.body).backgroundColor`);
  ok(/^object\|[1-9]\d*\|url\|/.test(uiState), 'інтерфейс: панель вкладок і адресний рядок є', uiState);

  // ---- 2. внутрішні сторінки ----
  const pages = { settings: '#app', dashboard: '.bento', help: '#app', history: '#app', bookmarks: '#app', downloads: '#app', wallet: '#app', passwords: '#app', import: '#app', profiles: '#app', assistant: '#app' };
  for (const [name, sel] of Object.entries(pages)) {
    await ev(ui, `api.cmd('openPage', '${name}')`);
    const t = await waitFor(async () => (await find(x => new RegExp('^w3ir://' + name + '/?(\\?.*)?$').test(x.url)))[0], 8000);
    let good = false, info = '';
    if (t) { await sleep(2500); info = await ev(t, `(document.querySelector('${sel}') ? document.querySelector('${sel}').children.length : -1) + '|' + document.body.innerText.length + '|' + (document.querySelector('link[rel=icon]') ? 'ico' : 'noico')`); const [kids, len, ico] = String(info).split('|'); good = +kids > 0 && +len > 20 && ico === 'ico'; }
    ok(good, `сторінка w3ir://${name}: відмальована, з фавіконом`, info || 'ціль не знайдена');
    if (name === 'dashboard' && t) { await sleep(800); await shot(t, 'i-dashboard'); }
    if (name === 'settings' && t) {
      ok(await ev(t, `!!document.querySelector('.rail') || window.innerWidth < 1320`), 'налаштування: бічна навігація (або вузьке вікно)');
      ok(/керування браузером ші/i.test(await ev(t, 'document.body.innerText')), 'налаштування: розділ керування ШІ є');
      await shot(t, 'i-settings');
    }
  }

  // ---- 3. мережа, безпека веб-сторінок ----
  await ev(ui, `api.cmd('newTab')`); await sleep(500);
  await ev(ui, `api.cmd('go', 'http://example.com')`);
  const web = await waitFor(async () => (await find(t => /^https:\/\/example\.com/.test(t.url)))[0], 15000);
  ok(!!web && /^https:\/\/example\.com/.test(web.url), 'мережа: http://example.com автоматично відкрито по https', web && web.url);
  if (web) {
    await sleep(1500);
    ok(await ev(web, `document.title`) === 'Example Domain', 'мережа: сторінка завантажена');
    const leak = await ev(web, `[typeof window.w3ir, typeof window.api, typeof window.require, typeof window.process, typeof window.electron].join(',')`);
    ok(leak === 'undefined,undefined,undefined,undefined,undefined', 'безпека: вебсторінка не бачить API браузера, Node чи Electron', leak);
    const ifr = await ev(web, `new Promise(r => { const f = document.createElement('iframe'); f.src = 'w3ir://settings'; f.onload = () => r('loaded'); f.onerror = () => r('error'); document.body.append(f); setTimeout(() => r('timeout'), 4000); })`);
    console.log('  (iframe на w3ir://settings:', ifr, ')');
    const evilAccess = await ev(web, `(async () => { try { const f = document.querySelector('iframe'); return typeof f.contentWindow.w3ir; } catch (e) { return 'blocked'; } })()`);
    ok(evilAccess === 'blocked' || evilAccess === 'undefined', 'безпека: iframe з w3ir:// не дає сторінці доступу до API', evilAccess);
  }

  // ---- 4. списки загроз і Панель ----
  const st = await (async () => { const s = (await find(t => /^w3ir:\/\/settings\/?$/.test(t.url)))[0]; return s ? await ev(s, `w3ir.invoke('safe:status')`) : null; })();
  if (st) { await waitFor(async () => { const s = (await find(t => /^w3ir:\/\/settings\/?$/.test(t.url)))[0]; const r = await ev(s, `w3ir.invoke('safe:update')`); return r && r.counts && r.counts.phishing > 1000 ? r : null; }, 90000, 1000); }
  const st2 = await (async () => { const s = (await find(t => /^w3ir:\/\/settings\/?$/.test(t.url)))[0]; return s ? await ev(s, `w3ir.invoke('safe:status')`) : null; })();
  ok(st2 && st2.counts.phishing > 100000 && st2.counts.malware >= 0 && st2.sources.length === 4, 'захист: списки (URLhaus, Phishing.Database, MetaMask, Polkadot-JS) завантажені з мережі', st2);
  const dash = (await find(t => /^w3ir:\/\/dashboard\/?$/.test(t.url)))[0];
  if (dash) {
    await ev(dash, `[...document.querySelectorAll('button')].find(b => b.textContent.includes('Перевірити мережі')).click()`);
    const greens = await waitFor(async () => { const n = await ev(dash, `document.querySelectorAll('.net .dot.ok').length`); return n >= 7 ? n : null; }, 20000);
    ok(greens >= 7, `Панель: пінг RPC — зелених вузлів ${greens || 0} з 8`);
    await sleep(500); await shot(dash, 'i-dashboard-ping');
  }

  // ---- 5. розділений екран ----
  await ev(ui, `api.cmd('splitNew')`); await sleep(1200);
  const splitTabs = await ev(ui, `document.querySelectorAll('.tab.split').length`);
  ok(splitTabs === 2, 'розділений екран: дві вкладки позначені', splitTabs);
  ok(await ev(ui, `!document.getElementById('splitbar').hidden && document.getElementById('splitbar').style.height.endsWith('px')`), 'розділений екран: межа для перетягування видима');
  await ev(ui, `api.cmd('splitDragStart')`); await sleep(300);
  await ev(ui, `api.cmd('splitDragEnd', 0.65)`); await sleep(400);
  ok(await ev(ui, `Math.abs(parseFloat(document.getElementById('splitbar').style.left) - 0.65 * (innerWidth - 6)) < 40`), 'розділений екран: нова пропорція після перетягування застосована');
  await ev(ui, `api.cmd('splitEnd')`); await sleep(500);
  ok(await ev(ui, `document.querySelectorAll('.tab.split').length`) === 0, 'розділений екран: закривається');

  // ---- 6. MCP-агент у встановленій збірці ----
  const settings = (await find(t => /^w3ir:\/\/settings\/?$/.test(t.url)))[0];
  await ev(settings, `w3ir.invoke('agent:setPort', { port: 47831 })`);
  const en = await ev(settings, `w3ir.invoke('agent:enable')`);
  ok(en && en.ok && en.running, 'ШІ: сервер MCP запускається', en);
  const tok = (await ev(settings, `w3ir.invoke('agent:token')`)).token;
  const rpc = async (method, params, headers = {}) => { const r = await fetch('http://127.0.0.1:47831/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok, ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); return { status: r.status, j: await r.json().catch(() => null) }; };
  ok((await fetch('http://127.0.0.1:47831/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status === 401, 'ШІ: без токена — 401');
  ok((await fetch('http://127.0.0.1:47831/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok, origin: 'https://evil.example' }, body: '{}' })).status === 403, 'ШІ: запит із Origin сторінки — 403');
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'cdp-test', version: '1' } });
  ok(init.j && init.j.result.serverInfo.version === V && /Спільні вкладки/.test(init.j.result.instructions), 'ШІ: initialize, версія сервера збігається, інструкції моделі');
  const lst = await rpc('tools/list');
  ok(lst.j.result.tools.length >= 18, `ШІ: інструментів ${lst.j.result.tools.length}`);
  const call = async (name, args) => (await rpc('tools/call', { name, arguments: args || {} })).j.result;
  const txt = (r) => (r.content.find(c => c.type === 'text') || {}).text || '';
  const stt = await ev(settings, `w3ir.invoke('agent:test')`);
  ok(stt.ok && stt.client && stt.client.name === 'cdp-test', 'ШІ: «Перевірити підключення» бачить клієнта', stt);

  // фонова «рука користувача»: підтверджує запити в довіреному вікні браузера, як це зробив би користувач
  let approvals = [];
  let stop = false;
  (async () => {
    while (!stop) {
      for (const t of await find(x => x.url === 'w3ir://ui/overlay.html').catch(() => [])) {
        try {
          const r = await ev(t, `(() => { const a = document.querySelector('.appr'); if (!a) return null; const title = a.querySelector('.ah').textContent; const origin = a.querySelector('.aorigin').textContent; const b = [...a.querySelectorAll('button')].find(x => x.textContent === 'Підтвердити'); b.click(); return title + ' | ' + origin; })()`);
          if (r) approvals.push(r);
        } catch { /* ignore */ }
      }
      await sleep(300);
    }
  })();

  let r = await call('browser_open', { url: 'http://localhost:8080' });
  ok(r.isError && /Локальні/.test(txt(r)), 'ШІ: локальні адреси відхилено');
  r = await call('browser_open', { url: 'https://example.com' });
  ok(!r.isError && /Example Domain/.test(txt(r)) && approvals.some(a => /example\.com/.test(a)), 'ШІ: відкриття сайту через справжнє вікно підтвердження', { r: txt(r), approvals });
  r = await call('browser_read');
  ok(/недовірені дані/.test(txt(r)) && /Example Domain/.test(txt(r)), 'ШІ: читання сторінки з позначкою недовірених даних');
  r = await call('browser_screenshot');
  ok(r.content.some(c => c.type === 'image' && c.data.length > 3000), 'ШІ: скріншот');
  // справжня форма входу: паролі заборонені
  r = await call('browser_open', { url: 'https://github.com/login' });
  const snapTxt = txt(await call('browser_snapshot'));
  const items = JSON.parse(snapTxt.split('\n').pop());
  const pw = items.find(i => i.type === 'password'), login = items.find(i => i.name && /username|email/i.test(i.name));
  ok(!!pw && !!login, 'ШІ: на github.com/login знайдено поля входу', items.slice(0, 5));
  if (pw) { const x = await call('browser_type', { ref: pw.ref, text: 'secret' }); ok(x.isError && /паролів/.test(txt(x)), 'ШІ: ввід у справжнє поле пароля заборонено'); }
  if (login) { const x = await call('browser_type', { ref: login.ref, text: 'test-user' }); ok(!x.isError, 'ШІ: ввід у звичайне поле (логін) працює'); }
  const tabsAgent = JSON.parse(txt(await call('browser_tabs')));
  ok(tabsAgent.length >= 2, 'ШІ: вкладки вікна агента', tabsAgent.length);
  const agentUi = (await find(t => t.url === 'w3ir://ui/index.html')).length;
  ok(agentUi === 2, 'ШІ: окреме вікно агента створене (2 вікна інтерфейсу)', agentUi);
  await sleep(500);
  const incogLabel = await (async () => { for (const t of await find(x => x.url === 'w3ir://ui/index.html')) { const v = await ev(t, `document.getElementById('incog') && !document.getElementById('incog').hidden ? document.getElementById('incog').textContent : ''`); if (v) return v; } return ''; })();
  ok(incogLabel === 'Керує ШІ', 'ШІ: у вікні агента значок «Керує ШІ»', incogLabel);

  // ---- спільна вкладка користувача (головне вікно) ----
  await ev(ui, `api.cmd('newTab')`); await sleep(500);
  await ev(ui, `api.cmd('go', 'https://example.com')`);
  await waitFor(async () => (await ev(ui, `document.querySelector('.tab.active .title') && document.querySelector('.tab.active .title').textContent`)) === 'Example Domain', 15000);
  const activeId = await ev(ui, `Number(document.querySelector('.tab.active').dataset.id)`);
  ok(activeId > 0, 'спільна вкладка: id активної вкладки видно в DOM', activeId);
  await ev(ui, `api.cmd('aiShare', { id: ${activeId}, mode: 'read' })`);
  const sh = await waitFor(async () => JSON.parse(txt(await call('browser_tabs'))).find(t => t.scope === 'shared'), 10000);
  ok(sh && sh.mode === 'read', 'спільна вкладка: після підтвердження ШІ бачить вкладку (читання)', sh);
  if (sh) {
    ok(await waitFor(async () => (await ev(ui, `!!document.querySelector('.tab.active .ai')`)) || null, 5000), 'спільна вкладка: на вкладці значок «ШІ»'); // інтерфейс оновлюється асинхронно
    r = await call('browser_read', { tab: sh.id });
    ok(/Example Domain/.test(txt(r)), 'спільна вкладка: читання вмісту вкладки користувача');
    r = await call('browser_snapshot', { tab: sh.id });
    const sitems = JSON.parse(txt(r).split('\n').pop());
    const link = sitems.find(i => i.tag === 'a');
    r = await call('browser_click', { ref: link.ref, tab: sh.id });
    ok(r.isError && /лише для читання/.test(txt(r)), 'спільна вкладка: у режимі читання клік відхиляється');
    await ev(ui, `api.cmd('aiShare', { id: ${activeId}, mode: 'control' })`);
    const up = await waitFor(async () => JSON.parse(txt(await call('browser_tabs'))).find(t => t.scope === 'shared' && t.mode === 'control'), 10000);
    ok(up && up.id === sh.id, 'спільна вкладка: зміна рівня доступу лишає той самий id', up);
    r = await call('browser_snapshot', { tab: sh.id });
    const l2 = JSON.parse(txt(r).split('\n').pop()).find(i => i.tag === 'a');
    await call('browser_click', { ref: l2.ref, tab: sh.id });
    const moved = await waitFor(async () => (await find(t => /^https:\/\/(www\.)?iana\.org/.test(t.url)))[0], 12000);
    ok(!!moved && approvals.some(a => /iana\.org/.test(a)), 'спільна вкладка: у режимі керування клік виконано; перехід на інший сайт пройшов через підтвердження', approvals.slice(-3));
    await ev(ui, `api.cmd('aiUnshare', ${activeId})`); await sleep(500);
    ok(!JSON.parse(txt(await call('browser_tabs'))).some(t => t.scope === 'shared'), 'спільна вкладка: «припинити» одразу знімає доступ');
  }

  // ---- темна тема ----
  await ev(settings, `w3ir.invoke('settings:set', { theme: 'dark' })`); await sleep(1500);
  const bgUi = await ev(ui, `getComputedStyle(document.body).backgroundColor`);
  ok(bgUi === 'rgb(16, 20, 26)', 'дизайн: темна тема — фон інтерфейсу Obsidian (#10141A)', bgUi);
  await shot(ui, 'i-dark-ui');

  // ---- вкладки: закриття повільним кліком і вигляд закріпленої вкладки ----
  await ev(ui, `api.cmd('newTab')`); await sleep(500);
  await ev(ui, `api.cmd('newTab')`); await sleep(900);
  const pos = await ev(ui, `(() => { const e = document.querySelector('.tab:last-of-type .close'); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, n: document.querySelectorAll('.tab').length }; })()`);
  await slowClick(ui, pos.x, pos.y, 150); await sleep(800);
  const nAfter = await ev(ui, `document.querySelectorAll('.tab').length`);
  ok(nAfter === pos.n - 1, 'вкладки: хрестик закриває вкладку при звичайному (повільному) кліку миші', { було: pos.n, стало: nAfter });
  const pinId = await ev(ui, `Number(document.querySelector('.tab:last-of-type').dataset.id)`);
  await ev(ui, `api.cmd('pinTab', ${pinId})`); await sleep(900);
  const pinStyle = await ev(ui, `(() => { const e = document.querySelector('.tab.pinned'); if (!e) return null; const s = getComputedStyle(e); return { bg: s.backgroundColor, img: s.backgroundImage, shadow: s.boxShadow }; })()`);
  ok(pinStyle && (pinStyle.bg !== 'rgba(0, 0, 0, 0)' || pinStyle.img !== 'none') && pinStyle.shadow !== 'none', 'вкладки: закріплена вкладка помітна (має фон і рамку, не зливається з тлом)', pinStyle);
  await shot(ui, 'i-pinned');
  await sleep(500);
  stop = true;
  const mainUi = (await find(t => t.url === 'w3ir://ui/index.html'))[0];
  await shot(mainUi, 'i-main-ui');

  console.log(`\nРЕЗУЛЬТАТ: ${pass} пройдено, ${fail} провалено`);
  try { const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); const c = await cdp(v.webSocketDebuggerUrl); await c.send('Browser.close'); } catch { /* ignore */ }
  process.exit(0);
})().catch((e) => { console.log('ПОМИЛКА ТЕСТУ', e && e.stack || e); process.exit(1); });
