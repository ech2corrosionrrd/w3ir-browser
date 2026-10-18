'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { ok, sleep, tmp } = require('../lib');

async function helpTests(ctx) {
  const { withTip } = require('../../src/tips');
  const w = [...ctx.windows][0];
  ok(w.menuItems().map(withTip).filter(i => !i.sep).every(i => i.tip), 'help: усі пункти меню мають підказку при наведенні');
  ok(w.commandList().map(withTip).every(i => i.tip), 'help: усі команди палітри мають підказку');
  ok(w.menuItems().some(i => i.arg === 'help') && w.commandList().some(i => i.arg === 'help'), 'help: «Довідка» є в меню та палітрі');

  const key = (k, extra = {}) => { const e = { preventDefault() {} }; w.onKey(e, { type: 'keyDown', key: k, control: false, shift: false, alt: false, meta: false, ...extra }); };
  key('F1');
  await sleep(1500);
  ok(w.wc().getURL().startsWith('w3ir://help'), 'help: F1 відкриває довідку');
  const stat = await w.wc().executeJavaScript(`(() => ({
    sections: document.querySelectorAll('section.sec').length,
    entries: document.querySelectorAll('.entry').length,
    toc: document.querySelectorAll('#toc a').length,
    hrefs: [...new Set([...document.querySelectorAll('a[href^="w3ir://"]')].map(a => a.getAttribute('href')))],
    text: document.body.innerText.toLowerCase(),
    rows: document.querySelectorAll('table.keys tr').length,
    ids: [...document.querySelectorAll('section.sec')].map(s => s.id),
    tocHrefs: [...document.querySelectorAll('#toc a')].map(a => a.getAttribute('href')),
    emptyEntries: [...document.querySelectorAll('.entry')].filter(e => !e.querySelector('h3').textContent.trim() || (e.querySelectorAll('p,li').length === 0)).length,
    emptyCells: [...document.querySelectorAll('table.keys td')].filter(td => !td.textContent.trim()).length,
    internal: [...document.querySelectorAll('.entry a[href^="#"]')].map(a => a.getAttribute('href')),
  }))()`);
  ok(stat.sections >= 24 && stat.toc === stat.sections && stat.entries >= 100, `help: довідка містить розділи (${stat.sections}) і статті (${stat.entries})`);
  const must = ['ctrl+k', 'гаманець', 'профіл', 'github', 'magnet', 'режим читання', 'синхронізац', 'https', 'інкогніто', 'імпорт', 'менеджер паролів', 'вертикальні вкладки', 'групи вкладок', 'сплячі вкладки', 'блокування реклами', 'f1', 'pdf-інструменти', 'w3ir://pdftools', 'crash.log', '.bak', '.corrupt', 'локальний ші-помічник', 'небезпечні завантаження', 'сторінка не відповідає', 'поради та хитрощі', 'усунення проблем', 'перші 5 хвилин', 'ctrl+f4'];
  const missing = must.filter(m => !stat.text.includes(m));
  ok(missing.length === 0, 'help: описано всі ключові функції' + (missing.length ? ' — немає: ' + missing.join(', ') : ''));
  const pagesDir = path.join(__dirname, '..', '..', 'pages');
  const broken = stat.hrefs.filter(h => !fs.existsSync(path.join(pagesDir, h.replace('w3ir://', '').replace(/\/$/, '') + '.html')));
  ok(stat.hrefs.length >= 8 && broken.length === 0, 'help: усі внутрішні посилання ведуть на наявні сторінки' + (broken.length ? ' — биті: ' + broken.join(', ') : ''));
  ok(stat.rows >= 32 && stat.emptyCells === 0, 'help: таблиця гарячих клавіш заповнена, без порожніх клітинок');
  ok(stat.emptyEntries === 0, 'help: немає порожніх статей (кожна має заголовок і текст чи список)');
  ok(new Set(stat.ids).size === stat.ids.length, 'help: ідентифікатори розділів унікальні');
  ok(stat.tocHrefs.every(h => stat.ids.includes(h.slice(1))), 'help: усі пункти змісту ведуть на наявні розділи');
  ok(['start', 'pdf', 'ai', 'tips', 'recovery', 'troubleshoot', 'keys', 'faq', 'privacy', 'web3'].every(id => stat.ids.includes(id)), 'help: є швидкий старт, PDF, ШІ, поради, відновлення, усунення проблем, клавіші, FAQ, безпека');

  // пошук
  const helpSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'pages', 'help-data.js'), 'utf8');
  const helpData = new Function(helpSrc + '; return { HELP, SHORTCUTS, FAQ };')();
  const strs = [];
  const walk = (v, k) => { if (typeof v === 'string') strs.push([k, v]); else if (Array.isArray(v)) v.forEach(x => walk(x, k)); else if (v && typeof v === 'object') Object.entries(v).forEach(([kk, x]) => walk(x, kk)); };
  walk(helpData, '');
  ok(strs.every(([, s]) => s.trim().length > 0), 'help: у даних довідки немає порожніх рядків');
  const refs = [...helpSrc.matchAll(/\]\(w3ir:\/\/([a-z]+)\)/g)].map(m => m[1]);
  ok(refs.length >= 20 && refs.every(r => fs.existsSync(path.join(__dirname, '..', '..', 'pages', r + '.html'))), 'help: усі посилання w3ir:// у даних довідки ведуть на наявні сторінки');
  const locRead = (l) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'locales', l + '.json'), 'utf8'));
  const helpStrs = [...new Set(strs.filter(([k]) => k !== 'id' && k !== 'icon').map(([, s]) => s))];
  const untranslated = [];
  for (const l of ['en', 'de', 'es', 'fr', 'pl']) { const c = locRead(l); for (const s of helpStrs) if (/[А-Яа-яІіЇїЄє]/.test(s) && !(c[s] && c[s].trim())) untranslated.push(l + ': ' + s.slice(0, 40)); }
  ok(untranslated.length === 0, 'help: усі рядки довідки перекладено на 5 мов' + (untranslated.length ? ' — немає: ' + untranslated.slice(0, 3).join(' | ') : ''));

  const search = async (q) => w.wc().executeJavaScript(`(() => { const i = document.querySelector('#toc input'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); return { visible: [...document.querySelectorAll('section.sec')].filter(s => !s.hidden).map(s => s.id), empty: !document.querySelector('.empty').hidden }; })()`);
  const r1 = await search('гаманець');
  ok(r1.visible.includes('web3') && r1.visible.length < stat.sections && !r1.empty, 'help: пошук «гаманець» знаходить розділ Web3 і ховає решту');
  const r2 = await search('zzzzqqq');
  ok(r2.visible.length === 0 && r2.empty, 'help: пошук без результатів показує повідомлення');
  const r3 = await search('');
  ok(r3.visible.length === stat.sections, 'help: порожній пошук повертає всі розділи');

  // задокументовані гарячі клавіші справді працюють
  w.closeOverlay();
  key('k', { control: true });
  ok(w.overlayType === 'palette', 'help: Ctrl+K відкриває палітру, як описано');
  key('Escape');
  ok(w.overlayType === null, 'help: Esc закриває палітру, як описано');
  const before = w.tabs.length;
  key('t', { control: true });
  await sleep(300);
  ok(w.tabs.length === before + 1, 'help: Ctrl+T відкриває вкладку, як описано');
  key('w', { control: true });
  await sleep(300);
  ok(w.tabs.length === before, 'help: Ctrl+W закриває вкладку, як описано');
  key('a', { control: true, shift: true });
  ok(w.overlayType === 'palette', 'help: Ctrl+Shift+A відкриває пошук по вкладках, як описано');
  w.closeOverlay();
  const before2 = w.tabs.length;
  key('t', { control: true });
  await sleep(300);
  key('F4', { control: true });
  await sleep(300);
  ok(w.tabs.length === before2, 'help: Ctrl+F4 закриває вкладку, як описано');
  key('t', { control: true });
  await sleep(300);
  const act = w.activeId;
  key('PageUp', { control: true });
  ok(w.activeId !== act, 'help: Ctrl+PgUp перемикає вкладку, як описано');
  key('PageDown', { control: true });
  ok(w.activeId === act, 'help: Ctrl+PgDn переходить до наступної вкладки, як описано');
  key('w', { control: true });
  await sleep(300);
  ok(w.tabs.length === before2, 'help: тимчасова вкладка закрита');
}

async function updateTests(ctx) {
  const crypto = require('crypto');
  const yaml = require('js-yaml');
  const { autoUpdater } = require('electron-updater');
  const V = require('../../src/update-verify');
  const { parseFeed } = require('../../src/updater');
  const gen = () => { const k = crypto.generateKeyPairSync('ed25519'); return { pub: k.publicKey.export({ type: 'spki', format: 'pem' }), priv: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) }; };
  const good = gen(), evil = gen();

  // --- підпис ---
  const sig = V.sign(good.priv, '9.0.0', 'AAAA');
  ok(V.verify(good.pub, '9.0.0', 'AAAA', sig), 'update: коректний підпис проходить перевірку');
  ok(V.verify([evil.pub, good.pub], '9.0.0', 'AAAA', sig), 'update: масив ключів із резервним проходить перевірку');
  ok(!V.verify(good.pub, '9.0.1', 'AAAA', sig) && !V.verify(good.pub, '9.0.0', 'AAAB', sig), 'update: зміна версії або хешу робить підпис недійсним');
  ok(!V.verify(evil.pub, '9.0.0', 'AAAA', sig) && !V.verify(good.pub, '9.0.0', 'AAAA', 'garbage') && !V.verify(good.pub, '9.0.0', 'AAAA', undefined), 'update: чужий ключ і сміття відхиляються');
  const keyPath = path.join(__dirname, '..', '..', 'build', 'keys', 'update-private.pem');
  if (fs.existsSync(keyPath)) ok(V.verify(require('../../src/update-key'), '1.0.0', 'XYZ', V.sign(fs.readFileSync(keyPath, 'utf8'), '1.0.0', 'XYZ')), 'update: вбудований публічний ключ відповідає приватному ключу випускача');

  // --- джерело оновлень ---
  ok(parseFeed('github:owner/repo').provider === 'github' && parseFeed('https://example.com/updates').url === 'https://example.com/updates/', 'update: джерела github: та https приймаються');
  ok(!parseFeed('http://example.com/x') && !parseFeed('javascript:alert(1)') && !parseFeed('file:///c:/x') && !parseFeed('https://user:pw@example.com/') && !parseFeed('github:../../x') && !parseFeed(''), 'update: небезпечні джерела (http, file, javascript, логін у URL) відхиляються');

  // --- інтеграція з electron-updater через локальний сервер ---
  const u = ctx.manager.updater;
  const saved = { pub: u.publicKey, ins: u.allowInsecure, dev: u.forceDev, cfg: u.getCfg, conf: autoUpdater.configOnDisk };
  const cacheName = 'w3ir-test-updater-' + process.pid;
  const cacheDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), cacheName);
  u.publicKey = good.pub; u.allowInsecure = true; u.forceDev = true;
  autoUpdater.forceDevUpdateConfig = true;
  autoUpdater.configOnDisk = { value: Promise.resolve({ provider: 'generic', url: 'https://invalid.invalid/', publisherName: ['W3IR'], updaterCacheDirName: cacheName }) };
  autoUpdater.downloadedUpdateHelper = null;

  const releases = {};
  const srv = http.createServer((req, res) => {
    const m = /^\/([a-z0-9]+)\/(.+)$/.exec(decodeURIComponent(req.url.split('?')[0]));
    const rel = m && releases[m[1]];
    if (!rel) { res.writeHead(404); return res.end(); }
    if (m[2] === 'latest.yml') { res.writeHead(200, { 'content-type': 'text/yaml' }); return res.end(rel.yml); }
    if (m[2] === rel.name) { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': rel.served.length }); return res.end(rel.served); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const publish = (id, version, { key = good.priv, signWith, noSig = false, serve } = {}) => {
    const body = crypto.randomBytes(300 * 1024);
    const name = `W3IR-Browser-Setup-${version}.exe`;
    const sha = crypto.createHash('sha512').update(body).digest('base64');
    const info = { version, files: [{ url: name, sha512: sha, size: body.length }], path: name, sha512: sha, releaseDate: new Date().toISOString() };
    if (!noSig) info.w3irSignature = V.sign(key, version, signWith || sha);
    releases[id] = { name, yml: yaml.dump(info), served: serve ? serve(body) : body };
  };
  const run = async (id) => {
    u.resetForTest();
    u.getCfg = () => ({ updateFeed: `http://127.0.0.1:${port}/${id}/`, autoUpdate: true });
    await u.check({ manual: true });
    for (let i = 0; i < 100 && !['ready', 'error', 'none'].includes(u.state.state); i++) await sleep(100);
    return { ...u.state, installOnQuit: autoUpdater.autoInstallOnAppQuit };
  };

  publish('good', '99.0.0');
  let r = await run('good');
  ok(r.state === 'ready' && r.version === '99.0.0' && r.installOnQuit === true, 'update: підписане оновлення завантажено, перевірено й готове до встановлення');
  ok(u.brief().state === 'ready' && u.status().fingerprint.length === 16, 'update: стан для інтерфейсу (готово) та відбиток ключа');

  publish('evilkey', '99.0.1', { key: evil.priv });
  r = await run('evilkey');
  ok(r.state === 'error' && !r.installOnQuit && /підпис/i.test(r.error), 'update: оновлення, підписане чужим ключем, відхилено і не буде встановлено');

  publish('nosig', '99.0.2', { noSig: true });
  r = await run('nosig');
  ok(r.state === 'error' && !r.installOnQuit && /підпису/.test(r.error), 'update: оновлення без підпису відхилено');

  publish('forged', '99.0.3', { signWith: 'bW9kaWZpZWQ=' });
  r = await run('forged');
  ok(r.state === 'error' && !r.installOnQuit, 'update: підроблений latest.yml (підпис від іншого хешу) відхилено');

  publish('tampered', '99.0.4', { serve: (b) => { const c = Buffer.from(b); c[100] ^= 0xff; return c; } });
  r = await run('tampered');
  ok(r.state === 'error' && !r.installOnQuit, 'update: файл, змінений під час передачі (хеш не збігається), відхилено');

  publish('old', '0.0.1');
  r = await run('old');
  ok(r.state === 'none' && !r.installOnQuit, 'update: старішу версію не пропонують (захист від відкату)');

  const defFeed = u.defaultFeed;
  u.defaultFeed = '';
  u.getCfg = () => ({ updateFeed: '', autoUpdate: true });
  u.resetForTest();
  r = await u.check({ manual: true });
  ok(r.state === 'idle' && /не налаштовано/.test(r.error), 'update: без джерела оновлення вимкнено з поясненням');

  ok(require('../../src/updater').DEFAULT_FEED === 'github:ech2corrosionrrd/w3ir-browser' && !!parseFeed(require('../../src/updater').DEFAULT_FEED), 'update: офіційне джерело за замовчуванням коректне');
  u.defaultFeed = defFeed;
  srv.close();
  u.publicKey = saved.pub; u.allowInsecure = saved.ins; u.forceDev = saved.dev; u.getCfg = saved.cfg;
  autoUpdater.forceDevUpdateConfig = false; autoUpdater.configOnDisk = saved.conf; autoUpdater.downloadedUpdateHelper = null; autoUpdater.autoInstallOnAppQuit = false;
  u.resetForTest();
  try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch { /* ignore */ }

  // --- інтерфейс ---
  const w = [...ctx.windows][0];
  const menu = w.menuItems();
  ok(!menu.some(i => i.cmd === 'updateInstall'), 'update: пункту «Оновити» в меню немає, поки оновлення не готове');
  ctx.manager.updater.state.state = 'ready'; ctx.manager.updater.state.version = '99.0.0';
  ok(w.menuItems().some(i => i.cmd === 'updateInstall' && /99\.0\.0/.test(i.label)), 'update: коли оновлення готове, меню містить пункт «Оновити до …»');
  w.sendState();
  ctx.manager.updater.resetForTest();

  // --- облік спроби встановлення ---
  const { installerRunning } = require('../../src/updater');
  ok(installerRunning('"explorer.exe","1234","Console","1","50 K"\n"W3IR-Browser-Setup-1.7.3.exe","99","Console","1","9 K"') === true && installerRunning('"W3IR Browser.exe","1","Console","1","1 K"\n"chrome.exe","2","Console","1","1 K"') === false, 'update: розпізнавання запущеного інсталятора за списком процесів');
  const aDir = tmp('attempt');
  const ucur = require('electron').app.getVersion();
  const up2 = ctx.manager.updater;
  const sLogFile = up2.logFile, sKey = up2.publicKey;
  up2.logFile = path.join(aDir, 'updater.log'); up2.publicKey = good.pub;
  const toasts = [];
  // успіх: версія збігається з очікуваною
  fs.writeFileSync(up2.attemptFile(), JSON.stringify({ from: '0.0.1', to: ucur, time: Date.now(), installer: '', signature: '' }));
  ok(await up2.afterStart({ toast: (t) => toasts.push(t) }) === 'success' && toasts.some(t => t.includes(ucur)) && !fs.existsSync(up2.attemptFile()), 'update: після успішного оновлення показується «Браузер оновлено до …»');
  // збій: версія не змінилась → пропозиція відкрити інсталятор лише з дійсним підписом
  const fakeInstaller = path.join(aDir, 'W3IR-Browser-Setup-99.0.0.exe');
  fs.writeFileSync(fakeInstaller, crypto.randomBytes(5000));
  const shaA = await V.sha512File(fakeInstaller);
  const { shell: sh, dialog: dlg } = require('electron');
  const origOpen = sh.openPath, origBox = dlg.showMessageBox;
  const opened = [];
  sh.openPath = (p) => { opened.push(p); return Promise.resolve(''); };
  dlg.showMessageBox = async () => ({ response: 0 });
  fs.writeFileSync(up2.attemptFile(), JSON.stringify({ from: ucur, to: '99.0.0', time: Date.now(), installer: fakeInstaller, signature: V.sign(good.priv, '99.0.0', shaA) }));
  ok(await up2.afterStart({ toast: (t) => toasts.push(t) }) === 'manual' && opened[0] === fakeInstaller, 'update: після збою пропонується ручне встановлення з перевіреного файлу');
  fs.writeFileSync(up2.attemptFile(), JSON.stringify({ from: ucur, to: '99.0.0', time: Date.now(), installer: fakeInstaller, signature: V.sign(evil.priv, '99.0.0', shaA) }));
  opened.length = 0;
  ok(await up2.afterStart({ toast: (t) => toasts.push(t) }) === 'failed' && opened.length === 0, 'update: файл із недійсним підписом ніколи не відкривається вручну');
  fs.writeFileSync(up2.attemptFile(), JSON.stringify({ from: ucur, to: '99.0.0', time: Date.now() - 7 * 3600 * 1000, installer: fakeInstaller, signature: '' }));
  ok(await up2.afterStart({}) === 'stale' && !fs.existsSync(up2.attemptFile()), 'update: застарілий запис про спробу ігнорується й видаляється');
  ok(await up2.afterStart({}) === 'none', 'update: без запису про спробу нічого не відбувається');
  sh.openPath = origOpen; dlg.showMessageBox = origBox; up2.logFile = sLogFile; up2.publicKey = sKey;

  // --- клік по ⬆ у панелі → підтвердження → встановлення (зв'язок інтерфейсу та головного процесу) ---
  const { dialog } = require('electron');
  const origDialog = dialog.showMessageBox, origInstall = u.install;
  let asked = 0, installed = 0;
  dialog.showMessageBox = async () => { asked++; return { response: 0 }; };
  u.install = () => { installed++; return true; };
  u.state.state = 'ready'; u.state.version = '99.0.0';
  w.sendState(); await sleep(400);
  const btn = await w.chrome.executeJavaScript(`(() => { const b = document.getElementById('upd'); return { hidden: b.hidden, ready: b.classList.contains('ready'), title: b.title }; })()`);
  ok(!btn.hidden && btn.ready && /99\.0\.0/.test(btn.title), 'update: кнопка ⬆ видима й зелена, коли оновлення готове');
  await w.chrome.executeJavaScript(`document.getElementById('upd').click()`);
  await sleep(500);
  ok(asked === 1 && installed === 1, 'update: клік по ⬆ → підтвердження → встановлення');
  // з налаштувань
  w.exec('openPage', 'settings'); await sleep(1500);
  // сторінка налаштувань малює блок оновлень асинхронно: чекаємо появи кнопки до 8 с замість фіксованої паузи (нестабільний тест)
  const settingsBtn = await w.wc().executeJavaScript(`new Promise(r => { const t0 = Date.now(); const tick = () => { const b = [...document.querySelectorAll('button')].map(x => x.textContent); if (b.some(x => x.includes('Встановити та перезапустити')) || Date.now() - t0 > 8000) r(b); else setTimeout(tick, 200); }; tick(); })`);
  ok(settingsBtn.includes('Встановити та перезапустити'), 'update: у налаштуваннях є кнопка «Встановити та перезапустити», коли оновлення готове');
  asked = 0; installed = 0;
  await w.wc().executeJavaScript(`w3ir.invoke('update:install')`); await sleep(500);
  ok(asked === 1 && installed === 1, 'update: встановлення з налаштувань теж просить підтвердження');
  // сповіщення про готове оновлення
  let toasted = '';
  const origToast = w.toast.bind(w);
  w.toast = (t) => { toasted = t; };
  u.state.state = 'downloading';
  u.onReady = (v) => w.toast(`Оновлення ${v} готове й перевірене — натисніть ⬆`);
  u.set({ state: 'ready', version: '99.0.1' });
  ok(/99\.0\.1/.test(toasted), 'update: при готовності оновлення показується сповіщення');
  w.toast = origToast;
  dialog.showMessageBox = origDialog; u.install = origInstall; u.onReady = () => {};
  u.resetForTest();
}

async function threatTests(ctx) {
  const { Threats, parseList, parseBlacklistJson } = require('../../src/threats');
  const mk = (extra = {}) => new Threats({ dir: tmp('threats'), cfg: () => ({}), history: () => [], bookmarks: () => [], ...extra });
  const t = mk();

  // --- евристики: підозрілі ---
  const bad = [
    ['https://paypa1.com/login', 'lookalike'], ['https://gooogle.com/', 'lookalike'], ['https://githhub.com/', 'lookalike'], ['https://amaz0n.com/', 'lookalike'],
    ['https://paypal.com.evil-site.net/', 'lookalike'], ['https://login.metamask.example-wallet.io/', 'lookalike'],
    ['https://metamask-wallet-claim.xyz/', 'lookalike'], ['https://uniswap-airdrop.xyz/', 'lookalike'],
    ['https://metamask-support.app.link/x', 'lookalike'], ['https://login.metamask.app.link/x', 'lookalike'],
    ['https://google.com@evil.example/', 'userinfo'],
    [new URL('https://p\u0430ypal.com/').href, 'homograph'], [new URL('https://\u043e\u043a\u0445.com/').href, 'homograph'],
  ];
  for (const [u, kind] of bad) { const r = t.check(u); ok(r && r.kind === kind && r.severity === 'suspicious' && r.canTrust, `threats: підозрілий ${u.slice(0, 48)} → ${kind}`); }
  // --- легітимні сайти не чіпаємо ---
  const good = ['https://www.google.com/', 'https://accounts.google.com/', 'https://www.google.com.ua/', 'https://google.de/', 'https://user.github.io/', 'https://microsoft.github.io/', 'https://paypal.me/x',
    'https://app.uniswap.org/', 'https://metamask.io/download', 'https://diia.gov.ua/', 'https://www.ukr.net/', 'https://example.com/', 'https://xn--d1acpjx3f.xn--p1ai/', 'http://127.0.0.1:8080/',
    'https://github.com/login', 'https://gmail.google.com/', 'https://docs.google.com/', 'https://monobank.ua/', 'https://www.amazon.de/', 'https://opensea.io/', 'https://support.apple.com/', 'https://metamask.app.link/r9ZhePHOx3b?sig=x&_p=y', 'file:///c:/x.html'];
  const fp = good.filter(u => t.check(u));
  ok(fp.length === 0, 'threats: легітимні сайти без хибних спрацювань' + (fp.length ? ' — хибно: ' + fp.join(', ') : ''));

  // --- довіра та «свої» домени ---
  const trusted = mk({ cfg: () => ({ safeAllow: ['paypa1.com'] }) });
  ok(trusted.check('https://paypa1.com/') === null, 'threats: домен із довірених не блокується');
  const used = mk({ history: () => [{ url: 'https://paypa1.com/a', n: 3 }] });
  ok(used.check('https://paypa1.com/') === null, 'threats: домен, яким ви вже користуєтесь, евристики не зачіпають');
  const withBookmark = mk({ bookmarks: () => [{ url: 'https://paypa1.com/' }] });
  ok(withBookmark.check('https://paypa1.com/') === null, 'threats: домен із закладок евристики не зачіпають');

  // --- списки ---
  t.setLists({ malware: ['bad.example.org', '1.2.3.4'], phishing: ['phish.example.com', 'evil.blogspot.com'] });
  ok(t.check('https://bad.example.org/x').kind === 'malware' && t.check('https://sub.bad.example.org/').kind === 'malware', 'threats: шкідливий хост і його піддомени');
  ok(t.check('https://phish.example.com/').kind === 'phishing' && t.check('https://phish.example.com/').severity === 'listed' && !t.check('https://phish.example.com/').canTrust, 'threats: фішинговий домен зі списку (довіряти не можна)');
  ok(t.check('http://1.2.3.4/a').kind === 'malware', 'threats: IP зі списку');
  ok(t.check('https://x.evil.blogspot.com/') && !t.check('https://good.blogspot.com/') && !t.check('https://example.org/'), 'threats: батьківський публічний домен (blogspot.com) не блокується через чужий піддомен');
  t.bypass.add('bad.example.org');
  ok(t.check('https://bad.example.org/') === null, 'threats: разовий дозвіл «усе одно відкрити» діє');
  ok(JSON.stringify([...parseList('# c\n127.0.0.1\tevil.example\nplain.example # x\nBAD LINE here\n-bad-.com\nlocalhost\n  UP.Example.COM.  \n')].sort()) === JSON.stringify(['evil.example', 'plain.example', 'up.example.com']), 'threats: розбір hosts- і текстових списків');
  ok(JSON.stringify([...parseBlacklistJson('{"whitelist":["good.example"],"fuzzylist":["fz.example"],"blacklist":["Evil-OpenSea.xyz","sub.godaddysites.com","bad line",5,"localhost"]}')].sort()) === JSON.stringify(['evil-opensea.xyz', 'sub.godaddysites.com']), 'threats: eth-phishing-detect — береться лише blacklist');
  ok(parseBlacklistJson('не json').size === 0 && parseBlacklistJson('{"blacklist":"x"}').size === 0, 'threats: пошкоджений JSON не ламає оновлення');

  // --- оновлення списків із сервера, збереження, відновлення ---
  let status = 200;
  const srv = http.createServer((req, res) => {
    if (status !== 200) { res.writeHead(status); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(req.url === '/hosts' ? '# URLhaus\n127.0.0.1\tmalware-host.test\n127.0.0.1\tphish.localhost\n' : 'phish-one.test\nphish-two.test\n');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const dir = tmp('threats-upd');
  const sources = [{ id: 'u', kind: 'malware', title: 'U', url: base + '/hosts' }, { id: 'p', kind: 'phishing', title: 'P', url: base + '/plain' }];
  const insecure = mk({ dir, sources });
  await insecure.update();
  ok(/insecure/.test(insecure.meta.error) && insecure.lists.malware.length === 0, 'threats: джерело списків лише за https (http відхилено)');
  const up = mk({ dir, sources, allowInsecure: true });
  await up.update();
  ok(up.status().counts.malware === 2 && up.status().counts.phishing === 2 && !up.meta.error && up.check('https://phish-two.test/') && up.check('http://malware-host.test/'), 'threats: списки завантажено та застосовано');
  const reload = mk({ dir, sources, allowInsecure: true });
  ok(reload.check('https://phish-one.test/') && reload.status().counts.phishing === 2 && fs.statSync(path.join(dir, 'threats-phishing.bin')).size === 16, 'threats: списки збережено на диск у компактному вигляді (8 байт на домен) і відновлено');
  status = 500;
  await up.update();
  ok(/HTTP 500/.test(up.meta.error) && up.check('https://phish-one.test/'), 'threats: помилка оновлення не стирає чинні списки');
  status = 200;

  // --- інтеграція: сторінка-попередження, обхід, довіра, вимкнення ---
  const w = [...ctx.windows][0];
  const savedLists = ctx.threats.shared.lists;
  let hits = 0;
  const site = http.createServer((req, res) => { hits++; res.setHeader('content-type', 'text/html'); res.end('<title>site-ok</title>ok'); });
  await new Promise(r => site.listen(0, '127.0.0.1', r));
  const siteUrl = `http://phish.localhost:${site.address().port}/page`;
  ctx.threats.setLists({ phishing: ['phish.localhost'] });
  w.exec('newTab'); w.exec('go', siteUrl); await sleep(2000);
  ok(w.wc().getURL().startsWith('w3ir://warning') && hits === 0, 'threats: перехід на фішинговий сайт замінюється попередженням (сайт навіть не отримав запит)');
  const page = await w.wc().executeJavaScript(`({ h1: document.querySelector('h1').textContent, text: document.body.innerText, trustBtn: [...document.querySelectorAll('button')].some(b => /довіряю/.test(b.textContent)) })`);
  ok(/фішингов/i.test(page.h1) && page.text.includes('phish.localhost') && !page.trustBtn, 'threats: попередження пояснює причину; для списків немає кнопки «Я довіряю»');
  ok(await w.wc().executeJavaScript(`w3ir.invoke('safe:trust', { url: ${JSON.stringify(siteUrl)} }).then(r => r.ok)`) === false, 'threats: сайт зі списку не можна додати в довірені');
  ok(await w.wc().executeJavaScript(`w3ir.invoke('safe:status').then(() => 'allowed', () => 'denied')`) === 'denied', 'threats: сторінка попередження не має доступу до зайвих функцій');
  ok(await w.wc().executeJavaScript(`w3ir.invoke('safe:proceed', { url: ${JSON.stringify(siteUrl)} }).then(r => r.ok)`) === true, 'threats: «усе одно відкрити» реєструє разовий дозвіл');
  w.exec('go', siteUrl); await sleep(1800);
  ok(hits >= 1 && w.wc().getTitle() === 'site-ok', 'threats: після свідомого підтвердження сайт відкривається');
  ctx.threats.bypass.clear(); hits = 0;
  ctx.cfg().safeBrowsing = false;
  w.exec('go', siteUrl); await sleep(1800);
  ok(hits >= 1 && w.wc().getTitle() === 'site-ok', 'threats: при вимкненому захисті перевірка не виконується');
  ctx.cfg().safeBrowsing = true;
  w.exec('openPage', 'settings'); await sleep(1200);
  ok(await w.wc().executeJavaScript(`w3ir.invoke('safe:status').then(r => typeof r.counts.phishing, () => 'denied')`) === 'number', 'threats: сторінка налаштувань бачить статус списків');
  ok(await w.wc().executeJavaScript(`w3ir.invoke('safe:proceed', { url: 'https://x.example/' }).then(() => 'allowed', () => 'denied')`) === 'denied', 'threats: сторінка налаштувань не може видавати дозволи на обхід');

  // завантаження зі шкідливого хоста блокується
  const item = { url: siteUrl, cancelled: false, getURL() { return this.url; }, cancel() { this.cancelled = true; } };
  ctx.downloads.onDownload(item, false);
  ok(item.cancelled === true, 'threats: завантаження з небезпечного хоста скасовується');

  // гаманець не взаємодіє з небезпечними сайтами та попереджає про підозрілі
  let threw = 0; try { await ctx.wallet.approve({ requestApproval: async () => ({ approved: true }) }, 'http://phish.localhost:1', () => true, { kind: 'connect', title: 't', lines: [], warnings: [] }); } catch (e) { threw = e.code; }
  ok(threw === 4100, 'threats: гаманець відмовляє сайтам зі списків шахрайських (код 4100)');
  let spec = null;
  await ctx.wallet.approve({ requestApproval: async (s) => { spec = s; return { approved: true }; } }, 'https://paypa1.com', () => true, { kind: 'connect', title: 't', lines: [], warnings: ['x'] });
  ok(spec && spec.danger === true && /^⚠/.test(spec.warnings[0]) && spec.warnings.length === 2, 'threats: у вікні підтвердження гаманця є попередження про підозрілий сайт');

  ctx.threats.shared.lists = savedLists;
  ctx.threats.bypass.clear();
  site.close(); srv.close();
}

module.exports = { helpTests, updateTests, threatTests };
