'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Places, BookmarkStore, ftsQuery } = require('../../src/places');
const { ok, sleep, tmp } = require('../lib');

const DAY = 86400000;
const DB = (p) => path.join(p.dir, 'places.sqlite');

async function placesTests(ctx) {
  const now = Date.now();

  // ---------- базова робота ----------
  const p = new Places(tmp('places'));
  ok(fs.existsSync(DB(p)) && p.db.prepare('PRAGMA journal_mode').get().journal_mode === 'wal', 'places: база SQLite створена, журнал WAL');
  ok(p.db.prepare("SELECT name FROM sqlite_master WHERE name = 'places_fts'").get(), 'places: повнотекстовий індекс FTS5 створено');
  ok(p.addVisit('ftp://x.example/', 'x') === null && p.addVisit('javascript:alert(1)', 'x') === null && p.placeCount() === 0, 'places: не-http(s) адреси не записуються');
  p.addVisit('https://a.example/', 'A', now - 60000);
  p.addVisit('https://a.example/', 'A (нова назва)', now - 58000);
  ok(p.visitCount() === 1 && p.visits({})[0].title === 'A (нова назва)', 'places: повторне завантаження протягом 5 с — той самий візит, назва оновлюється');
  p.addVisit('https://a.example/', 'A', now - 30000);
  ok(p.visitCount() === 2 && p.placeCount() === 1, 'places: через 5 с — новий візит тієї ж адреси');
  p.setTitle('https://a.example/', 'Остаточна назва');
  ok(p.visits({})[0].title === 'Остаточна назва', 'places: назва, що приходить після навігації, зберігається');
  p.setTitle('https://a.example/', '');
  ok(p.visits({})[0].title === 'Остаточна назва', 'places: порожня назва не затирає наявну');

  const long3k = 'https://long.example/?q=' + 'x'.repeat(3000);
  ok(p.addVisit(long3k, 'Довга', now - 20000) !== null && p.visits({ query: 'long.example' })[0].url === long3k, 'places: довга адреса (3 тис. символів) зберігається повністю, без обрізання');
  ok(p.addVisit('https://long.example/?q=' + 'x'.repeat(9000), 'Надто довга', now) === null && p.visits({ query: 'long.example' }).length === 1, 'places: надто довга адреса не записується (обрізана вела б на іншу сторінку)');
  p.removeUrl(long3k);

  // ---------- повнотекстовий пошук ----------
  p.addVisit('https://shop.example/phones/iphone', 'Купити iPhone дешево', now - 5 * DAY);
  p.addVisit('https://news.example/iphone', 'Новини про телефони', now - 3600000);
  p.addVisit('https://café.example/menu', 'Café Zürich — меню', now - DAY);
  const urls = (q) => p.search(q).map(r => r.url);
  ok(urls('купи').length === 1 && urls('КУПИ')[0].includes('shop.example'), 'places: FTS — префікс слова кирилицею, без урахування регістру');
  ok(urls('iphone купити').length === 1 && urls('iphone').length === 2, 'places: FTS — кілька слів у будь-якому порядку');
  ok(urls('cafe')[0] === 'https://café.example/menu' && urls('zurich').length === 1, 'places: FTS — діакритика не заважає (cafe → Café, zurich → Zürich)');
  ok(urls('hones').length === 1 && urls('xample.com').length === 0, 'places: підрядок усередині слова знаходиться запасним пошуком');
  let threw = false;
  try { for (const q of ['"', '*', 'a"b', 'NEAR(', '-x', 'a OR', "'; DROP TABLE places;--", '()', '\\']) p.search(q); } catch { threw = true; }
  ok(!threw && p.placeCount() === 4, 'places: спеціальні символи запиту не ламають MATCH і не виконуються як SQL');
  ok(ftsQuery('  ') === null && ftsQuery('a-b c*') === '"a"* "b"* "c"*', 'places: запит FTS будується лише з літер і цифр');
  ok(p.search('iphone', { limit: 1 }).length === 1 && p.search('iphone', { exclude: new Set(['https://news.example/iphone']) }).length === 1, 'places: ліміт і виключення в підказках');
  ok(p.visits({ query: 'iphone купити' }).length === 1 && p.visits({ query: 'жодного такого' }).length === 0, 'places: пошук на сторінці історії за кількома словами');

  // ---------- frecency ----------
  const q = new Places(tmp('places-frec'));
  ok(Math.abs(q.weight(now) - 2 * q.weight(now - 14 * DAY)) < 1e-9 * q.weight(now), 'places: вага візиту вдвічі спадає за 14 діб (експоненційний спад)');
  q.addVisit('https://rare-old.example/', 'Давній', now - 90 * DAY);
  for (let i = 0; i < 10; i++) q.addVisit('https://often-old.example/', 'Колись часто', now - 60 * DAY - i * DAY);
  q.addVisit('https://once-today.example/', 'Сьогодні раз', now - 1000);
  for (let i = 0; i < 5; i++) q.addVisit('https://often-new.example/', 'Часто нещодавно', now - i * 2 * DAY);
  const rank = (qq) => q.search(qq, { limit: 10 }).map(r => r.url.split('//')[1].split('.')[0]);
  const all = q.db.prepare('SELECT url FROM places ORDER BY frecency DESC').all().map(r => r.url.split('//')[1].split('.')[0]);
  ok(all[0] === 'often-new' && all[1] === 'once-today' && all.indexOf('often-old') > all.indexOf('once-today'), 'places: frecency — часті й свіжі вище за давні; один свіжий візит вище за багато візитів 2 місяці тому');
  ok(rank('example').join() === all.join(), 'places: підказки впорядковані за frecency');
  const top = q.topOrigins((u) => new URL(u).origin, 3);
  ok(top[0].url.includes('often-new') && top.length === 3, 'places: найвідвідуваніші сайти — за сумою frecency');

  // ---------- видалення ----------
  const before = p.search('iphone').length;
  const v = p.visits({ query: 'news.example' })[0];
  ok(p.removeVisit(v.id) && p.search('iphone').length === before - 1 && !p.visits({}).some(x => x.id === v.id), 'places: видалення єдиного візиту прибирає адресу з історії й підказок (FTS синхронізовано)');
  const a1 = p.db.prepare("SELECT frecency, visit_count FROM places WHERE url = 'https://a.example/'").get();
  const aVisit = p.visits({ query: 'a.example' })[0];
  p.removeVisit(aVisit.id);
  const a2 = p.db.prepare("SELECT frecency, visit_count FROM places WHERE url = 'https://a.example/'").get();
  ok(a2 && a2.visit_count === a1.visit_count - 1 && a2.frecency < a1.frecency, 'places: видалення одного з кількох візитів зменшує лічильник і frecency');
  ok(!p.removeVisit('x') && !p.removeVisit(999999) && !p.removeVisit(null), 'places: некоректний id візиту ігнорується');
  ok(p.removeUrl('https://café.example/menu') && p.search('cafe').length === 0 && !p.removeUrl('https://nope.example/'), 'places: «забути сайт» видаляє всі візити адреси');

  // ---------- обмеження обсягу ----------
  const r = new Places(tmp('places-prune'), { maxVisits: 50 });
  for (let i = 0; i < 80; i++) r.addVisit(`https://site${i}.example/`, `Сайт ${i}`, now - (80 - i) * 60000);
  r.prune();
  ok(r.visitCount() <= 50 && r.placeCount() === r.visitCount(), 'places: ліміт візитів — старі видаляються разом з адресами без візитів');
  ok(r.search('site79').length === 1 && r.search('site0').length === 0, 'places: нові записи лишились, найстаріші зникли');
  const orphan = r.db.prepare('SELECT count(*) AS n FROM visits v LEFT JOIN places p ON p.id = v.place_id WHERE p.id IS NULL').get().n;
  ok(orphan === 0, 'places: візитів-сиріт немає');

  // ---------- імпорт ----------
  const imp = new Places(tmp('places-imp'));
  const items = [{ url: 'https://i.example/a', title: 'Імп A', time: now - DAY, n: 7 }, { url: 'https://i.example/b', title: 'Імп B', time: now - 2 * DAY }, { url: 'ftp://bad/', title: 'x', time: now }, { url: 'https://i.example/c', title: 'без часу', time: 0 }];
  ok(imp.importVisits(items) === 2 && imp.importVisits(items) === 0 && imp.visitCount() === 2, 'places: імпорт історії без дублікатів, зіпсовані рядки пропущено');
  ok(imp.db.prepare("SELECT visit_count AS n FROM places WHERE url = 'https://i.example/a'").get().n === 7 && imp.search('імп').length === 2, 'places: лічильник візитів з іншого браузера враховано, імпортоване шукається');

  // ---------- кеш списку для захисту від шахрайства ----------
  const l1 = imp.list();
  ok(imp.list() === l1 && Array.isArray(l1) && l1.length === 2 && l1.stamp !== undefined, 'places: список адрес кешується');
  imp.addVisit('https://i.example/new', 'Нова', now);
  ok(imp.list() !== l1 && imp.list().stamp !== l1.stamp && imp.list().length === 3, 'places: кеш скидається при появі нової адреси');

  // ---------- закладки ----------
  const bmDir = tmp('places-bm');
  const pb = new Places(bmDir);
  const bs = new BookmarkStore(pb);
  ok(bs.data.length === 0, 'places: закладок спершу немає');
  bs.data.push({ url: 'https://b.example/', title: 'Закладка', added: 5, mod: 6 }, { url: 'https://c.example/', title: 'C', added: 7, mod: 8 });
  bs.save();
  bs.data.push({ url: 'https://d.example/', title: 'D', added: 9, mod: 10 });
  bs.flush();
  pb.close();
  const pb2 = new Places(bmDir);
  const bs2 = new BookmarkStore(pb2);
  ok(JSON.stringify(bs2.data) === JSON.stringify(bs.data), 'places: закладки (порядок, дати) переживають перезапуск');
  bs2.data = bs2.data.filter(b => b.url !== 'https://c.example/');
  bs2.flush();
  ok(new BookmarkStore(pb2).data.length === 2, 'places: видалення закладки зберігається');
  pb2.close();

  // ---------- міграція з JSON ----------
  const mdir = tmp('places-mig');
  fs.writeFileSync(path.join(mdir, 'history.json'), JSON.stringify([
    { id: 'u1', url: 'https://old.example/a', title: 'Стара A', time: now - 10 * DAY },
    { id: 'u2', url: 'https://old.example/a', title: 'Стара A (нова назва)', time: now - DAY },
    { id: 'u3', url: 'https://old.example/b', title: 'Стара B', time: now - 2 * DAY, n: 4 },
    { id: 'u4', url: 'about:blank', title: 'службова', time: now },
    { bad: true }]));
  fs.writeFileSync(path.join(mdir, 'bookmarks.json'), JSON.stringify([{ url: 'https://mark.example/', title: 'Закладка зі старої версії', added: 11, mod: 12 }, null, { title: 'без адреси' }]));
  const pm = new Places(mdir);
  ok(pm.visitCount() === 3 && pm.placeCount() === 2 && pm.visits({ query: 'нова назва' }).length === 2, 'migrate: історію з history.json перенесено (візити, остання назва, службові/зіпсовані рядки пропущено)');
  ok(pm.db.prepare("SELECT visit_count AS n FROM places WHERE url = 'https://old.example/b'").get().n === 4, 'migrate: лічильник візитів збережено');
  ok(JSON.stringify(pm.loadBookmarks()) === JSON.stringify([{ url: 'https://mark.example/', title: 'Закладка зі старої версії', added: 11, mod: 12 }]), 'migrate: закладки перенесено без дат-втрат');
  ok(fs.existsSync(path.join(mdir, 'history.json.migrated')) && fs.existsSync(path.join(mdir, 'bookmarks.json.migrated')) && !fs.existsSync(path.join(mdir, 'history.json')), 'migrate: старі файли збережено як *.migrated (не видалено)');
  pm.clear();
  pm.close();
  fs.writeFileSync(path.join(mdir, 'history.json'), JSON.stringify([{ id: 'z', url: 'https://again.example/', title: 'ще раз', time: now }]));
  const pm2 = new Places(mdir);
  ok(pm2.placeCount() === 0, 'migrate: міграція виконується один раз (повторно JSON не підтягується)');
  pm2.close();
  const bad = tmp('places-mig-bad');
  fs.writeFileSync(path.join(bad, 'history.json'), '{{ не json');
  let migThrew = false; let pbad; try { pbad = new Places(bad); } catch { migThrew = true; }
  ok(!migThrew && pbad.placeCount() === 0, 'migrate: пошкоджений history.json не ламає запуск');
  pbad.close();

  // ---------- пошкоджена база ----------
  const cdir = tmp('places-corrupt');
  fs.writeFileSync(path.join(cdir, 'places.sqlite'), Buffer.from('це точно не база даних SQLite, лише сміття '.repeat(50)));
  const pc = new Places(cdir);
  ok(pc.recovered === 'defaults' && fs.readdirSync(cdir).some(f => f.startsWith('places.sqlite.corrupt-')) && pc.addVisit('https://after.example/', 'після', now) !== null, 'places: пошкоджена база відкладається вбік, браузер стартує з чистою');
  pc.close();

  // ---------- збереження між запусками ----------
  const keep = tmp('places-keep');
  const k1 = new Places(keep);
  k1.addVisit('https://keep.example/', 'Лишається', now);
  k1.close();
  const k2 = new Places(keep);
  ok(k2.search('лишається').length === 1 && k2.visitCount() === 1, 'places: дані переживають перезапуск (WAL)');
  k2.close();

  // ---------- швидкодія на обсязі за замовчуванням ----------
  const big = new Places(tmp('places-big'));
  big.tx(() => { for (let i = 0; i < 19000; i++) big.st.insVisit.run(Number(big.st.insPlace.run(`https://host${i % 3000}.example/p/${i}`, `Сторінка ${i} про ${['котів', 'собак', 'авто', 'ціни'][i % 4]}`, 1, now - i * 1000, big.weight(now - i * 1000)).lastInsertRowid), now - i * 1000); });
  const t0 = Date.now();
  for (let i = 0; i < 300; i++) big.addVisit(`https://fresh${i}.example/`, `Свіжа ${i}`, now + i * 10000);
  const perAdd = (Date.now() - t0) / 300;
  const t1 = Date.now();
  const found = big.search('сторінка ціни', { limit: 7 });
  const searchMs = Date.now() - t1;
  const t2 = Date.now();
  const sub = big.search('торін', { limit: 7 });
  const subMs = Date.now() - t2;
  ok(perAdd < 8, `places: запис візиту на 19 тис. записів швидкий (${perAdd.toFixed(2)} мс)`);
  ok(found.length === 7 && searchMs < 300 && sub.length === 7 && subMs < 400, `places: пошук підказок на 19 тис. записів (FTS ${searchMs} мс, підрядок ${subMs} мс)`);
  ok(big.visits({ query: 'ціни', limit: 500 }).length === 500, 'places: сторінка історії віддає до 500 записів');
  big.close();

  // ---------- інтеграція з контекстом браузера ----------
  const realP = ctx.places, realB = ctx.bookmarksStore;
  const tp = new Places(tmp('places-ctx'));
  ctx.places = tp;
  ctx.bookmarksStore = new BookmarkStore(tp);
  ctx.historyAdd('https://ctx.example/page', 'Контекстна сторінка');
  ctx.historyAdd('https://ctx.example/page', 'Контекстна сторінка');
  ctx.historyAdd('file:///c:/x.html', 'файл');
  ctx.historyTitle('https://ctx.example/page', 'Оновлена назва');
  ok(tp.visitCount() === 1 && tp.visits({})[0].title === 'Оновлена назва', 'places/ctx: historyAdd/historyTitle пишуть у SQLite, файли й дублікати відсіюються');
  ctx.bookmarkSet('https://ctx.example/bm', 'Закладка контексту');
  const sg = ctx.suggest('ctx.example');
  ok(sg.length === 3 && sg[1].type === 'bookmark' && sg[2].type === 'history', 'places/ctx: підказки — спочатку закладки, потім історія за frecency');
  ctx.bookmarksStore.flush();
  ok(tp.loadBookmarks().length === 1, 'places/ctx: закладка потрапила в SQLite');

  // сторінка «Історія» через IPC
  const w = [...ctx.windows][0];
  w.exec('newTab'); w.exec('go', 'w3ir://history'); await sleep(1500);
  const wc = w.wc();
  const items2 = await wc.executeJavaScript(`w3ir.invoke('history:get', { query: 'контекстна' })`);
  ok(Array.isArray(items2) && items2.length === 0, 'places/ipc: history:get повертає масив; стара назва вже не шукається (оновлено)');
  const hit = await wc.executeJavaScript(`w3ir.invoke('history:get', { query: 'оновлена' })`);
  ok(hit.length === 1 && Number.isInteger(hit[0].id) && hit[0].url === 'https://ctx.example/page' && typeof hit[0].time === 'number', 'places/ipc: history:get — запис із id, адресою, назвою й часом');
  await wc.executeJavaScript(`w3ir.invoke('history:remove', { id: ${hit[0].id} })`);
  ok(tp.visitCount() === 0, 'places/ipc: history:remove видаляє візит');
  ctx.historyAdd('https://ctx2.example/', 'Ще');
  await wc.executeJavaScript(`w3ir.invoke('history:clear')`);
  ok(tp.visitCount() === 0 && tp.placeCount() === 0, 'places/ipc: history:clear очищає історію');
  ok(await wc.executeJavaScript(`w3ir.invoke('history:remove', { id: 'DROP TABLE' }).then(() => 'ok', () => 'err')`) === 'ok' && tp.db.prepare("SELECT name FROM sqlite_master WHERE name = 'visits'").get(), 'places/ipc: некоректний id не шкодить');

  // справжня навігація записується в історію
  const site = http.createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<html><head><title>Тестова історія</title></head><body>hi</body></html>'); });
  await new Promise(r => site.listen(0, '127.0.0.1', r));
  w.exec('newTab'); w.exec('go', `http://127.0.0.1:${site.address().port}/navigated`); await sleep(2000);
  const nav = tp.visits({ query: 'navigated' });
  ok(nav.length === 1 && nav[0].title === 'Тестова історія', 'places/ctx: справжня навігація записується з назвою сторінки');
  site.close();
  ctx.places = realP; ctx.bookmarksStore = realB;
  tp.close();
  for (const x of [p, q, r, imp]) x.close();
}

module.exports = { placesTests };
