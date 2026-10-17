'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { app } = require('electron');
const { Vault } = require('../../src/vault');
const { ok, sleep, tmp } = require('../lib');

async function auditTests(ctx) {
  const { writeAtomic } = require('../../src/crypto-util');
  const { Store } = require('../../src/store');
  const { Downloads } = require('../../src/downloads');
  const { Agent, isPrivateAddress } = require('../../src/agent');
  const { dialog, shell } = require('electron');
  const corrupt = (dir, base) => fs.readdirSync(dir).filter(f => f.startsWith(base + '.corrupt-'));

  // --- запис файлів: fsync, .bak, відновлення ---
  const d1 = tmp('audit');
  const f1 = path.join(d1, 'a.bin');
  writeAtomic(fs, f1, 'v1', { backup: true }); writeAtomic(fs, f1, 'v2', { backup: true });
  ok(fs.readFileSync(f1, 'utf8') === 'v2' && fs.readFileSync(f1 + '.bak', 'utf8') === 'v1' && !fs.existsSync(f1 + '.tmp'), 'audit: запис файлу атомарний із резервною копією попередньої версії');
  const s0 = new Store('t0', { a: 1 }, d1);
  ok(s0.recovered === '' && s0.data.a === 1, 'audit: перший запуск (файлу немає) — без повідомлень про пошкодження');
  const s1 = new Store('t1', { a: 1 }, d1);
  s1.data.a = 2; s1.flush(); s1.data.a = 3; s1.flush();
  ok(JSON.parse(fs.readFileSync(path.join(d1, 't1.json'), 'utf8')).a === 3 && JSON.parse(fs.readFileSync(path.join(d1, 't1.json.bak'), 'utf8')).a === 2, 'audit: Store зберігає резервну копію попередньої версії');
  fs.writeFileSync(path.join(d1, 't1.json'), '{"a":'); // обрізаний запис
  const s1b = new Store('t1', { a: 1 }, d1);
  ok(s1b.recovered === 'backup' && s1b.data.a === 2 && corrupt(d1, 't1.json').length === 1 && JSON.parse(fs.readFileSync(path.join(d1, 't1.json'), 'utf8')).a === 2, 'audit: пошкоджений Store відновлюється з резервної копії, зіпсований файл зберігається окремо');
  fs.writeFileSync(path.join(d1, 't2.json'), 'не json');
  const s2 = new Store('t2', { x: 5 }, d1);
  ok(s2.recovered === 'defaults' && s2.data.x === 5 && corrupt(d1, 't2.json').length === 1, 'audit: без копії пошкоджений файл не стирається, а зберігається поруч (дані за замовчуванням)');

  // --- сховище паролів: відновлення з .bak лише при непрочитному JSON, підміна відхиляється ---
  const dv = tmp('auditvault');
  const v = new Vault({ dir: dv, autolockMinutes: 15 });
  await v.create('Correct-Horse-9-Battery');
  v.add({ url: 'https://one.example.com', username: 'u1', password: 'p1' });
  v.add({ url: 'https://two.example.com', username: 'u2', password: 'p2' });
  ok(fs.existsSync(path.join(dv, 'vault.bin.bak')), 'audit: сховище паролів має резервну копію попередньої версії');
  v.lock();
  const full = fs.readFileSync(path.join(dv, 'vault.bin'));
  fs.writeFileSync(path.join(dv, 'vault.bin'), full.slice(0, Math.floor(full.length / 2))); // обрізаний запис
  v.nextAllowed = 0;
  const rr = await v.unlock('Correct-Horse-9-Battery');
  ok(rr.ok && v.recoveredFromBackup && v.list().length >= 1 && corrupt(dv, 'vault.bin').length === 1, 'audit: обрізаний vault.bin відновлено з резервної копії (паролі не втрачено), зіпсований файл збережено');
  v.lock();

  // --- завантаження: виконувані файли — лише з підтвердженням ---
  ok(['a.exe', 'B.BAT', 'x.lnk', 'setup.msi', 'r.ps1', 'a.js', 'disk.iso', 'x.hta', 'photo.jpg.exe'].every(n => Downloads.isRisky(n)) && !['a.pdf', 'photo.jpg', 'notes.txt', 'archive.zip', 'doc.docx', 'exe.txt'].some(n => Downloads.isRisky(n)), 'audit: розпізнавання виконуваних розширень (без хибних спрацювань на безпечні)');
  const od = dialog.showMessageBox, op = shell.openPath;
  let asked = 0, opened = [], answer = 1;
  dialog.showMessageBox = async () => { asked++; return { response: answer }; };
  shell.openPath = async (p) => { opened.push(p); return ''; };
  try {
    ctx.downloads.store.data.push({ id: 'audit-exe', filename: 'setup.exe', path: 'C:\\fake\\setup.exe', state: 'completed', received: 1, total: 1, start: Date.now() });
    ctx.downloads.store.data.push({ id: 'audit-pdf', filename: 'doc.pdf', path: 'C:\\fake\\doc.pdf', state: 'completed', received: 1, total: 1, start: Date.now() });
    ctx.downloads.action('audit-exe', 'open'); await sleep(150);
    ok(asked === 1 && opened.length === 0, 'audit: відкриття .exe питає підтвердження (за замовчуванням — «Скасувати») і без згоди не запускається');
    ctx.downloads.action('audit-pdf', 'open'); await sleep(150);
    ok(asked === 1 && opened.length === 1 && /doc\.pdf$/.test(opened[0]), 'audit: безпечний файл відкривається без запитання');
    answer = 0; ctx.downloads.action('audit-exe', 'open'); await sleep(150);
    ok(asked === 2 && opened.length === 2 && /setup\.exe$/.test(opened[1]), 'audit: після підтвердження .exe запускається');
  } finally {
    dialog.showMessageBox = od; shell.openPath = op;
    ctx.downloads.store.data = ctx.downloads.store.data.filter(d => !String(d.id).startsWith('audit-'));
  }

  // --- IPC: команда доступна лише своїй сторінці ---
  const w = [...ctx.windows].find(x => !x.incognito && !x.agent);
  const probe = async (page, expr) => {
    const t = w.createTab('w3ir://' + page, { activate: false });
    await sleep(1400);
    const r = await t.view.webContents.executeJavaScript(`(${expr}).then(() => 'ok', () => 'denied')`);
    w.closeTab(t.id);
    return r;
  };
  const inv = (n, a) => `w3ir.invoke('${n}', ${JSON.stringify(a || {})})`;
  ok(await probe('history', inv('settings:set', { sendGpc: false })) === 'denied' && await probe('history', inv('clear', { cookies: true })) === 'denied' && await probe('bookmarks', inv('ext:add')) === 'denied' && await probe('downloads', inv('settings:get')) === 'denied', 'audit: settings:set, clear, ext:add, settings:get недоступні сторінкам історії, закладок і завантажень');
  ok(await probe('settings', inv('settings:get')) === 'ok' && await probe('help', inv('settings:get')) === 'ok' && await probe('newtab', inv('topsites')) === 'ok' && await probe('history', inv('history:get', {})) === 'ok', 'audit: власні команди сторінок працюють (налаштування, довідка, нова вкладка, історія)');
  ok(await probe('history', inv('reader:get')) === 'denied' && await probe('newtab', inv('history:clear')) === 'denied' && await probe('settings', inv('topsites')) === 'denied', 'audit: чужі команди відхиляються (reader:get з історії, history:clear з нової вкладки)');

  // --- режим читання: білий список ---
  const tr = w.createTab('w3ir://newtab', { activate: false });
  tr.reader = { title: 'Т', url: 'https://e.example/', content: '<p onclick="x()" style="color:red">текст</p><script>window.__x=1</script><form action="http://e"><input name="p"></form><a href="javascript:alert(1)">лінк1</a><a href="https://ok.example/">лінк2</a><img src="x" onerror="alert(1)"><img src="https://e.example/i.png" alt="i"><custom-el>вміст</custom-el><svg><circle></circle></svg><iframe src="https://e.example"></iframe><base href="http://evil/"><meta http-equiv="refresh" content="0;url=http://evil/">' + '<p>' + 'я'.repeat(300) + '</p>' };
  tr.view.webContents.loadURL('w3ir://reader').catch(() => {});
  await sleep(1800);
  const dom = await tr.view.webContents.executeJavaScript(`(() => { const all = [...document.querySelectorAll('#app *')]; const art = document.getElementById('app'); return { bad: art.querySelectorAll('script,form,input,svg,iframe,base,meta,custom-el').length, on: all.some(e => [...e.attributes].some(a => /^on|^style$/i.test(a.name))), js: [...art.querySelectorAll('a')].some(a => /^javascript:/i.test(a.getAttribute('href') || '')), text: art.innerText.includes('вміст') && art.innerText.includes('лінк1'), ok: !!art.querySelector('a[href="https://ok.example/"][rel~="noopener"]'), badSrc: [...art.querySelectorAll('img')].some(i => i.getAttribute('src') === 'x'), good: !!art.querySelector('img[src="https://e.example/i.png"]') }; })()`);
  ok(dom.bad === 0 && !dom.on && !dom.js && dom.text && dom.ok && !dom.badSrc && dom.good, 'audit: режим читання — білий список (скрипти, форми, svg, iframe, обробники, javascript: прибрано; текст і безпечні посилання/зображення збережено)', dom);
  w.closeTab(tr.id);

  // --- ШІ: DNS-перевірка ---
  ok(['127.0.0.1', '10.1.2.3', '192.168.0.9', '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '100.64.0.1'].every(isPrivateAddress) && !['8.8.8.8', '93.184.216.34', '2606:4700::1111', '::ffff:8.8.8.8'].some(isPrivateAddress), 'audit: розпізнавання локальних і приватних IP-адрес (IPv4, IPv6, відображені)');
  const ag = new Agent({ ctx, dir: tmp('auditdns'), port: 47999 });
  ag.resolver = async () => [{ address: '127.0.0.1', family: 4 }];
  let err = '';
  try { await ag.ensureSite({ requestApproval: async () => ({ approved: true }) }, 'rebind.example'); } catch (e) { err = e.message; }
  ok(/DNS/.test(err) && !ag.allowed.has('rebind.example'), 'audit: ШІ: домен, що через DNS вказує на 127.0.0.1, відхиляється до запиту користувачу');
  ag.resolver = async () => [{ address: '93.184.216.34', family: 4 }];
  ok(await ag.ensureSite({ requestApproval: async () => ({ approved: true }) }, 'public.example') === true && ag.allowed.has('public.example'), 'audit: ШІ: домен із публічною адресою проходить далі до підтвердження користувачем');

  // --- спливаючі вікна: походження в заголовку, лише http(s) ---
  const srv = http.createServer((q, r) => { r.setHeader('content-type', 'text/html; charset=utf-8'); r.end('<!doctype html><title>Вхід у банк</title><p>x</p>'); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const tp = w.createTab(base, { activate: true });
  await sleep(1500);
  let popup = null;
  app.once('browser-window-created', (e, win) => { popup = win; });
  await tp.view.webContents.executeJavaScript(`window.open('${base}pop', '_blank', 'popup,width=320,height=240'); 1`, true);
  await sleep(2200);
  ok(popup && popup.getTitle().startsWith(`127.0.0.1:${srv.address().port} — `) && /Вхід у банк/.test(popup.getTitle()), 'audit: спливаюче вікно показує в заголовку справжнє походження (сайт не може його підробити)', popup && popup.getTitle());
  if (popup) {
    await popup.webContents.executeJavaScript(`location.href = 'file:///C:/Windows/win.ini'; 1`).catch(() => {});
    await sleep(900);
    ok(/^http:/.test(popup.webContents.getURL()), 'audit: спливаюче вікно не може перейти на file:// (лише http/https)', popup.webContents.getURL());
    popup.destroy();
  }
  const nTabs = w.tabs.length;
  await tp.view.webContents.executeJavaScript(`window.open('${base}plain'); 1`, true);
  await sleep(1200);
  ok(w.tabs.length === nTabs + 1, 'audit: звичайне window.open і далі відкриває вкладку');
  w.closeTab(tp.id);
  srv.close();

  // --- зовнішні схеми: одне підтвердження за раз ---
  let ext = 0, resolveExt = null;
  dialog.showMessageBox = () => { ext++; return new Promise((r) => { resolveExt = r; }); };
  try {
    w.openExternal('vscode://file/audit'); w.openExternal('vscode://file/audit2'); w.openExternal('vscode://file/audit3');
    ok(ext === 1, 'audit: сторінка не може засипати діалогами зовнішніх програм (одне підтвердження за раз)', ext);
    resolveExt({ response: 1 }); await sleep(100);
    w.openExternal('vscode://file/audit4');
    ok(ext === 2, 'audit: після відповіді можна відкрити наступне підтвердження');
    resolveExt({ response: 1 }); await sleep(100);
  } finally { dialog.showMessageBox = od; }

  // --- статичні перевірки ---
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');
  const ipcSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'ipc.js'), 'utf8');
  ok(/!app\.isPackaged && process\.env\.W3IR_SMOKE/.test(mainSrc), 'audit: тестовий хук W3IR_SMOKE не підключається в упакованій збірці');
  ok(/allowFileAccess: false/.test(ipcSrc) && !/allowFileAccess: true/.test(ipcSrc) && !/allowFileAccess: true/.test(mainSrc), 'audit: розпаковані розширення не отримують доступ до файлової системи');
}

async function webauthnTests(ctx) {
  const srv = http.createServer((q, r) => { r.setHeader('content-type', 'text/html; charset=utf-8'); r.end('<!doctype html><title>wa</title><p>x</p>'); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const w = [...ctx.windows].find(x => !x.incognito && !x.agent);
  const tab = w.createTab(`http://localhost:${srv.address().port}/`, { activate: true });
  await sleep(2200);
  const wc = tab.view.webContents;
  const toasts = [];
  const origToast = w.toast.bind(w);
  w.toast = (t) => { toasts.push(t); };
  w._waToast = 0;
  const attempt = () => wc.executeJavaScript(`navigator.credentials.create({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rp: { id: 'localhost', name: 't' }, user: { id: new Uint8Array([1]), name: 'u', displayName: 'U' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], timeout: 5000 } }).then(() => 'ok', (e) => e.name)`, true);
  const t0 = Date.now();
  const r1 = await attempt();
  const took = Date.now() - t0;
  await sleep(600);
  ok(r1 === 'NotAllowedError' && took < 1500, 'webauthn: запит passkey відхиляється одразу (а не висить до таймауту сайту) з NotAllowedError, тож сайт швидко пропонує пароль', { r1, took });
  {
    ok(toasts.length === 1 && /Passkeys/.test(toasts[0]), 'webauthn: користувач бачить пояснення замість мовчазної помилки сайту', toasts);
    await attempt(); await sleep(800);
    ok(toasts.length === 1, 'webauthn: підказка не повторюється частіше, ніж раз на 30 с');
  }
  const api = await wc.executeJavaScript(`typeof PublicKeyCredential + '|' + typeof navigator.credentials.get `);
  ok(api === 'function|function', 'webauthn: API на сторінці лишається на місці (обгортка не ламає навігатор)', api);
  w.toast = origToast;
  w.closeTab(tab.id);
  srv.close();
}

async function ipcPolicyTests() {
  const { permitted } = require('../../src/ipc');
  const cases = [
    // [команда, адреса, очікується]
    ['wallet:status', 'w3ir://wallet', true], ['wallet:status', 'w3ir://wallet/', true], ['wallet:status', 'w3ir://passwords', false], ['wallet:reveal', 'w3ir://settings', false],
    ['wallet:status', 'w3ir://wallet?x=1', false], ['wallet:status', 'http://wallet/', false], ['wallet:status', 'w3ir://wallet.evil', false], ['wallet:status', 'w3ir://wallet/../settings', false],
    ['vault:list', 'w3ir://passwords', true], ['vault:reveal', 'w3ir://wallet', false], ['vault:status', 'w3ir://wallet', true], ['vault:unlock', 'w3ir://wallet', true],
    ['vault:importCsv', 'w3ir://import', true], ['vault:list', 'w3ir://import', false], ['vault:status', 'w3ir://settings', false],
    ['safe:proceed', 'w3ir://warning?url=http%3A%2F%2Fx', true], ['safe:trust', 'w3ir://warning', true], ['safe:proceed', 'w3ir://settings', false], ['safe:status', 'w3ir://settings', true], ['safe:update', 'w3ir://warning', false],
    ['agent:enable', 'w3ir://settings', true], ['agent:enable', 'w3ir://dashboard', false], ['dashboard:agent', 'w3ir://dashboard', true], ['dashboard:agent', 'w3ir://settings', false],
    ['sync:enable', 'w3ir://settings', true], ['github:connect', 'w3ir://history', false], ['update:install', 'w3ir://settings', true], ['sites:list', 'w3ir://settings', true], ['sites:list', 'w3ir://help', false],
    ['profiles:create', 'w3ir://profiles', true], ['profiles:remove', 'w3ir://settings', false], ['import:run', 'w3ir://import', true], ['import:run', 'w3ir://newtab', false],
    ['settings:set', 'w3ir://settings', true], ['settings:set', 'w3ir://history', false], ['settings:set', 'w3ir://error?code=1', false], ['settings:get', 'w3ir://help', true], ['settings:get', 'w3ir://help#faq', true],
    ['clear', 'w3ir://settings', true], ['clear', 'w3ir://reader', false], ['ext:add', 'w3ir://bookmarks', false], ['reader:get', 'w3ir://reader', true], ['reader:get', 'w3ir://newtab', false],
    ['wallet:importKey', 'w3ir://wallet', true], ['wallet:importKey', 'w3ir://settings', false], ['wallet:revealKey', 'w3ir://newtab', false], ['wallet:removeImported', 'w3ir://history', false], ['wallet:qr', 'w3ir://wallet', true], ['wallet:qr', 'w3ir://newtab', false],
    ['wallet:replace', 'w3ir://wallet', true], ['wallet:replace', 'w3ir://history', false], ['wallet:revoke', 'w3ir://newtab', false], ['wallet:addContact', 'w3ir://settings', false], ['wallet:resolveName', 'w3ir://wallet', true],
    ['vault:lock', 'w3ir://wallet', true], ['vault:lock', 'w3ir://history', false], ['wallet:send', 'w3ir://wallet', true], ['wallet:send', 'w3ir://newtab', false], ['wallet:rename', 'w3ir://wallet', true],
    ['assistant:run', 'w3ir://assistant', true], ['assistant:run', 'w3ir://settings', false], ['assistant:run', 'w3ir://assistant?x=1', false], ['assistant:share', 'w3ir://history', false],
    ['history:get', 'w3ir://history?q=a', true], ['history:clear', 'w3ir://history', true], ['history:clear', 'w3ir://newtab', false], ['downloads:action', 'w3ir://downloads', true], ['downloads:action', 'w3ir://history', false],
    ['topsites', 'w3ir://newtab', true], ['resolve', 'w3ir://newtab', true], ['resolve', 'w3ir://settings', false],
    ['settings:get', '', false], ['settings:get', undefined, false], ['settings:get', 'file:///C:/x.html', false],
  ];
  const bad = cases.filter(([n, u, exp]) => permitted(n, u) !== exp).map(([n, u, exp]) => `${n} @ ${u} → очікувалось ${exp}`);
  ok(bad.length === 0, `ipc: єдина таблиця прав — ${cases.length} випадків (команда × сторінка) поводяться правильно`, bad);
  // кожна група команд із клієнтських сторінок має запис у таблиці (щоб нова група не лишилась без правил)
  const fs2 = require('fs');
  const used = new Set();
  for (const f of fs2.readdirSync(path.join(__dirname, '..', '..', 'pages')).filter(x => x.endsWith('.js'))) {
    const t = fs2.readFileSync(path.join(__dirname, '..', '..', 'pages', f), 'utf8');
    for (const m of t.matchAll(/(?:w3ir\.invoke|call)\('([a-zA-Z]+(?::[a-zA-Z]+)?)'/g)) used.add(f.replace('.js', '') + ' ' + m[1]);
  }
  const denied = [...used].filter(x => { const [page, name] = x.split(' '); return !permitted(name, 'w3ir://' + page); });
  ok(denied.length === 0, 'ipc: кожна команда, яку викликає сторінка, дозволена цій самій сторінці (таблиця не розходиться з кодом сторінок)', denied);
}

async function historySearchTests(ctx) {
  const { queryMatcher } = require('../../src/util');
  const m = queryMatcher('  Ціна  ЛІТО ');
  ok(m('Літо: ціна квитків', 'https://x.ua/a') && m('ЦІНА', 'https://літо.ua') && !m('Літо', 'https://x.ua') && queryMatcher('')('a', 'b') && queryMatcher(null)('a', 'b'), 'пошук: кілька слів у будь-якому порядку й регістрі (назва + адреса), порожній запит збігається з усім');
  const { Places } = require('../../src/places');
  const saved = ctx.places;
  const tp = new Places(tmp('suggest-places'));
  tp.addVisit('https://shop.example/phones/iphone', 'Купити iPhone дешево', 1000);
  tp.addVisit('https://news.example/iphone', 'Новини про телефони', 2000);
  ctx.places = tp;
  const r = ctx.suggest('iphone купити').filter(x => x.type === 'history');
  ctx.places = saved;
  tp.close();
  ok(r.length === 1 && r[0].url.includes('shop.example'), 'пошук: підказки адресного рядка шукають за кількома словами');
}

async function designTests() {
  const root = path.join(__dirname, '..', '..');
  const css = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  ok(['ui/style.css', 'ui/overlay.css', 'pages/pages.css'].every(f => css(f).includes('Фірмовий стиль W3IR')) && /--bg2: #1c1947/.test(css('ui/style.css')) && /--panel: #1c1947/.test(css('ui/overlay.css')) && /--bg: #0e0d24/.test(css('pages/pages.css')), 'design: інтерфейс, меню й сторінки в фірмових кольорах (індиго)');
  ok(/\.tab\.pinned \{[^}]*box-shadow: inset 0 0 0 1px/.test(css('ui/style.css')) && /\.tab\.pinned::after/.test(css('ui/style.css')) && /\.tab\.pinned:hover \.close/.test(css('ui/style.css')) && /pinletter/.test(css('ui/renderer.js')), 'design: закріплені вкладки помітні (фон, рамка, індикатор, літера-значок, хрестик при наведенні)');
  ok(/body\.incog \{[^}]*--accent: #d946ef/.test(css('ui/style.css')) && /\.rail \{/.test(css('pages/pages.css')) && css('pages/settings.js').includes('buildRail'), 'design: інкогніто лишається окремим; налаштування мають бічну навігацію');
}

async function brandTests() {
  const root = path.join(__dirname, '..', '..');
  const png = (f) => { const b = fs.readFileSync(path.join(root, f)); return b.slice(1, 4).toString() === 'PNG' ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20), alpha: b[25] === 6 } : null; };
  const icon = png('build/icon.png');
  ok(icon && icon.w === 256 && icon.h === 256 && icon.alpha, 'brand: значок застосунку 256x256 із прозорістю');
  ok(['pages/brand-mark.png', 'pages/brand-wordmark.png', 'pages/brand-favicon.png', 'build/brand/icon-512.png'].every(f => png(f)), 'brand: знак, вордмарк, фавікон і великий значок на місці');
  const bmp = (f) => { const b = fs.readFileSync(path.join(root, f)); return b.slice(0, 2).toString() === 'BM' ? { w: b.readInt32LE(18), h: b.readInt32LE(22), bpp: b.readUInt16LE(28) } : null; };
  const sb = bmp('build/installerSidebar.bmp'), hd = bmp('build/installerHeader.bmp');
  ok(sb && sb.w === 164 && sb.h === 314 && sb.bpp === 24 && hd && hd.w === 150 && hd.h === 57 && hd.bpp === 24, 'brand: зображення NSIS — 24-бітні BMP потрібних розмірів');
  const pkg = require('../../package.json');
  ok(pkg.build.nsis.installerSidebar === 'build/installerSidebar.bmp' && pkg.build.nsis.installerHeader === 'build/installerHeader.bmp' && fs.existsSync(path.join(root, 'build/brand/concept-logo.jpg')), 'brand: інсталятор підключає зображення, джерело концепції збережене');
  const pages = fs.readdirSync(path.join(root, 'pages')).filter(f => f.endsWith('.html'));
  ok(pages.every(f => fs.readFileSync(path.join(root, 'pages', f), 'utf8').includes('brand-favicon.png')) && fs.readFileSync(path.join(root, 'pages/newtab.js'), 'utf8').includes('brand-wordmark.png'), 'brand: усі внутрішні сторінки мають фавікон, нова вкладка — вордмарк');
}

async function dashboardTests(ctx) {
  const { pingNetworks } = require('../../src/dashboard');
  const rpc = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      if (req.url === '/slow') return;
      if (req.url === '/err') { res.statusCode = 500; return res.end('{}'); }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: req.url === '/wrong' ? '0x2' : '0x1' }));
    });
  });
  await new Promise(r => rpc.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${rpc.address().port}`;
  const nets = ['ok', 'wrong', 'err', 'slow'].map(n => ({ chainId: 1, name: n, rpc: base + '/' + n })).concat([{ chainId: 1, name: 'evil', rpc: 'http://evil.example/x' }]);
  const r = await pingNetworks(nets, { timeout: 700 });
  ok(r[0].ok && r[0].ms >= 0 && !r[1].ok && r[1].error === 'інший chainId' && !r[2].ok && r[2].error === 'HTTP 500' && !r[3].ok && r[3].error === 'тайм-аут' && !r[4].ok && /небезпечна/.test(r[4].error), 'dashboard: пінг RPC — правильний chainId, помилки, тайм-аут, небезпечна адреса');
  const rf = await pingNetworks([{ chainId: 1, name: 'f1', rpc: base + '/err', rpcFallback: [base + '/ok'] }, { chainId: 1, name: 'f2', rpc: base + '/err', rpcFallback: [base + '/wrong'] }], { timeout: 700 });
  ok(rf[0].ok === true && rf[0].fallback === true && rf[1].ok === false && rf[1].error === 'інший chainId', 'dashboard: мережа зелена, якщо відповідає запасний вузол (позначка fallback); якщо не відповідає жоден — помилка');
  rpc.closeAllConnections(); rpc.close();

  const w = [...ctx.windows].find(x => !x.incognito);
  const tab = w.createTab('w3ir://dashboard', { activate: true });
  await sleep(1800);
  const wc = tab.view.webContents;
  const st = await wc.executeJavaScript(`w3ir.invoke('dashboard:state')`);
  ok(st && st.ok && st.protection && st.wallet && Array.isArray(st.networks) && Array.isArray(st.events) && st.agent, 'dashboard: стан відображається зі сторінки панелі');
  ok(!/mnemonic|phrase|token|privateKey/i.test(JSON.stringify(st)), 'dashboard: у відповіді немає токенів і секретів гаманця');
  ok(await wc.executeJavaScript(`document.querySelectorAll('.bento .bcard').length`) === 4, 'dashboard: сторінка малює чотири картки');
  const cp = await wc.executeJavaScript(`w3ir.invoke('dashboard:copy', { address: '0x0000000000000000000000000000000000000001' })`);
  ok(cp && cp.ok === false, 'dashboard: копіюються лише адреси власних рахунків');
  tab.view.webContents.loadURL('w3ir://history').catch(() => {});
  await sleep(1500);
  const denied = await wc.executeJavaScript(`w3ir.invoke('dashboard:state').then(() => 'allowed', () => 'denied')`);
  ok(denied === 'denied', 'dashboard: з інших внутрішніх сторінок доступ заборонено');
  w.closeTab(tab.id);
}

// Провайдер із запасними вузлами: мертвий вузол, повільний, помилка виконання (не повторюється), «вже відома» транзакція
async function failoverTests() {
  const { FailoverProvider } = require('../../src/rpc-failover');
  const { Network, keccak256 } = require('ethers');
  const hits = { a: 0, b: 0, c: 0 };
  let sendMode = 'ok';
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(body); const node = req.url.slice(1); hits[node]++;
      if (node === 'a') return; // «повільний»: не відповідає
      res.setHeader('content-type', 'application/json');
      const r = (o) => res.end(JSON.stringify(Object.assign({ jsonrpc: '2.0', id: j.id }, o)));
      if (j.method === 'eth_blockNumber') return r({ result: node === 'b' ? '0x10' : '0x20' });
      if (j.method === 'eth_call') return r({ error: { code: 3, message: 'execution reverted' } });
      if (j.method === 'eth_sendRawTransaction') return sendMode === 'known' ? r({ error: { code: -32000, message: 'already known' } }) : r({ result: keccak256(j.params[0]) });
      r({ result: '0x1' });
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const dead = 'http://127.0.0.1:1';
  const net = Network.from(1);
  const p = new FailoverProvider([dead, base + '/b', base + '/c'], net, { timeout: 800 });
  const bn1 = await p.getBlockNumber();
  const first = p.activeUrl;
  const bn2 = await p.getBlockNumber();
  const okFail = bn1 === 16 && bn2 === 16 && first === base + '/b' && hits.b >= 1 && hits.c === 0;
  // повільний першим: тайм-аут, потім наступний
  const p2 = new FailoverProvider([base + '/a', base + '/b'], net, { timeout: 500 });
  const bn3 = await p2.getBlockNumber();
  // помилка виконання контракту — відповідь вузла, а не відмова: запасні не опитуються
  const before = hits.c;
  const p3 = new FailoverProvider([base + '/b', base + '/c'], net, { timeout: 800 });
  let reverted = false;
  try { await p3.call({ to: '0x0000000000000000000000000000000000000001', data: '0x' }); } catch (e) { reverted = /revert/i.test(e.message); }
  // усі вузли недоступні — помилка, а не зависання
  const p4 = new FailoverProvider([dead, 'http://127.0.0.1:2'], net, { timeout: 500 });
  let allDead = false;
  try { await p4.getBlockNumber(); } catch { allDead = true; }
  // повторна розсилка: перший вузол мовчить, запасний каже «вже відома» → успіх із хешем транзакції
  sendMode = 'known';
  const raw = '0x02f8aa';
  const p5 = new FailoverProvider([base + '/a', base + '/b'], net, { timeout: 400 });
  const resp = await p5._send({ id: 7, jsonrpc: '2.0', method: 'eth_sendRawTransaction', params: [raw] });
  const known = resp[0].result === keccak256(raw) && !resp[0].error;
  // але «вже відома» від першого (основного) вузла лишається помилкою
  const p6 = new FailoverProvider([base + '/b'], net, { timeout: 400 });
  const resp6 = await p6._send({ id: 8, jsonrpc: '2.0', method: 'eth_sendRawTransaction', params: [raw] });
  const direct = !!resp6[0].error;
  srv.closeAllConnections(); srv.close();
  return okFail && bn3 === 16 && reverted && hits.c === before && allDead && known && direct;
}

async function rpcListTests() {
  const { BUILTIN_NETWORKS, isSafeRpc } = require('../../src/wallet');
  ok(BUILTIN_NETWORKS.every(n => isSafeRpc(n.rpc) && n.rpc.startsWith('https://') && !/key|token|\$\{/i.test(n.rpc)), 'wallet: вбудовані RPC — https, без ключів у адресі');
  ok(new Set(BUILTIN_NETWORKS.map(n => n.chainId)).size === BUILTIN_NETWORKS.length && new Set(BUILTIN_NETWORKS.map(n => n.rpc)).size === BUILTIN_NETWORKS.length, 'wallet: chainId і RPC вбудованих мереж унікальні');

  ok(BUILTIN_NETWORKS.every(n => (n.rpcFallback || []).every(u => isSafeRpc(u) && u.startsWith('https://') && !/key|token|\$\{/i.test(u) && u !== n.rpc)), 'wallet: запасні RPC — https, без ключів, відмінні від основного');
  const failover = await failoverTests();
  ok(failover, 'wallet: запасні RPC працюють');

  // --- особа Chrome лише для Google (інакше Cloudflare Turnstile не пускає браузер, напр. tensor.trade) ---
  const { isGoogleUrl, cleanUserAgent } = require('../../src/chrome-identity');
  ok(['https://accounts.google.com/signin', 'https://www.google.co.uk/', 'https://www.google.com.ua/', 'https://www.youtube.com/', 'https://google.com/'].every(isGoogleUrl), 'identity: особа Chrome вмикається на сторінках Google та YouTube');
  ok(!['https://www.tensor.trade/', 'https://google.evil.com/', 'https://evil.google.evil.com/', 'https://notgoogle.com/', 'https://google.com.evil.io/', 'http://accounts.google.com/', 'not a url'].some(isGoogleUrl), 'identity: на інших сайтах (зокрема схожих на Google) особа Chrome не вмикається');
  ok(cleanUserAgent('Mozilla/5.0 (X) W3IRBrowser/1.29.0 Chrome/146.0.0.0 Electron/41.0.0 Safari/537.36') === 'Mozilla/5.0 (X) Chrome/146.0.0.0 Safari/537.36', 'identity: з User-Agent для Google прибрано ознаки Electron і W3IR');
}

module.exports = { failoverTests, auditTests, webauthnTests, ipcPolicyTests, historySearchTests, designTests, brandTests, dashboardTests, rpcListTests };
