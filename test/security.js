'use strict';
// Тести безпеки: W3IR_SMOKE=security npx electron .
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { app } = require('electron');
const { Vault } = require('../src/vault');
const { Sync, FILE_NAME } = require('../src/sync');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, failed = 0;
const ok = (cond, name) => { cond ? pass++ : failed++; console.log(`[sec] ${cond ? 'PASS' : 'FAIL'} ${name}`); };
const tmpDirs = [];
const tmp = (n) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'w3ir-' + n + '-')); tmpDirs.push(d); return d; };

async function vaultTests() {
  const dir = tmp('vault');
  const v = new Vault({ dir, autolockMinutes: 15 });
  ok(v.status() === 'none', 'vault: спочатку немає');
  ok(!(await v.create('short')).ok, 'vault: слабкий майстер-пароль відхилено');
  ok((await v.create('Correct-Horse-9-Battery')).ok, 'vault: створення');
  v.add({ url: 'https://example.com/login', username: 'alice', password: 'S3cret!pass' });
  const raw = fs.readFileSync(path.join(dir, 'vault.bin'), 'utf8');
  ok(!raw.includes('alice') && !raw.includes('S3cret') && !raw.includes('example.com'), 'vault: у файлі немає відкритих даних');
  ok(JSON.parse(raw).pepper === true, 'vault: «перець» DPAPI використано');
  ok(fs.existsSync(path.join(dir, 'vault.pepper')), 'vault: файл перцю створено');
  v.lock();
  ok(v.status() === 'locked' && v.key === null && v.data === null, 'vault: після блокування ключ і дані стерті');
  let threw = false; try { v.list(); } catch { threw = true; }
  ok(threw, 'vault: заблоковане сховище не віддає дані');
  const bad = await v.unlock('wrong-password-123');
  ok(!bad.ok, 'vault: хибний пароль відхилено');
  const throttled = await v.unlock('Correct-Horse-9-Battery');
  ok(!throttled.ok && /Зачекайте|Забагато/.test(throttled.error), 'vault: затримка після невдалої спроби');
  v.nextAllowed = 0;
  ok((await v.unlock('Correct-Horse-9-Battery')).ok, 'vault: правильний пароль');
  ok(v.list('https://example.com').length === 1, 'vault: запис збережено');
}

async function vaultTests2() {
  const dir = tmp('vault2');
  const v = new Vault({ dir });
  await v.create('Correct-Horse-9-Battery');
  ok((() => { try { v.add({ url: 'http://plain.example.com', username: 'a', password: 'p' }); return false; } catch { return true; } })(), 'vault: http-сайти (крім localhost) не зберігаються');
  v.add({ url: 'https://a.example.com', username: 'u', password: 'p1' });
  v.add({ url: 'https://a.example.com', username: 'u', password: 'p2' });
  ok(v.list().length === 1 && v.get(v.list()[0].id).password === 'p2', 'vault: оновлення замість дубліката');
  v.lock();

  // підміна файлу
  const file = path.join(dir, 'vault.bin');
  const orig = fs.readFileSync(file, 'utf8');
  const j = JSON.parse(orig);
  const ct = Buffer.from(j.ct, 'base64'); ct[0] ^= 1; j.ct = ct.toString('base64');
  fs.writeFileSync(file, JSON.stringify(j));
  v.nextAllowed = 0;
  ok(!(await v.unlock('Correct-Horse-9-Battery')).ok, 'vault: змінений шифротекст виявлено (GCM)');
  // підміна параметрів KDF
  const j2 = JSON.parse(orig); j2.kdf.n = 1 << 14; fs.writeFileSync(file, JSON.stringify(j2));
  v.nextAllowed = 0;
  ok(!(await v.unlock('Correct-Horse-9-Battery')).ok, 'vault: підміна параметрів KDF виявлена (AAD)');
  const j3 = JSON.parse(orig); j3.kdf.n = 3; fs.writeFileSync(file, JSON.stringify(j3));
  v.nextAllowed = 0;
  ok(!(await v.unlock('Correct-Horse-9-Battery')).ok, 'vault: небезпечні параметри KDF відхилено');
  fs.writeFileSync(file, orig);
  v.nextAllowed = 0;
  ok((await v.unlock('Correct-Horse-9-Battery')).ok, 'vault: відновлений оригінал відкривається');

  // без перцю (інший акаунт Windows) не відкривається
  const pf = path.join(dir, 'vault.pepper');
  const pepperBackup = fs.readFileSync(pf);
  v.lock();
  fs.writeFileSync(pf, Buffer.from('garbage'));
  v.nextAllowed = 0;
  ok(!(await v.unlock('Correct-Horse-9-Battery')).ok, 'vault: без правильного «перцю» файл не відкривається');
  fs.writeFileSync(pf, pepperBackup);
  v.nextAllowed = 0;
  await v.unlock('Correct-Horse-9-Battery');

  // зміна майстер-пароля
  ok(!(await v.changeMaster('bad-old-password', 'New-Master-Pass-77!')).ok, 'vault: зміна майстер-пароля вимагає старий');
  ok((await v.changeMaster('Correct-Horse-9-Battery', 'New-Master-Pass-77!')).ok, 'vault: майстер-пароль змінено');
  v.lock(); v.nextAllowed = 0;
  ok(!(await v.unlock('Correct-Horse-9-Battery')).ok && (await (async () => { v.nextAllowed = 0; return (await v.unlock('New-Master-Pass-77!')).ok; })()), 'vault: старий пароль не діє, новий діє');

  // резервна копія
  const bk = path.join(dir, 'b.w3irvault');
  v.lastAuth = Date.now();
  ok((await v.exportBackup(bk, 'Backup-Password-1234')).ok, 'vault: експорт резервної копії');
  const btxt = fs.readFileSync(bk, 'utf8');
  ok(!btxt.includes('a.example.com') && !btxt.includes('p2'), 'vault: резервна копія зашифрована');
  const dir2 = tmp('vault3');
  const v2 = new Vault({ dir: dir2 });
  await v2.create('Another-Master-Pass-5!');
  ok(!(await v2.importBackup(bk, 'wrong-backup-password')).ok, 'vault: хибний пароль копії відхилено');
  const imp = await v2.importBackup(bk, 'Backup-Password-1234');
  ok(imp.ok && imp.added === 1 && v2.list().length === 1, 'vault: відновлення з резервної копії на іншому «пристрої»');

  // CSV
  const csv = 'name,url,username,password,note\nA,https://x.example.com,bob,"p,w""d",hi\nB,http://insecure.com,c,d,\nC,javascript:alert(1),e,f,\n';
  const r = v2.importCsv(csv);
  ok(r.ok && r.added === 1 && r.skipped === 2, 'vault: імпорт CSV пропускає небезпечні адреси');
  ok(v2.find('https://x.example.com', 'bob').password === 'p,w"d', 'vault: CSV з лапками розібрано правильно');

  // генератор
  const g = v.generate({ length: 24 });
  ok(g.length === 24 && /[a-z]/.test(g) && /[A-Z]/.test(g) && /\d/.test(g) && /[^\w]/.test(g), 'vault: генератор паролів');
  ok(v.generate() !== v.generate(), 'vault: генератор випадковий');

  // автоблокування
  v.setAutolock(1); v.autolockMs = 50; v.touch();
  await sleep(150);
  ok(v.status() === 'locked', 'vault: автоблокування за таймером');
}

async function syncTests() {
  const folder = tmp('syncfolder');
  const mk = (n) => {
    const dir = tmp('dev' + n);
    let items = [];
    const s = new Sync({ dir, bookmarks: { get: () => items, set: (a) => { items = a; } } });
    return { s, get items() { return items; }, set items(v) { items = v; }, dir };
  };
  const A = mk('A'), B = mk('B');
  const now = Date.now();
  A.items = [{ url: 'https://a.example.com/', title: 'A', added: now - 5000, mod: now - 5000 }];
  B.items = [{ url: 'https://b.example.com/', title: 'B', added: now - 4000, mod: now - 4000 }];

  await A.s.enable(folder, 'sync-passphrase-ABC123');
  const file = path.join(folder, FILE_NAME);
  const txt = fs.readFileSync(file, 'utf8');
  ok(!txt.includes('example.com') && !txt.includes('"A"'), 'sync: у спільній папці лише шифротекст');
  let wrong = '';
  try { await B.s.enable(folder, 'wrong-passphrase-XYZ999'); } catch (e) { wrong = e.message; }
  ok(/парольна фраза|розшифр/i.test(wrong), 'sync: хибна парольна фраза відхилена');
  await B.s.enable(folder, 'sync-passphrase-ABC123');
  ok(B.items.length === 2, 'sync: пристрій B отримав закладки A і зберіг свої');
  await A.s.syncNow();
  ok(A.items.length === 2, 'sync: пристрій A отримав закладки B');

  // видалення поширюється (надгробок)
  B.items = B.items.filter(x => x.url !== 'https://a.example.com/');
  B.s.tomb()['https://a.example.com/'] = Date.now();
  await B.s.syncNow();
  await A.s.syncNow();
  ok(A.items.length === 1 && A.items[0].url === 'https://b.example.com/', 'sync: видалення поширилось');

  // конфлікт: новіша зміна перемагає
  A.items[0].title = 'older'; A.items[0].mod = Date.now() - 1000;
  B.items[0].title = 'newer'; B.items[0].mod = Date.now();
  await A.s.syncNow(); await B.s.syncNow(); await A.s.syncNow();
  ok(A.items[0].title === 'newer' && B.items[0].title === 'newer', 'sync: перемагає новіша зміна');

  // підміна файлу
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ct = Buffer.from(j.ct, 'base64'); ct[3] ^= 1; j.ct = ct.toString('base64');
  fs.writeFileSync(file, JSON.stringify(j));
  await A.s.syncNow();
  ok(/розшифр/i.test(A.s.state.data.lastError), 'sync: підміну файлу виявлено, дані не змінено');
  ok(A.items.length === 1, 'sync: локальні закладки не зіпсовано після атаки');
  A.s.disable(); B.s.disable();
}

async function e2eTests(ctx) {
  const w = [...ctx.windows][0];
  const v = ctx.vault;
  // вимикаємо реальні дані користувача: тестове сховище в тимчасовій папці
  const dir = tmp('e2e');
  const real = ctx.vault;
  ctx.vault = new Vault({ dir, onChange: () => ctx.pushAll() });
  const vault = ctx.vault;
  await vault.create('E2E-Master-Password-42!');

  const pages = {
    '/login': '<html><body><form id=f action="/done" method=post><input id=u name=username type=text><input id=p name=password type=password><button id=go type=submit>Go</button></form></body></html>',
    '/done': '<html><body>done</body></html>',
  };
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(pages[req.url.split('?')[0]] || 'x'); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const origin = `http://127.0.0.1:${port}`;

  w.exec('newTab');
  w.exec('go', origin + '/login');
  await sleep(1500);
  const wc = w.wc();

  // сторінка не бачить внутрішніх API
  ok(await wc.executeJavaScript('typeof window.w3ir + typeof window.api + typeof window.require') === 'undefinedundefinedundefined', 'e2e: сторінка не бачить API браузера і Node');

  // недовірена подія submit від скрипту сторінки НЕ перехоплюється
  await wc.executeJavaScript(`document.getElementById('u').value='mallory'; document.getElementById('p').value='fake'; document.getElementById('f').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
  await sleep(300);
  ok(w.pendingSave === null, 'e2e: програмна імітація submit не викликає запит на збереження');

  // справжній клік користувача
  await wc.executeJavaScript(`document.getElementById('u').value='alice'; document.getElementById('p').value='Hunter2-correct'; document.getElementById('f').addEventListener('submit', e => e.preventDefault());`);
  const rect = await wc.executeJavaScript(`(() => { const r = document.getElementById('go').getBoundingClientRect(); return {x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)}; })()`);
  wc.sendInputEvent({ type: 'mouseDown', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await sleep(500);
  ok(!!w.pendingSave && w.pendingSave.username === 'alice' && w.pendingSave.origin === origin, 'e2e: справжній вхід перехоплено, origin визначено браузером');

  w.exec('vaultSaveAnswer', 'save');
  await sleep(300);
  const entries = vault.list(origin);
  ok(entries.length === 1 && vault.get(entries[0].id).password === 'Hunter2-correct', 'e2e: пароль збережено у сховищі');
  ok(w.pendingSave === null, 'e2e: запит на збереження закрито');

  // автозаповнення: тільки на тому самому origin
  w.exec('go', origin + '/login');
  await sleep(1200);
  w.exec('vaultFill', entries[0].id);
  await sleep(500);
  const filled = await w.wc().executeJavaScript(`document.getElementById('u').value + '|' + document.getElementById('p').value`);
  ok(filled === 'alice|Hunter2-correct', 'e2e: автозаповнення на правильній сторінці');

  // інший origin (інший порт) — заповнення має бути відхилено
  const srv2 = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(pages['/login']); });
  await new Promise(r => srv2.listen(0, '127.0.0.1', r));
  w.exec('go', `http://127.0.0.1:${srv2.address().port}/login`);
  await sleep(1200);
  w.exec('vaultFill', entries[0].id);
  await sleep(500);
  const phish = await w.wc().executeJavaScript(`document.getElementById('u').value + '|' + document.getElementById('p').value`);
  ok(phish === '|', 'e2e: на сторінці з іншим origin пароль НЕ підставлено');

  // заблоковане сховище не заповнює
  vault.lock();
  w.exec('go', origin + '/login');
  await sleep(1200);
  w.exec('vaultFill', entries[0].id);
  await sleep(400);
  ok(await w.wc().executeJavaScript(`document.getElementById('p').value`) === '', 'e2e: заблоковане сховище нічого не заповнює');

  // внутрішній API недоступний з вебсторінки (немає window.w3ir) — і з w3ir://settings немає доступу до vault:*
  w.exec('openPage', 'settings');
  await sleep(1200);
  const denied = await w.wc().executeJavaScript(`w3ir.invoke('vault:list').then(() => 'allowed', () => 'denied')`);
  ok(denied === 'denied', 'e2e: сторінка налаштувань не має доступу до сховища паролів');
  const deniedSync = await (async () => { w.exec('openPage', 'history'); await sleep(1000); return w.wc().executeJavaScript(`w3ir.invoke('sync:status').then(() => 'allowed', () => 'denied')`); })();
  ok(deniedSync === 'denied', 'e2e: сторінка історії не має доступу до синхронізації');

  srv.close(); srv2.close();
  ctx.vault = real;
}

async function torrentTests(ctx) {
  const { shell } = require('electron');
  const w = [...ctx.windows][0];
  const calls = [];
  const origOpen = shell.openExternal, origName = app.getApplicationNameForProtocol;
  shell.openExternal = async (u) => { calls.push(u); };
  app.getApplicationNameForProtocol = () => 'TestClient';
  const cfg = ctx.cfg();
  const prev = cfg.torrentConfirm;
  cfg.torrentConfirm = false;
  const hash = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';
  await w.openMagnet(`magnet:?xt=urn:btih:${hash}&dn=Ubuntu&tr=udp%3A%2F%2Ftracker.example.org%3A1337`);
  ok(calls.length === 1, 'torrent: коректне magnet передано зовнішньому клієнту');
  await w.openMagnet('magnet:?xt=urn:btih:abc');
  await w.openMagnet(`magnet:?xt=urn:btih:${hash}" --flag`);
  await w.openMagnet(`magnet:?xt=urn:btih:${hash}&dn=a b`);
  await w.openMagnet(`magnet:?xt=urn:btih:${hash}&x=${String.fromCharCode(92)}`);
  await w.openMagnet('javascript:alert(1)');
  ok(calls.length === 1, 'torrent: некоректні та небезпечні magnet (лапки, пробіли, \\) відхилено');
  w.navigate(w.active(), `magnet:?xt=urn:btih:${hash}`);
  await sleep(200);
  ok(calls.length === 2, 'torrent: magnet з адресного рядка не шукається в Google, а йде у клієнт');
  w.openExternal('mailto:a@b.c" calc.exe');
  await sleep(100);
  ok(calls.length === 2, 'torrent: ін\u2019єкція лапок у mailto відхилена');
  app.getApplicationNameForProtocol = () => '';
  await new Promise((resolve) => { const t = setTimeout(resolve, 300); w.openMagnet(`magnet:?xt=urn:btih:${hash}`); });
  ok(calls.length === 2, 'torrent: без клієнта нічого не запускається');
  shell.openExternal = origOpen; app.getApplicationNameForProtocol = origName; cfg.torrentConfirm = prev;
}

async function importTests(ctx) {
  const { DatabaseSync } = require('node:sqlite');
  const imp = require('../src/importer');
  const { Store } = require('../src/store');
  const base = tmp('imp');
  const localApp = path.join(base, 'local'), roaming = path.join(base, 'roaming');
  const profile = path.join(localApp, 'Google', 'Chrome', 'User Data', 'Default');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(path.dirname(profile), 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Тест' } } } }));
  const webkit = (ms) => (ms + 11644473600000) * 1000;
  const t2023 = Date.UTC(2023, 0, 1), t2024 = Date.UTC(2024, 5, 15);
  fs.writeFileSync(path.join(profile, 'Bookmarks'), JSON.stringify({ roots: {
    bookmark_bar: { type: 'folder', children: [
      { type: 'url', name: 'A site', url: 'https://a.example/', date_added: String(webkit(t2023)) },
      { type: 'folder', name: 'dir', children: [{ type: 'url', name: 'B nested', url: 'https://b.example/page?x=1' }] },
      { type: 'url', name: 'evil', url: 'javascript:alert(1)' },
      { type: 'url', name: 'chrome internal', url: 'chrome://settings' },
    ] },
    other: { type: 'folder', children: [{ type: 'url', name: 'Other', url: 'http://c.example/' }] },
  } }));
  const hdb = new DatabaseSync(path.join(profile, 'History'));
  hdb.exec('CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER)');
  const ins = hdb.prepare('INSERT INTO urls(url,title,visit_count,typed_count,last_visit_time,hidden) VALUES (?,?,?,?,?,?)');
  ins.run('https://news.example/', 'News', 7, 0, webkit(t2024), 0);
  ins.run('https://hidden.example/', 'Hidden', 1, 0, webkit(t2024), 1);
  ins.run('chrome://settings/', 'Settings', 1, 0, webkit(t2024), 0);
  ins.run('https://old.example/', 'Old', 2, 0, webkit(t2023), 0);
  hdb.close();

  const ffp = path.join(roaming, 'Mozilla', 'Firefox', 'Profiles', 'abcd1234.default-release');
  fs.mkdirSync(ffp, { recursive: true });
  const fdb = new DatabaseSync(path.join(ffp, 'places.sqlite'));
  fdb.exec('CREATE TABLE moz_places(id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, hidden INTEGER, last_visit_date INTEGER)');
  fdb.exec('CREATE TABLE moz_bookmarks(id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER, title TEXT, dateAdded INTEGER)');
  fdb.prepare('INSERT INTO moz_places(url,title,visit_count,hidden,last_visit_date) VALUES (?,?,?,?,?)').run('https://ff.example/', 'FF page', 3, 0, t2024 * 1000);
  fdb.prepare('INSERT INTO moz_places(url,title,visit_count,hidden,last_visit_date) VALUES (?,?,?,?,?)').run('place:type=6', 'Query', 1, 0, null);
  fdb.prepare('INSERT INTO moz_bookmarks(type,fk,parent,title,dateAdded) VALUES (1,1,2,?,?)').run('FF bookmark', t2023 * 1000);
  fdb.prepare('INSERT INTO moz_bookmarks(type,fk,parent,title,dateAdded) VALUES (1,2,2,?,?)').run('Smart', t2023 * 1000);
  fdb.prepare('INSERT INTO moz_bookmarks(type,fk,parent,title,dateAdded) VALUES (2,NULL,1,?,?)').run('Folder', t2023 * 1000);
  fdb.close();

  const opts = { localAppData: localApp, appData: roaming };
  const found = imp.detect(opts);
  ok(found.length === 2 && found.some(s => s.kind === 'chromium' && s.name === 'Тест (Default)') && found.some(s => s.kind === 'firefox'), 'import: профілі Chrome і Firefox знайдено');
  ok(imp.findSource('../../Windows', opts) === null && imp.findSource('chrome:../x', opts) === null, 'import: довільний шлях замість id відхилено');

  const chrome = found.find(s => s.kind === 'chromium'), ff = found.find(s => s.kind === 'firefox');
  const cb = imp.readBookmarks(chrome);
  ok(cb.length === 3 && cb.every(b => /^https?:/.test(b.url)), 'import: закладки Chrome (вкладені папки), javascript:/chrome:// пропущено');
  ok(cb.find(b => b.url === 'https://a.example/').added === t2023, 'import: дата додавання закладки Chrome конвертована коректно');
  const ch = imp.readHistory(chrome);
  ok(ch.length === 2 && ch.find(h => h.url === 'https://news.example/').time === t2024 && ch.find(h => h.url === 'https://news.example/').n === 7, 'import: історія Chrome (час, лічильник; приховані та chrome:// пропущено)');
  const fb = imp.readBookmarks(ff);
  ok(fb.length === 1 && fb[0].title === 'FF bookmark' && fb[0].added === t2023, 'import: закладки Firefox (без папок і place:)');
  const fh = imp.readHistory(ff);
  ok(fh.length === 1 && fh[0].time === t2024 && fh[0].n === 3, 'import: історія Firefox');
  ok(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('w3ir-import-')).length === 0, 'import: тимчасові копії видалено');

  // злиття у сховища (тестові, не користувацькі)
  const realB = ctx.bookmarksStore, realH = ctx.historyStore;
  ctx.bookmarksStore = new Store('t-bm', [], base);
  ctx.historyStore = new Store('t-hist', [], base);
  ctx.bookmarksStore.data.push({ url: 'https://a.example/', title: 'mine', added: 1, mod: 1 });
  const r1 = ctx.importBookmarks(cb.concat(fb));
  ok(r1.added === 3 && r1.skipped === 1 && ctx.bookmarks().find(b => b.url === 'https://a.example/').title === 'mine', 'import: наявні закладки не перезаписуються');
  const r2 = ctx.importHistory(ch.concat(fh));
  ok(r2.added === 3 && ctx.history().length === 3, 'import: історію додано');
  const r3 = ctx.importHistory(ch.concat(fh));
  ok(r3.added === 0 && ctx.history().length === 3, 'import: повторний імпорт історії без дублікатів');
  const times = ctx.history().map(h => h.time);
  ok(times.every((t, i) => i === 0 || times[i - 1] <= t), 'import: історія залишається відсортованою за часом');
  ok(ctx.topSites(5).some(s => s.url === 'https://news.example/'), 'import: популярні сайти враховують кількість візитів');
  ctx.bookmarksStore.flush(); ctx.historyStore.flush();
  ctx.bookmarksStore = realB; ctx.historyStore = realH;
}

async function profileTests(ctx) {
  const m = ctx.manager;
  const id = m.create('Тест-профіль', '#e5675f');
  const c2 = m.ctx(id);
  ok(c2.dir !== ctx.dir && fs.existsSync(c2.dir) && c2.vault.dir === c2.dir && c2.sync.dir === c2.dir, 'profiles: у профілю власна папка даних, сховище паролів і синхронізація');
  ok(c2.session !== ctx.session, 'profiles: окремий сеанс (cookie, кеш)');

  await ctx.session.cookies.set({ url: 'https://iso.example/', name: 'a', value: '1' });
  const seen = await c2.session.cookies.get({ url: 'https://iso.example/' });
  ok(seen.length === 0, 'profiles: cookie основного профілю недоступні в іншому');
  await ctx.session.cookies.remove('https://iso.example/', 'a');

  c2.bookmarkSet('https://p2.example/', 'P2');
  ok(c2.bookmarks().length === 1 && !ctx.bookmarks().some(b => b.url === 'https://p2.example/'), 'profiles: закладки ізольовані');
  ok(c2.history() !== ctx.history() && c2.vault !== ctx.vault, 'profiles: історія та сховище паролів ізольовані');

  const w2 = m.open(id);
  await sleep(2500);
  ok(w2.ses === c2.session && !ctx.windows.has(w2) && c2.windows.has(w2), 'profiles: вікно профілю працює у власному сеансі');
  ok(m.ctxOf(w2.chrome) === c2 && m.ctxOf([...ctx.windows][0].chrome) === ctx, 'profiles: IPC маршрутизується до правильного профілю');
  ok(w2.sendState && true, 'profiles: вікно профілю створено');
  const st = await new Promise((resolve) => { w2.chrome.once('did-finish-load', () => {}); resolve(c2.profile()); });
  ok(st.id === id && st.name === 'Тест-профіль', 'profiles: інформація про профіль у стані вікна');

  let dup = false; try { m.create('тест-ПРОФІЛЬ'); } catch { dup = true; }
  ok(dup, 'profiles: дубль назви відхилено');
  let delDefault = false; try { await m.remove('default'); } catch { delDefault = true; }
  ok(delDefault && m.has('default'), 'profiles: основний профіль видалити не можна');
  ok(!m.has('../evil') && (() => { try { m.ctx('../evil'); return false; } catch { return true; } })(), 'profiles: невідомий id (шлях) відхилено');

  const dir = c2.dir;
  await m.remove(id);
  await sleep(300);
  ok(!fs.existsSync(dir) && !m.has(id) && !m.ctxs.has(id), 'profiles: видалення прибирає всі дані профілю');
}

async function githubTests(ctx) {
  const { GitHub, htmlFromApi, githubRepo } = require('../src/github');
  const calls = [];
  const notif = [
    { id: '11', reason: 'review_requested', updated_at: '2026-01-01T00:00:00Z', subject: { title: 'Fix <b>bug</b>', type: 'PullRequest', url: 'https://api.github.com/repos/o/r/pulls/5' }, repository: { full_name: 'o/r', html_url: 'https://github.com/o/r' } },
    { id: '12', reason: 'mention', updated_at: '2026-01-02T00:00:00Z', subject: { title: 'Evil', type: 'Issue', url: 'https://evil.example/repos/o/r/issues/9' }, repository: { full_name: 'o/r', html_url: 'https://evil.example/o/r' } },
    { id: '13', reason: 'subscribed', updated_at: '2026-01-03T00:00:00Z', subject: { title: 'Release', type: 'Release', url: 'https://api.github.com/repos/o/r/releases/77' }, repository: { full_name: 'o/r', html_url: 'https://github.com/o/r' } },
  ];
  const srv = http.createServer((req, res) => {
    calls.push(req.method + ' ' + req.url + ' auth=' + (req.headers.authorization || ''));
    const send = (code, body, h = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== 'Bearer ghp_validtoken1234567890abcdef') return send(401, { message: 'Bad credentials' });
    if (req.url === '/user') return send(200, { login: 'octo' });
    if (req.url.startsWith('/notifications?')) {
      if (req.headers['if-none-match'] === '"v1"') { res.writeHead(304); return res.end(); }
      return send(200, notif, { etag: '"v1"', 'x-poll-interval': '60' });
    }
    if (req.url.startsWith('/search/issues')) return send(200, { items: [
      { title: 'Review me', number: 7, html_url: 'https://github.com/o/r/pull/7', repository_url: 'https://api.github.com/repos/o/r', updated_at: '2026-01-04T00:00:00Z' },
      { title: 'Phish', number: 8, html_url: 'https://github.com.evil.example/o/r/pull/8', repository_url: 'https://api.github.com/repos/o/r', updated_at: '2026-01-04T00:00:00Z' },
    ] });
    if (req.method === 'PATCH' || req.method === 'PUT') { res.writeHead(205); return res.end(); }
    send(404, {});
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const dir = tmp('gh');
  const g = new GitHub({ dir, apiBase: `http://127.0.0.1:${srv.address().port}`, allowInsecure: true });

  let bad = ''; try { await g.connect('ghp_wrongtoken1234567890abcdef'); } catch (e) { bad = e.message; }
  ok(/відхилив/.test(bad) && !g.connected(), 'github: недійсний токен відхилено');
  let fmt = false; try { await g.connect('x y"z'); } catch { fmt = true; }
  ok(fmt, 'github: токен некоректного формату відхилено');

  const token = 'ghp_validtoken1234567890abcdef';
  const st = await g.connect(token);
  await sleep(600);
  ok(st.login === 'octo' && g.connected(), 'github: підключення, логін отримано');
  ok(!fs.readFileSync(path.join(dir, 'github.token')).toString('latin1').includes(token), 'github: токен на диску зашифрований (DPAPI)');
  ok(g.state.notifications.length === 2 && g.state.notifications.every(n => /^https:\/\/github\.com\//.test(n.url)), 'github: сповіщення з коректними html-адресами, підроблений домен відкинуто');
  ok(g.state.notifications.find(n => n.id === '11').url === 'https://github.com/o/r/pull/5' && g.state.notifications.find(n => n.id === '13').url === 'https://github.com/o/r/releases', 'github: API-адреси перетворено на сторінки (pull, releases)');
  ok(g.state.reviews.length === 1 && g.state.reviews[0].number === 7, 'github: запити на рев\u2019ю (фішинговий домен відкинуто)');
  ok(g.count() === 3, 'github: лічильник для значка');
  const json = JSON.stringify(g.panel());
  ok(!json.includes(token), 'github: токен не потрапляє у дані для інтерфейсу');
  await g.refresh();
  ok(calls.some(c => c.startsWith('GET /notifications')) && g.interval === 60000, 'github: інтервал опитування з X-Poll-Interval');
  await g.markRead('11');
  ok(g.state.notifications.length === 1, 'github: сповіщення позначено прочитаним');
  await g.markAllRead();
  ok(g.state.notifications.length === 0, 'github: усе позначено прочитаним');
  let insecure = false; const g2 = new GitHub({ dir: tmp('gh2'), apiBase: 'http://example.com' }); g2.token = token;
  try { await g2._api('GET', '/user'); } catch { insecure = true; }
  ok(insecure, 'github: http API-адресу без дозволу заборонено (токен не піде відкритим текстом)');
  g.disconnect();
  ok(!g.connected() && !fs.existsSync(path.join(dir, 'github.token')), 'github: відключення видаляє токен');
  srv.close();

  ok(htmlFromApi('https://api.github.com/repos/a/b/issues/3', null) === 'https://github.com/a/b/issues/3', 'github: htmlFromApi issues');
  ok(htmlFromApi('https://evil.example/repos/a/b/issues/3', 'https://evil.example/a/b') === null, 'github: htmlFromApi відкидає чужі домени');
  const gr = githubRepo('https://github.com/microsoft/vscode/blob/main/src/a.ts');
  ok(gr && gr.owner === 'microsoft' && gr.kind === 'blob' && gr.rest[0] === 'main', 'github: розбір адреси репозиторію');
  ok(githubRepo('https://github.com/settings/profile') === null && githubRepo('https://github.com.evil.example/a/b') === null && githubRepo('http://github.com/a/b') === null, 'github: службові сторінки та підроблені домени не розпізнаються');

  // ключові слова адресного рядка
  ok(ctx.resolveInput('gh microsoft/vscode') === 'https://github.com/microsoft/vscode', 'keywords: gh owner/repo');
  ok(ctx.resolveInput('ghi microsoft/vscode') === 'https://github.com/microsoft/vscode/issues', 'keywords: ghi');
  ok(/github\.com\/search\?q=hello%20world&type=repositories/.test(ctx.resolveInput('gh hello world')), 'keywords: gh пошук репозиторіїв');
  ok(ctx.resolveInput('npm react') === 'https://www.npmjs.com/search?q=react', 'keywords: npm');
  ok(/google\.com\/search\?q=so%20far/.test(ctx.resolveInput('so far so good')), 'keywords: звичайні запити («so …») не перехоплюються');
  const prevKw = ctx.cfg().keywords;
  ctx.cfg().keywords = 'rust = https://doc.rust-lang.org/std/?search=%s\nbad = javascript:alert(%s)';
  ok(ctx.resolveInput('rust vec push') === 'https://doc.rust-lang.org/std/?search=vec%20push', 'keywords: власне ключове слово');
  ok(!/^javascript:/.test(ctx.resolveInput('bad x')), 'keywords: небезпечні шаблони (javascript:) ігноруються');
  ctx.cfg().keywords = prevKw;
}

async function walletTests(ctx) {
  const E = require('ethers');
  const { Wallet: W, describeCall, isSafeRpc } = require('../src/wallet');
  const { Store } = require('../src/store');
  const MASTER = 'Wallet-Master-Pass-55!';

  // --- модульні перевірки ---
  const MAX = E.MaxUint256;
  const iface = new E.Interface(['function approve(address,uint256)', 'function setApprovalForAll(address,bool)']);
  const spender = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  ok(describeCall(iface.encodeFunctionData('approve', [spender, MAX])).warnings.some(w => /Необмежений/.test(w)), 'wallet: необмежений approve розпізнається й має попередження');
  ok(!describeCall(iface.encodeFunctionData('approve', [spender, 1000n])).warnings.length, 'wallet: обмежений approve без тривоги');
  ok(describeCall(iface.encodeFunctionData('setApprovalForAll', [spender, true])).warnings.some(w => /ВСІ/.test(w)), 'wallet: setApprovalForAll(true) — попередження про ВСІ NFT');
  ok(describeCall('0xdeadbeef00').warnings.length === 1, 'wallet: невідомий виклик контракту має попередження');
  ok(isSafeRpc('https://rpc.example') && isSafeRpc('http://127.0.0.1:8545') && !isSafeRpc('http://evil.example') && !isSafeRpc('javascript:alert(1)'), 'wallet: безпечні/небезпечні RPC-адреси');

  // --- ізоляція від реальних даних користувача ---
  const real = { vault: ctx.vault, wallet: ctx.wallet, settings: ctx.settingsStore };
  ctx.settingsStore = new Store('t-wallet-settings', JSON.parse(JSON.stringify(real.settings.data)), tmp('wset'));
  ctx.vault = new Vault({ dir: tmp('wvault'), onChange: () => { ctx.pushAll(); ctx.wallet.onVaultChange(); } });
  ctx.wallet = new W(ctx, { allowInsecureRpc: true });
  const wal = ctx.wallet;
  await ctx.vault.create(MASTER);
  ok(!wal.exists(), 'wallet: до створення гаманця немає');
  let bad = ''; try { wal.importPhrase('not a valid phrase at all'); } catch (e) { bad = e.message; }
  ok(/Некоректна фраза/.test(bad), 'wallet: некоректна фраза відхилена');
  const phrase = wal.create();
  const addr0 = wal.section().addresses[0];
  const priv0 = wal._derive(phrase, 0).privateKey;
  ok(phrase.split(' ').length === 12 && E.isAddress(addr0) && wal.exists(), 'wallet: створення (12 слів, адреса)');
  const raw = require('fs').readFileSync(path.join(ctx.vault.dir, 'vault.bin'), 'utf8');
  ok(!raw.includes(phrase.split(' ')[0] + ' ') && !raw.includes(addr0), 'wallet: у файлі сховища немає відкритих даних гаманця');

  // --- мок RPC ---
  const rawTxs = [];
  const rpc = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const one = (j) => {
        const r = (result) => ({ jsonrpc: '2.0', id: j.id, result });
        switch (j.method) {
          case 'eth_chainId': return r('0x7a69');
          case 'net_version': return r('31337');
          case 'eth_getBalance': return r('0x56bc75e2d63100000');
          case 'eth_blockNumber': return r('0x10');
          case 'eth_getBlockByNumber': return r({ number: '0x10', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), timestamp: '0x65000000', nonce: '0x0000000000000000', difficulty: '0x0', gasLimit: '0x1c9c380', gasUsed: '0x0', miner: '0x' + '00'.repeat(20), extraData: '0x', baseFeePerGas: '0x3b9aca00', transactions: [], mixHash: '0x' + '00'.repeat(32), sha3Uncles: '0x' + '00'.repeat(32), logsBloom: '0x' + '00'.repeat(256), stateRoot: '0x' + '00'.repeat(32), receiptsRoot: '0x' + '00'.repeat(32), transactionsRoot: '0x' + '00'.repeat(32), size: '0x100', uncles: [] });
          case 'eth_maxPriorityFeePerGas': return r('0x59682f00');
          case 'eth_gasPrice': return r('0x3b9aca00');
          case 'eth_getTransactionCount': return r('0x5');
          case 'eth_estimateGas': return r('0x5208');
          case 'eth_call': return r('0x');
          case 'eth_sendRawTransaction': rawTxs.push(j.params[0]); return r(E.keccak256(j.params[0]));
          default: return { jsonrpc: '2.0', id: j.id, error: { code: -32601, message: 'no ' + j.method } };
        }
      };
      let json; try { json = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(json) ? json.map(one) : one(json)));
    });
  });
  await new Promise(r => rpc.listen(0, '127.0.0.1', r));
  const section = wal.section();
  section.networks.push({ chainId: 31337, name: 'Test', symbol: 'TST', rpc: `http://127.0.0.1:${rpc.address().port}`, explorer: '' });
  section.activeChain = 31337;
  ctx.vault.persist();
  ctx.cfg().walletChain = 31337;

  // --- сайти-dApp: A без CSP-обмежень, B із суворим CSP ---
  const html = '<html><head><title>dapp</title></head><body>dapp</body></html>';
  const mkSite = async (csp) => {
    const s = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); if (csp) res.setHeader('content-security-policy', csp); res.end(html); });
    await new Promise(r => s.listen(0, '127.0.0.1', r));
    return { s, url: `http://127.0.0.1:${s.address().port}/` , origin: `http://127.0.0.1:${s.address().port}` };
  };
  const A = await mkSite(null);
  const B = await mkSite("default-src 'none'; script-src 'none'");

  const w = [...ctx.windows][0];
  const waitApproval = async () => { for (let i = 0; i < 60 && !w.approval; i++) await sleep(100); return w.approval; };
  const leaks = [];
  const scan = (x) => { const s = JSON.stringify(x); if (s.includes(priv0) || s.includes(phrase.split(' ').slice(0, 3).join(' '))) leaks.push(s.slice(0, 80)); };
  const call = (wc, method, params) => wc.executeJavaScript(`ethereum.request(${JSON.stringify({ method, params })}).then(r => ({ ok: r }), e => ({ err: e.code, msg: String(e.message) }))`);
  const decide = async (approve, master) => { const a = w.approval; scan(a.spec); const r = await w.decide(a.id, approve, master); return r; };

  w.exec('newTab'); w.exec('go', A.url); await sleep(1800);
  const wcA = w.wc();
  ok(await wcA.executeJavaScript('typeof window.ethereum') === 'object' && await wcA.executeJavaScript('window.ethereum.isW3IR === true'), 'wallet: провайдер window.ethereum доступний сторінці');
  ok(await wcA.executeJavaScript(`new Promise(r => { addEventListener('eip6963:announceProvider', e => r(e.detail.info.rdns)); dispatchEvent(new Event('eip6963:requestProvider')); })`) === 'app.w3ir.wallet', 'wallet: EIP-6963 анонсує гаманець');
  ok((await wcA.executeJavaScript(`Object.keys(window).filter(k => k.startsWith('__w3ir')).length`)) === 0, 'wallet: внутрішній міст не лишається у глобальному об\u2019єкті сторінки');
  ok((await call(wcA, 'eth_chainId')).ok === '0x7a69' && (await call(wcA, 'eth_accounts')).ok.length === 0, 'wallet: chainId доступний, рахунків до підключення немає');

  // підключення
  let pr = call(wcA, 'eth_requestAccounts');
  const ap = await waitApproval();
  ok(ap && ap.spec.kind === 'connect' && ap.spec.origin === A.origin, 'wallet: запит підключення показано з коректним origin (визначає браузер)');
  ok(w.overlayType === 'approve', 'wallet: підтвердження показується довіреним оверлеєм');
  await decide(true, MASTER);
  let res = await pr;
  ok(Array.isArray(res.ok) && res.ok[0] === addr0, 'wallet: після підтвердження сайт бачить лише адресу');
  scan(res);
  ok((await call(wcA, 'eth_accounts')).ok[0] === addr0, 'wallet: eth_accounts для підключеного сайту');
  ok((await call(wcA, 'eth_getBalance', [addr0, 'latest'])).ok === '0x56bc75e2d63100000', 'wallet: читання балансу проксується до RPC');
  ok((await call(wcA, 'eth_subscribe', ['newHeads'])).err === 4200 && (await call(wcA, 'eth_sign', [addr0, '0x00'])).err === 4200, 'wallet: eth_sign та невідомі методи заборонені');
  ok((await call(wcA, 'eth_sendRawTransaction', ['0x00'])).err === 4200, 'wallet: пряма відправка сирих транзакцій з сайту заборонена');

  // підпис повідомлення
  pr = call(wcA, 'personal_sign', [E.hexlify(E.toUtf8Bytes('hello w3ir')), addr0]);
  const ap2 = await waitApproval();
  ok(ap2.spec.lines.some(l => l[1] === 'hello w3ir'), 'wallet: текст повідомлення показано користувачу');
  await decide(true, MASTER);
  res = await pr;
  ok(E.verifyMessage('hello w3ir', res.ok) === addr0, 'wallet: підпис повідомлення коректний');

  // транзакція
  const to = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  pr = call(wcA, 'eth_sendTransaction', [{ from: addr0, to, value: '0xde0b6b3a7640000' }]);
  const ap3 = await waitApproval();
  ok(ap3.spec.lines.some(l => l[0] === 'Кому' && l[1] === to) && ap3.spec.lines.some(l => l[0] === 'Сума' && /^1\.0 TST/.test(l[1])), 'wallet: у підтвердженні транзакції — отримувач і сума');
  await decide(true, MASTER);
  res = await pr;
  const sent = rawTxs[rawTxs.length - 1];
  const tx = sent && E.Transaction.from(sent);
  ok(res.ok && tx && tx.from === addr0 && tx.to === to && tx.value === 10n ** 18n && tx.chainId === 31337n && res.ok === E.keccak256(sent), 'wallet: транзакцію підписано ключем гаманця та надіслано в мережу');

  // небезпечні виклики: попередження + відхилення
  const token = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
  pr = call(wcA, 'eth_sendTransaction', [{ from: addr0, to: token, data: iface.encodeFunctionData('approve', [spender, MAX]) }]);
  const ap4 = await waitApproval();
  ok(ap4.spec.warnings.some(x => /Необмежений/.test(x)) && ap4.spec.danger === true, 'wallet: необмежений approve — червоне попередження');
  await decide(false);
  res = await pr;
  ok(res.err === 4001 && rawTxs.length === 1, 'wallet: відхилення → код 4001, нічого не надіслано');
  pr = call(wcA, 'eth_sendTransaction', [{ from: addr0, to: token, data: iface.encodeFunctionData('setApprovalForAll', [spender, true]) }]);
  const ap5 = await waitApproval();
  ok(ap5.spec.warnings.some(x => /ВСІ/.test(x)), 'wallet: setApprovalForAll — попередження про ВСІ NFT');
  await decide(false);
  await pr;

  // типізовані дані
  const td = { types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }], Mail: [{ name: 'to', type: 'string' }] }, primaryType: 'Mail', domain: { name: 'T', chainId: 1 }, message: { to: 'bob' } };
  res = await call(wcA, 'eth_signTypedData_v4', [addr0, JSON.stringify(td)]);
  ok(res.err === -32602 && !w.approval, 'wallet: підпис для іншого chainId відхилено без запиту');
  td.domain.chainId = 31337;
  pr = call(wcA, 'eth_signTypedData_v4', [addr0, JSON.stringify(td)]);
  await waitApproval();
  await decide(true, MASTER);
  res = await pr;
  const { EIP712Domain, ...tt } = td.types;
  ok(E.verifyTypedData(td.domain, tt, td.message, res.ok) === addr0, 'wallet: підпис EIP-712 коректний');

  // зміна та додавання мереж
  res = await call(wcA, 'wallet_switchEthereumChain', [{ chainId: '0x539' }]);
  ok(res.err === 4902, 'wallet: невідома мережа → 4902');
  res = await call(wcA, 'wallet_addEthereumChain', [{ chainId: '0x539', chainName: 'X', rpcUrls: ['javascript:alert(1)'], nativeCurrency: { symbol: 'X' } }]);
  ok(res.err === -32602, 'wallet: додавання мережі з небезпечним RPC відхилено');

  // інший сайт (B, суворий CSP): без підключення нічого не підписує
  w.exec('newTab'); w.exec('go', B.url); await sleep(1800);
  const wcB = w.wc();
  ok(await wcB.executeJavaScript('typeof window.ethereum') === 'object', 'wallet: провайдер працює навіть на сторінці з суворим CSP');
  ok((await call(wcB, 'eth_accounts')).ok.length === 0, 'wallet: інший origin не бачить підключення сайту A');
  for (const [m, p] of [['eth_sendTransaction', [{ from: addr0, to, value: '0x1' }]], ['personal_sign', ['0x00', addr0]], ['eth_signTypedData_v4', [addr0, JSON.stringify(td)]]]) {
    res = await call(wcB, m, p);
    ok(res.err === 4100 && !w.approval, `wallet: ${m} без підключення → 4100, вікно підтвердження не відкривається`);
  }

  // блокування сховища
  ctx.vault.lock();
  await sleep(200);
  w.exec('switchTab', w.tabs.find(t => t.view.webContents === wcA).id);
  ok((await call(wcA, 'eth_accounts')).ok.length === 0, 'wallet: при блокуванні сховища сайти не бачать рахунків');
  res = await call(wcA, 'eth_sendTransaction', [{ from: addr0, to, value: '0x1' }]);
  ok(res.err === 4100 && rawTxs.length === 1, 'wallet: заблокований гаманець нічого не підписує');
  pr = call(wcA, 'eth_requestAccounts');
  const ap6 = await waitApproval();
  ok(ap6.spec.kind === 'connect' && w.approvalPayload(ap6).needsUnlock === true, 'wallet: запит при заблокованому сховищі вимагає майстер-пароль');
  const wrong = await w.decide(ap6.id, true, 'wrong-master-password');
  ok(!wrong.ok && w.approval, 'wallet: хибний майстер-пароль не підтверджує запит');
  ctx.vault.nextAllowed = 0;
  const right = await w.decide(ap6.id, true, MASTER);
  res = await pr;
  ok(right.ok && res.ok && res.ok[0] === addr0, 'wallet: правильний пароль розблоковує та підтверджує');

  // таймаут/закриття
  pr = call(wcA, 'personal_sign', [E.hexlify(E.toUtf8Bytes('x')), addr0]);
  await waitApproval();
  w.closeOverlay();
  res = await pr;
  ok(res.err === 4001, 'wallet: закриття вікна підтвердження = відхилення');

  // інкогніто не отримує провайдера; сторінки з w3ir:// не мають доступу до гаманця крім wallet
  const inc = ctx.openWindow({ incognito: true });
  await sleep(2200);
  inc.exec('go', A.url);
  await sleep(1800);
  ok(await inc.wc().executeJavaScript('typeof window.ethereum') === 'undefined', 'wallet: у вікні інкогніто провайдер недоступний');
  inc.win.close();
  w.exec('openPage', 'settings'); await sleep(1200);
  ok(await w.wc().executeJavaScript(`w3ir.invoke('wallet:status').then(() => 'allowed', () => 'denied')`) === 'denied', 'wallet: сторінка налаштувань не має доступу до API гаманця');
  w.exec('openPage', 'wallet'); await sleep(1200);
  const st = await w.wc().executeJavaScript(`w3ir.invoke('wallet:status')`);
  scan(st);
  ok(st.ok && st.exists && st.info && st.info.accounts[0] === addr0, 'wallet: сторінка гаманця отримує стан (без секретів)');
  ok(st.info.log.length >= 3 && st.info.connections.length >= 1, 'wallet: журнал дій і підключені сайти ведуться');
  ok(leaks.length === 0, 'wallet: приватний ключ і фраза не потрапили в жодне повідомлення/відповідь');

  // відключення сайту
  wal.disconnectSite(A.origin);
  ok((await call(wcA, 'eth_accounts')).ok.length === 0, 'wallet: після відключення сайт знову нічого не бачить');

  A.s.close(); B.s.close(); rpc.close();
  ctx.settingsStore.flush();
  Object.assign(ctx, { vault: real.vault, wallet: real.wallet, settingsStore: real.settings });
}

async function helpTests(ctx) {
  const { withTip } = require('../src/tips');
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
  }))()`);
  ok(stat.sections >= 18 && stat.toc === stat.sections && stat.entries >= 60, `help: довідка містить розділи (${stat.sections}) і статті (${stat.entries})`);
  const must = ['ctrl+k', 'гаманець', 'профіл', 'github', 'magnet', 'режим читання', 'синхронізац', 'https', 'інкогніто', 'імпорт', 'менеджер паролів', 'вертикальні вкладки', 'групи вкладок', 'сплячі вкладки', 'блокування реклами', 'f1'];
  const missing = must.filter(m => !stat.text.includes(m));
  ok(missing.length === 0, 'help: описано всі ключові функції' + (missing.length ? ' — немає: ' + missing.join(', ') : ''));
  const pagesDir = path.join(__dirname, '..', 'pages');
  const broken = stat.hrefs.filter(h => !fs.existsSync(path.join(pagesDir, h.replace('w3ir://', '').replace(/\/$/, '') + '.html')));
  ok(stat.hrefs.length >= 8 && broken.length === 0, 'help: усі внутрішні посилання ведуть на наявні сторінки' + (broken.length ? ' — биті: ' + broken.join(', ') : ''));
  ok(stat.rows >= 30, 'help: таблиця гарячих клавіш заповнена');

  // пошук
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
}

async function updateTests(ctx) {
  const crypto = require('crypto');
  const yaml = require('js-yaml');
  const { autoUpdater } = require('electron-updater');
  const V = require('../src/update-verify');
  const { parseFeed } = require('../src/updater');
  const gen = () => { const k = crypto.generateKeyPairSync('ed25519'); return { pub: k.publicKey.export({ type: 'spki', format: 'pem' }), priv: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) }; };
  const good = gen(), evil = gen();

  // --- підпис ---
  const sig = V.sign(good.priv, '9.0.0', 'AAAA');
  ok(V.verify(good.pub, '9.0.0', 'AAAA', sig), 'update: коректний підпис проходить перевірку');
  ok(!V.verify(good.pub, '9.0.1', 'AAAA', sig) && !V.verify(good.pub, '9.0.0', 'AAAB', sig), 'update: зміна версії або хешу робить підпис недійсним');
  ok(!V.verify(evil.pub, '9.0.0', 'AAAA', sig) && !V.verify(good.pub, '9.0.0', 'AAAA', 'garbage') && !V.verify(good.pub, '9.0.0', 'AAAA', undefined), 'update: чужий ключ і сміття відхиляються');
  const keyPath = path.join(__dirname, '..', 'build', 'keys', 'update-private.pem');
  if (fs.existsSync(keyPath)) ok(V.verify(require('../src/update-key'), '1.0.0', 'XYZ', V.sign(fs.readFileSync(keyPath, 'utf8'), '1.0.0', 'XYZ')), 'update: вбудований публічний ключ відповідає приватному ключу випускача');

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

  ok(require('../src/updater').DEFAULT_FEED === 'github:ech2corrosionrrd/w3ir-browser' && !!parseFeed(require('../src/updater').DEFAULT_FEED), 'update: офіційне джерело за замовчуванням коректне');
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
  const { installerRunning } = require('../src/updater');
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
  const settingsBtn = await w.wc().executeJavaScript(`new Promise(r => setTimeout(() => r([...document.querySelectorAll('button')].map(b => b.textContent)), 800))`);
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
  const { Threats, parseList, parseBlacklistJson } = require('../src/threats');
  const mk = (extra = {}) => new Threats({ dir: tmp('threats'), cfg: () => ({}), history: () => [], bookmarks: () => [], ...extra });
  const t = mk();

  // --- евристики: підозрілі ---
  const bad = [
    ['https://paypa1.com/login', 'lookalike'], ['https://gooogle.com/', 'lookalike'], ['https://githhub.com/', 'lookalike'], ['https://amaz0n.com/', 'lookalike'],
    ['https://paypal.com.evil-site.net/', 'lookalike'], ['https://login.metamask.example-wallet.io/', 'lookalike'],
    ['https://metamask-wallet-claim.xyz/', 'lookalike'], ['https://uniswap-airdrop.xyz/', 'lookalike'],
    ['https://google.com@evil.example/', 'userinfo'],
    [new URL('https://p\u0430ypal.com/').href, 'homograph'], [new URL('https://\u043e\u043a\u0445.com/').href, 'homograph'],
  ];
  for (const [u, kind] of bad) { const r = t.check(u); ok(r && r.kind === kind && r.severity === 'suspicious' && r.canTrust, `threats: підозрілий ${u.slice(0, 48)} → ${kind}`); }
  // --- легітимні сайти не чіпаємо ---
  const good = ['https://www.google.com/', 'https://accounts.google.com/', 'https://www.google.com.ua/', 'https://google.de/', 'https://user.github.io/', 'https://microsoft.github.io/', 'https://paypal.me/x',
    'https://app.uniswap.org/', 'https://metamask.io/download', 'https://diia.gov.ua/', 'https://www.ukr.net/', 'https://example.com/', 'https://xn--d1acpjx3f.xn--p1ai/', 'http://127.0.0.1:8080/',
    'https://github.com/login', 'https://gmail.google.com/', 'https://docs.google.com/', 'https://monobank.ua/', 'https://www.amazon.de/', 'https://opensea.io/', 'https://support.apple.com/', 'file:///c:/x.html'];
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

async function groupTests(ctx) {
  const { GROUP_COLORS } = require('../src/tab-groups');
  const w = ctx.openWindow({});
  await sleep(2500);
  const mk = (url = 'w3ir://newtab') => w.createTab(url, { activate: false });
  const order = () => w.tabs.map(t => t.id);
  const t0 = w.tabs[0];
  const a = mk(), b = mk(), c = mk(), d = mk();
  const contiguous = () => {
    for (const g of w.groupList()) {
      const idx = w.tabs.map((t, i) => (t.group === g.id ? i : -1)).filter(i => i >= 0);
      if (idx[idx.length - 1] - idx[0] !== idx.length - 1) return false;
    }
    return true;
  };

  // --- створення та кольори ---
  const g1 = w.newGroup([d.id, b.id]);
  ok(g1 && b.group === g1 && d.group === g1 && order().join() === [t0.id, a.id, b.id, d.id, c.id].join(), 'groups: група створюється на місці першої вкладки й тримає вкладки підряд');
  const g2 = w.newGroup([a.id]);
  ok(w.group(g1).color !== w.group(g2).color && GROUP_COLORS.some(x => x.key === w.group(g2).color), 'groups: нові групи отримують різні кольори');
  ok(w.setGroupName(g1, '  Робота\u0000\u0007' + 'x'.repeat(100)) && w.group(g1).name.length <= 40 && !/[\u0000-\u001f]/.test(w.group(g1).name) && w.group(g1).name.startsWith('Робота'), 'groups: назва очищується від керівних символів і обмежується 40 символами');
  w.setGroupName(g1, 'Робота');
  ok(!w.setGroupColor(g1, '#ff0000') && !w.setGroupColor(g1, 'javascript:1') && w.group(g1).color !== '#ff0000' && w.setGroupColor(g1, 'red') && w.group(g1).color === 'red', 'groups: приймаються лише відомі кольори');
  ok(!w.setGroupName(9999, 'x') && !w.addToGroup(c.id, 9999), 'groups: операції з неіснуючою групою відхиляються');

  // --- додавання / видалення вкладок ---
  ok(w.addToGroup(c.id, g1) && c.group === g1 && contiguous() && w.groupTabs(g1).map(t => t.id).join() === [b.id, d.id, c.id].join(), 'groups: вкладка додається в кінець групи');
  ok(w.removeFromGroup(d.id) && d.group === null && contiguous() && order().indexOf(d.id) > order().indexOf(c.id) - 1, 'groups: вкладка виходить із групи й стає одразу після неї');
  ok(w.groupTabs(g1).map(t => t.id).join() === [b.id, c.id].join(), 'groups: у групі лишилися решта вкладок');

  // --- закріплені вкладки ---
  w.exec('pinTab', b.id);
  ok(b.pinned && b.group === null && w.newGroup([b.id]) === null && order()[0] === b.id, 'groups: закріплена вкладка виходить із групи й не може до неї входити');
  w.exec('pinTab', b.id);

  // --- перетягування ---
  w.addToGroup(b.id, g1);
  const e = mk();
  w.moveTab({ id: e.id, index: w.tabs.indexOf(w.groupTabs(g1)[1]) }); // між першою та другою вкладками групи — усередину
  ok(e.group === g1 && contiguous(), 'groups: вкладка, кинута між двома вкладками групи, приєднується до неї');
  w.moveTab({ id: e.id, index: w.tabs.length });             // у кінець — з групи
  ok(e.group === null && contiguous(), 'groups: вкладка, перетягнута за межі групи, виходить із неї');

  // --- згортання ---
  w.switchTab(t0.id);
  ok(w.setGroupCollapsed(g1, true) && w.visibleTabs().every(t => t.group !== g1) && w.visibleTabs().length === w.tabs.length - w.groupTabs(g1).length, 'groups: згорнута група ховає свої вкладки');
  w.sendState();
  w.exec('nextTab'); const afterNext = w.activeId;
  ok(![b.id, c.id].includes(afterNext), 'groups: Ctrl+Tab пропускає вкладки згорнутої групи');
  w.switchTab(b.id);
  ok(w.group(g1).collapsed === false && w.activeId === b.id, 'groups: перехід на вкладку згорнутої групи розгортає її');
  ok(w.setGroupCollapsed(g1, true) && w.activeId !== b.id && !w.tabs.find(t => t.id === w.activeId).group, 'groups: згортання групи з активною вкладкою переходить на сусідню поза групою');
  w.setGroupCollapsed(g1, false);

  // --- нова вкладка з посилання успадковує групу ---
  const child = w.createTab('w3ir://newtab', { activate: false, opener: c });
  ok(child.group === g1 && w.tabs.indexOf(child) === w.tabs.indexOf(c) + 1 && contiguous(), 'groups: вкладка, відкрита з вкладки групи, потрапляє в ту саму групу одразу після неї');
  w.duplicateTab(c.id);
  const dup = w.tabs[w.tabs.indexOf(c) + 1];
  ok(dup && dup.group === g1 && contiguous(), 'groups: дублікат вкладки лишається в групі');
  w.exec('groupNewTab', g1); await sleep(300);
  ok(w.groupTabs(g1).length >= 5 && w.tabs.find(t => t.id === w.activeId).group === g1, 'groups: «Нова вкладка в групі» додає й активує вкладку в групі');

  // --- меню та палітра ---
  const labels = (t) => w.tabGroupMenuItems(t).map(i => i.label);
  ok(labels(e).includes('Додати до нової групи') && labels(e).includes('Додати до групи') && !labels(e).includes('Видалити з групи'), 'groups: меню вкладки без групи: нова група / додати до групи');
  ok(labels(c).includes('Видалити з групи') && w.tabGroupMenuItems(b.pinned ? b : { pinned: true }).length === 0, 'groups: меню вкладки в групі має «Видалити з групи»; для закріпленої групових пунктів немає');
  const cmds = w.commandList();
  ok(cmds.some(x => x.cmd === 'groupNew') && cmds.some(x => x.cmd === 'groupFocus' && /Робота/.test(x.label)), 'groups: палітра має «Нова група…» і «Перейти до групи «Робота»»');
  ok(w.paletteData('tabs').tabs.some(x => x.title.startsWith('[Робота] ')), 'groups: у пошуку вкладок назва групи вказана в дужках');
  const { withTip } = require('../src/tips');
  ok(cmds.filter(x => /^group/.test(x.cmd)).every(x => withTip(x).tip), 'groups: команди груп мають підказки');

  // --- інтерфейс рядка вкладок ---
  w.setGroupName(g2, 'Особисте');
  w.setGroupCollapsed(g2, true);
  w.sendState(); await sleep(500);
  const ui = await w.chrome.executeJavaScript(`(() => ({
    chips: [...document.querySelectorAll('.gchip')].map(c => ({ name: c.querySelector('.gname') && c.querySelector('.gname').textContent, count: c.querySelector('.gcount') && c.querySelector('.gcount').textContent, color: c.style.getPropertyValue('--gc'), collapsed: c.classList.contains('collapsed') })),
    tabs: document.querySelectorAll('#tabs .tab').length,
    ingroup: document.querySelectorAll('#tabs .tab.ingroup').length,
  }))()`);
  ok(ui.chips.length === 2 && ui.chips.some(x => x.name === 'Робота' && x.color === '#e5675f' && !x.collapsed) && ui.chips.some(x => x.name === 'Особисте' && x.collapsed && x.count === '1'), 'groups: у рядку вкладок видно кольорові мітки груп (назва, колір, лічильник у згорнутої)');
  ok(ui.tabs === w.visibleTabs().length && ui.ingroup === w.tabs.filter(t => t.group === g1).length, 'groups: вкладки згорнутої групи не малюються, а вкладки відкритої підсвічені кольором');
  await w.chrome.executeJavaScript(`document.querySelector('.gchip.collapsed').click()`);
  await sleep(600);
  ok(w.group(g2).collapsed === false, 'groups: клік по мітці розгортає групу');
  w.chrome.send('group-edit', { id: g1 }); await sleep(400);
  const hasInput = await w.chrome.executeJavaScript(`!!document.querySelector('.gedit')`);
  await w.chrome.executeJavaScript(`(() => { const i = document.querySelector('.gedit'); i.value = 'Проєкт'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await sleep(500);
  ok(hasInput && w.group(g1).name === 'Проєкт', 'groups: подвійний клік/перейменування редагує назву прямо на мітці');

  // --- збереження сесії ---
  w.setGroupCollapsed(g2, true);
  const snap = w.snapshot();
  ok(snap.groups.length === 2 && snap.groupOf.length === snap.urls.length && snap.groups.some(x => x.name === 'Проєкт' && x.color === 'red') && snap.groups.some(x => x.name === 'Особисте' && x.collapsed), 'groups: групи входять до знімка сесії');
  const w2 = ctx.openWindow({ urls: snap.urls, groups: snap.groups, groupOf: snap.groupOf, pinned: snap.pinned, activeIndex: snap.activeIndex });
  await sleep(3000);
  const sig = (x) => x.groupList().map(g => `${g.name}|${g.color}|${g.collapsed}|${g.count}`).join(';');
  ok(w2.tabs.length === snap.urls.length && sig(w2) === sig(w) && w2.tabs.map(t => !!t.group).join() === w.tabs.filter(t => { const u = w.tabUrl(t); return u && u !== 'about:blank'; }).map(t => !!t.group).join(), 'groups: після перезапуску групи, кольори, назви й стан згортання відновлюються');
  const bad = ctx.openWindow({ urls: ['w3ir://newtab', 'w3ir://newtab'], groups: [{ name: 'x'.repeat(200), color: 'javascript:1' }], groupOf: [0, 7] });
  await sleep(2500);
  ok(bad.groupList().length === 1 && bad.groupList()[0].name.length <= 40 && GROUP_COLORS.some(x => x.key === bad.groupList()[0].color) && bad.tabs[1].group === null, 'groups: пошкоджені дані сесії (колір, довга назва, неіснуюча група) безпечно обробляються');

  // --- розгрупування й закриття ---
  w.setGroupCollapsed(g2, false);
  w.ungroup(g2);
  ok(!w.group(g2) && a.group === null, 'groups: «Розгрупувати» зберігає вкладки');
  const n = w.tabs.length, members = w.groupTabs(g1).length;
  w.closeGroup(g1); await sleep(300);
  ok(!w.group(g1) && w.tabs.length === n - members, 'groups: «Закрити групу» закриває всі її вкладки');
  w.closeTab(w.groupTabs(-1)[0] ? 0 : w.tabs[w.tabs.length - 1].id);
  const g3 = w.newGroup([w.tabs[0].id, w.tabs[1].id]);
  const solo = w.tabs.filter(t => t.group === g3);
  solo.slice(0, -1).forEach(t => w.closeTab(t.id));
  const last = w.tabs.find(t => t.group === g3);
  ok(w.groupList().find(g => g.id === g3).count === 1, 'groups: лічильник групи відповідає кількості вкладок');
  const other = w.tabs.find(t => !t.group);
  if (other) { w.closeTab(last.id); ok(!w.group(g3), 'groups: порожня група зникає після закриття останньої вкладки'); } else ok(true, 'groups: порожня група (пропущено)');

  w.win.close(); w2.win.close(); bad.win.close();
  await sleep(500);
}

async function siteTests(ctx) {
  const { ASK } = require('../src/context');
  const ses = ctx.session;
  const origin = 'https://example.org';

  // --- дозволи ---
  ok(ctx.setSitePerm(ses, origin, 'media', false) && ctx.permDecision(ses, origin, 'media') === false && ctx.sitePerms(ses, origin).media === false && ctx.sitePerms(ses, origin).geolocation === null, 'sites: заборона дозволу зберігається, решта лишається «запитувати»');
  ok(ctx.setSitePerm(ses, origin, 'media', true) && ctx.permDecision(ses, origin, 'media') === true, 'sites: дозвіл можна змінити');
  ok(ctx.setSitePerm(ses, origin, 'media', null) && ctx.permDecision(ses, origin, 'media') === null, 'sites: «Запитувати» прибирає збережене рішення');
  ok(!ctx.setSitePerm(ses, origin, 'camera-evil', true) && !ctx.setSitePerm(ses, 'null', 'media', true) && !ctx.setSitePerm(ses, 'javascript:alert(1)', 'media', true) && !ctx.setSitePerm(ses, '', 'media', true), 'sites: невідомі дозволи та некоректні адреси відхиляються');
  const inc = ctx.openWindow({ incognito: true });
  await sleep(2200);
  ctx.setSitePerm(inc.ses, origin, 'geolocation', true);
  ok(ctx.permDecision(inc.ses, origin, 'geolocation') === true && ctx.permDecision(ses, origin, 'geolocation') === null && !('https://example.org|geolocation' in ctx.permsStore.data), 'sites: у приватному вікні дозволи лишаються лише в пам’яті сеансу й не потрапляють у профіль');
  inc.win.close();

  // --- виняток блокувальника ---
  ctx.setAdblockAllowed('www.example.org', true);
  ok(ctx.adblockAllowed('sub.example.org') && ctx.adblockAllowed('example.org') && !ctx.adblockAllowed('example.com') && !ctx.adblockAllowed(''), 'sites: виняток діє для всього сайту (зареєстрований домен), але не для інших');
  ctx.setAdblockAllowed('example.org', false);
  ok(!ctx.adblockAllowed('example.org'), 'sites: виняток можна прибрати');

  // --- панель сайту на справжній сторінці ---
  const http = require('http');
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url);
    res.setHeader('content-type', 'text/html');
    res.end('<title>site</title><img src="https://ad.doubleclick.net/pixel.gif"><p>hello</p>');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const w = [...ctx.windows][0];
  w.exec('newTab'); w.exec('go', base + '/'); await sleep(3500);
  const tab = w.active();
  ctx.setAdblockAllowed('127.0.0.1', false);
  ok(ctx.topHost(tab.view.webContents.id) === '127.0.0.1', 'sites: головний хост вкладки визначається за id вмісту');
  w.exec('reload'); await sleep(3000);
  const blockedOn = tab.blocked;
  ctx.setAdblockAllowed('127.0.0.1', true);
  w.exec('reload'); await sleep(3000);
  const blockedOff = tab.blocked;
  ctx.setAdblockAllowed('127.0.0.1', false);
  ok(blockedOn >= 1 && blockedOff === 0, `sites: на сайті з винятком рекламний запит не блокується (було ${blockedOn}, з винятком ${blockedOff})`);

  // cookie: очищення лише для цього сайту
  await ses.cookies.set({ url: base + '/', name: 'sid', value: '1' });
  await ses.cookies.set({ url: 'https://other-site.example/', name: 'keep', value: '1' });
  let data = await w.sitePanelData();
  ok(data.kind === 'http' && data.host === '127.0.0.1' && Object.keys(data.perms).join() === Object.keys(ASK).join() && data.cookies >= 1 && data.adblock.enabled, 'sites: дані панелі: тип з’єднання, хост, дозволи та кількість cookie');
  const removed = await ctx.clearSiteData(ses, '127.0.0.1');
  const left = await ses.cookies.get({ url: 'https://other-site.example/' });
  ok(removed >= 1 && (await ctx.siteCookies(ses, '127.0.0.1')).length === 0 && left.length === 1, 'sites: очищення видаляє cookie лише цього сайту');
  await ses.cookies.remove('https://other-site.example/', 'keep');

  // --- інтерфейс: замок → панель ---
  await sleep(300);
  const secText = await w.chrome.executeJavaScript(`document.getElementById('sec').textContent`);
  ok(/Не захищено/.test(secText), 'sites: для http-сторінки в адресному рядку показано «Не захищено»');
  await w.chrome.executeJavaScript(`document.getElementById('sec').click()`);
  await sleep(900);
  ok(w.overlayType === 'site', 'sites: клік на значок відкриває панель сайту');
  const dom = await w.overlay.webContents.executeJavaScript(`(() => ({
    title: document.querySelector('.vh').textContent,
    selects: document.querySelectorAll('.site select').length,
    conn: document.querySelector('.sconn').textContent,
    hasAdblock: !!document.querySelector('.site input[type=checkbox]'),
  }))()`);
  ok(dom.title === '127.0.0.1' && dom.selects === Object.keys(ASK).length && /не захищене/.test(dom.conn) && dom.hasAdblock, 'sites: панель показує хост, попередження про http, дозволи й перемикач блокувальника');
  await w.overlay.webContents.executeJavaScript(`(() => { const s = document.querySelector('.site select'); s.value = 'false'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(500);
  ok(ctx.permDecision(ses, base, 'media') === false, 'sites: вибір «Заблокувати» в панелі зберігає рішення для цього сайту');
  ctx.setSitePerm(ses, base, 'media', null);
  await w.overlay.webContents.executeJavaScript(`(() => { const c = document.querySelector('.site input[type=checkbox]'); c.checked = false; c.dispatchEvent(new Event('change')); })()`);
  await sleep(1500);
  ok(ctx.adblockAllowed('127.0.0.1'), 'sites: вимкнення перемикача блокувальника додає сайт у винятки');
  ctx.setAdblockAllowed('127.0.0.1', false);
  await ses.cookies.set({ url: base + '/', name: 'sid2', value: '1' });
  await w.refreshSiteOverlay(); await sleep(400);
  await w.overlay.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('.site .vbtn')].find(x => /Очистити/.test(x.textContent)); b.click(); b.click(); })()`);
  await sleep(900);
  ok((await ctx.siteCookies(ses, '127.0.0.1')).length === 0, 'sites: кнопка очищення (з підтвердженням другим кліком) видаляє дані сайту');
  w.closeOverlay();

  // внутрішня сторінка
  w.exec('openPage', 'settings'); await sleep(1200);
  const internal = await w.sitePanelData();
  ok(internal.kind === 'internal' && internal.perms === null, 'sites: для внутрішніх сторінок налаштувань сайту немає');

  // --- налаштування: список і скидання ---
  ctx.setSitePerm(ses, 'https://list.example', 'notifications', false);
  ctx.setAdblockAllowed('list.example', true);
  const list = await w.wc().executeJavaScript(`w3ir.invoke('sites:list')`);
  ok(list.perms.some(p => p.origin === 'https://list.example' && p.perm === 'notifications' && p.value === false) && list.adblockAllow.includes('list.example'), 'sites: налаштування показують збережені дозволи й винятки');
  await w.wc().executeJavaScript(`w3ir.invoke('sites:resetPerm', { origin: 'https://list.example', perm: 'notifications' })`);
  await w.wc().executeJavaScript(`w3ir.invoke('sites:adblockRemove', { domain: 'list.example' })`);
  ok(ctx.permDecision(ses, 'https://list.example', 'notifications') === null && !ctx.adblockAllowed('list.example'), 'sites: скидання з налаштувань працює');
  w.exec('openPage', 'history'); await sleep(1200);
  ok(await w.wc().executeJavaScript(`w3ir.invoke('sites:list').then(() => 'allowed', () => 'denied')`) === 'denied', 'sites: інші внутрішні сторінки не мають доступу до керування сайтами');
  srv.close();
}

module.exports = async function run(ctx) {
  try {
    await sleep(2000);
    await vaultTests().catch(e => { failed++; console.log('[sec] ERROR vault1', e.stack); });
    await vaultTests2();
    await syncTests();
    await e2eTests(ctx);
    await torrentTests(ctx);
    await importTests(ctx);
    await profileTests(ctx);
    await githubTests(ctx);
    await walletTests(ctx);
    await helpTests(ctx);
    await updateTests(ctx);
    await threatTests(ctx);
    await groupTests(ctx);
    await siteTests(ctx);
  } catch (e) {
    failed++;
    console.log('[sec] ERROR', e.stack || e);
  }
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  console.log(`[sec] RESULT: ${pass} passed, ${failed} failed`);
  app.quit();
};
