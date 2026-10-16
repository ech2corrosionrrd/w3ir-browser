'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { app } = require('electron');
const { Vault } = require('../../src/vault');
const { Sync, FILE_NAME } = require('../../src/sync');
const { ok, sleep, tmp } = require('../lib');

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
  ok(!btxt.includes('a.example.com') && !/"password"|"username"|"url"/.test(btxt), 'vault: резервна копія зашифрована (немає імен полів і адрес відкритим текстом)');
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
  const imp = require('../../src/importer');
  const { Store } = require('../../src/store');
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

module.exports = { vaultTests, vaultTests2, syncTests, e2eTests, torrentTests, importTests, profileTests };
