'use strict';
// Історія й закладки у вбудованому SQLite (node:sqlite, без зовнішніх залежностей) за зразком Firefox Places.
//  * places — унікальні адреси (назва, лічильник візитів, час останнього візиту, frecency);
//  * visits — окремі візити (для сторінки «Історія»);
//  * places_fts — повнотекстовий індекс FTS5 (назва + адреса) для підказок адресного рядка;
//  * bookmarks — закладки (синхронізація й інтерфейс працюють із масивом, див. BookmarkStore).
// Запис не переписує весь файл на кожен перехід, як JSON: лише змінені рядки; WAL захищає від втрати даних при збої.
//
// Frecency = Σ 2^((tᵢ − T0)/H) за візитами tᵢ (H = 14 діб): кожен візит додає вагу, що вдвічі спадає за період H.
// Це «частота × свіжість» за експоненційним спадом; оскільки з часом усі оцінки зменшуються в однакову кількість
// разів, порядок сайтів не змінюється і перерахунок не потрібен (T0 зсувається, коли показник степеня стає завеликим).
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const FILE = 'places.sqlite';
const SCHEMA_VERSION = 1;
const MAX_VISITS = 20000;
const DEDUPE_MS = 5000;
const HALF_LIFE_MS = 14 * 86400000;
const T0_DEFAULT = Date.UTC(2026, 0, 1);
const RESCALE_EXPONENT = 400;
const TITLE_MAX = 300;
const URL_MAX = 8192; // довші адреси не записуємо (обрізана адреса вела б на іншу сторінку)

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS places (
  id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL DEFAULT '',
  visit_count INTEGER NOT NULL DEFAULT 0, last_visit INTEGER NOT NULL DEFAULT 0, frecency REAL NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS places_frecency ON places(frecency DESC);
CREATE INDEX IF NOT EXISTS places_last_visit ON places(last_visit DESC);
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY, place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE, time INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS visits_time ON visits(time);
CREATE INDEX IF NOT EXISTS visits_place ON visits(place_id, time);
CREATE VIRTUAL TABLE IF NOT EXISTS places_fts USING fts5(title, url, content='places', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS places_ai AFTER INSERT ON places BEGIN
  INSERT INTO places_fts(rowid, title, url) VALUES (new.id, new.title, new.url);
END;
CREATE TRIGGER IF NOT EXISTS places_ad AFTER DELETE ON places BEGIN
  INSERT INTO places_fts(places_fts, rowid, title, url) VALUES ('delete', old.id, old.title, old.url);
END;
CREATE TRIGGER IF NOT EXISTS places_au AFTER UPDATE OF title, url ON places BEGIN
  INSERT INTO places_fts(places_fts, rowid, title, url) VALUES ('delete', old.id, old.title, old.url);
  INSERT INTO places_fts(rowid, title, url) VALUES (new.id, new.title, new.url);
END;
CREATE TABLE IF NOT EXISTS bookmarks (url TEXT PRIMARY KEY, title TEXT NOT NULL, added INTEGER NOT NULL, mod INTEGER NOT NULL);
`;

const places = new Set();

const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

// Порівняння без урахування регістру й діакритики (Café = cafe), як і в FTS5 (remove_diacritics)
const fold = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
function matcher(q) {
  const words = fold(q).split(/\s+/).filter(Boolean).slice(0, 8);
  return (title, url) => {
    if (!words.length) return true;
    const hay = fold(title) + ' ' + fold(url);
    return words.every(w => hay.includes(w));
  };
}

// Запит для FTS5: лише літери/цифри, кожне слово — префікс (безпечно для синтаксису MATCH)
function ftsQuery(q) {
  const terms = (String(q == null ? '' : q).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).slice(0, 8);
  return terms.length ? terms.map(t => `"${t}"*`).join(' ') : null;
}

class Places {
  constructor(dir, { file = FILE, maxVisits = MAX_VISITS } = {}) {
    this.dir = dir;
    this.file = path.join(dir, file);
    this.maxVisits = maxVisits;
    this.recovered = '';
    this._open();
    this._listCache = null;
    this._version = 0;
    this._prepare();
    this._migrateJson();
    this._rescaleIfNeeded();
    this.prune();
    places.add(this);
  }

  // ---------- відкриття ----------
  _open() {
    const tryOpen = () => {
      const db = new DatabaseSync(this.file);
      try {
        db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
        db.exec(SCHEMA);
        const ver = Number((db.prepare("SELECT value FROM meta WHERE key='schema'").get() || {}).value || 0);
        if (ver > SCHEMA_VERSION) throw new Error('places.sqlite was created by a newer version of the browser');
        if (ver < SCHEMA_VERSION) db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
        db.prepare('SELECT count(*) FROM places').get(); // перевірка читання
        return db;
      } catch (e) { try { db.close(); } catch { /* ignore */ } throw e; }
    };
    fs.mkdirSync(this.dir, { recursive: true });
    try { this.db = tryOpen(); }
    catch (e) {
      // пошкоджену базу не затираємо: зберігаємо поруч і починаємо з чистої (історію можна відновити з JSON-копії)
      console.error('Places: database is damaged, creating a new one:', e.message);
      for (const ext of ['', '-wal', '-shm']) { try { fs.renameSync(this.file + ext, `${this.file}${ext}.corrupt-${Date.now()}`); } catch { /* ignore */ } }
      this.recovered = 'defaults';
      this.db = tryOpen();
    }
  }

  _prepare() {
    const p = (sql) => this.db.prepare(sql);
    this.st = {
      placeByUrl: p('SELECT id, title, visit_count, last_visit, frecency FROM places WHERE url = ?'),
      insPlace: p('INSERT INTO places(url, title, visit_count, last_visit, frecency) VALUES (?, ?, ?, ?, ?)'),
      updPlace: p('UPDATE places SET title = ?, visit_count = ?, last_visit = ?, frecency = ? WHERE id = ?'),
      updTitle: p('UPDATE places SET title = ? WHERE id = ?'),
      lastVisit: p('SELECT id, time FROM visits WHERE place_id = ? ORDER BY time DESC LIMIT 1'),
      insVisit: p('INSERT INTO visits(place_id, time) VALUES (?, ?)'),
      updVisitTime: p('UPDATE visits SET time = ? WHERE id = ?'),
      visitById: p('SELECT id, place_id, time FROM visits WHERE id = ?'),
      delVisit: p('DELETE FROM visits WHERE id = ?'),
      visitExists: p('SELECT 1 FROM visits v JOIN places p ON p.id = v.place_id WHERE p.url = ? AND v.time = ?'),
      placeStats: p('SELECT count(*) AS n, max(time) AS last FROM visits WHERE place_id = ?'),
      delPlace: p('DELETE FROM places WHERE id = ?'),
      recent: p('SELECT url, title FROM places ORDER BY last_visit DESC LIMIT ?'),
      newest: p('SELECT v.id AS id, p.url AS url, p.title AS title, v.time AS time FROM visits v JOIN places p ON p.id = v.place_id ORDER BY v.time DESC LIMIT ?'),
      ftsSearch: p('SELECT p.url AS url, p.title AS title FROM places_fts f JOIN places p ON p.id = f.rowid WHERE places_fts MATCH ? ORDER BY p.frecency DESC LIMIT ?'),
      byFrecency: p('SELECT url, title, visit_count AS n, frecency FROM places ORDER BY frecency DESC LIMIT ?'),
      allForScan: p('SELECT id, url, title FROM places ORDER BY frecency DESC'),
      allVisits: p('SELECT id, place_id, time FROM visits ORDER BY time DESC'),
      allPlacesList: p('SELECT url, visit_count AS n FROM places'),
      oldest: p('SELECT id FROM visits ORDER BY time ASC LIMIT ?'),
      placeCounters: p('SELECT visit_count, frecency FROM places WHERE id = ?'),
      setCounters: p('UPDATE places SET visit_count = ?, last_visit = ?, frecency = ? WHERE id = ?'),
      visitTotal: p('SELECT count(*) AS n FROM visits'),
      placeTotal: p('SELECT count(*) AS n FROM places'),
      meta: p('SELECT value FROM meta WHERE key = ?'),
      setMeta: p('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)'),
    };
  }

  tx(fn) {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { try { this.db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
  }

  _meta(key) { const r = this.st.meta.get(key); return r ? r.value : null; }

  // ---------- frecency ----------
  _t0() { return Number(this._meta('t0') || T0_DEFAULT); }
  weight(time) { return Math.pow(2, (time - this._t0()) / HALF_LIFE_MS); }
  _rescaleIfNeeded() {
    const t0 = this._t0(), e = (Date.now() - t0) / HALF_LIFE_MS;
    if (e <= RESCALE_EXPONENT) return;
    const now = Date.now(), k = Math.pow(2, -(now - t0) / HALF_LIFE_MS);
    this.tx(() => {
      this.db.prepare('UPDATE places SET frecency = frecency * ?').run(k);
      this.st.setMeta.run('t0', String(now));
    });
  }

  _bump() { this._version++; this._listCache = null; }

  // ---------- візити ----------
  addVisit(url, title, time = Date.now()) {
    url = String(url == null ? '' : url);
    if (!/^https?:/i.test(url) || url.length > URL_MAX) return null;
    title = clip(title, TITLE_MAX);
    const id = this.tx(() => {
      const row = this.st.placeByUrl.get(url);
      if (!row) {
        const nid = Number(this.st.insPlace.run(url, title || url, 1, time, this.weight(time)).lastInsertRowid);
        this.st.insVisit.run(nid, time);
        this._bump();
        return nid;
      }
      const last = this.st.lastVisit.get(row.id);
      // повторне завантаження тієї ж сторінки протягом кількох секунд — не новий візит
      if (last && time - last.time >= 0 && time - last.time < DEDUPE_MS) {
        this.st.updVisitTime.run(time, last.id);
        this.st.updPlace.run(title || row.title, row.visit_count, Math.max(row.last_visit, time), row.frecency, row.id);
        return row.id;
      }
      this.st.insVisit.run(row.id, time);
      this.st.updPlace.run(title || row.title, row.visit_count + 1, Math.max(row.last_visit, time), row.frecency + this.weight(time), row.id);
      if (row.visit_count < 3 && row.visit_count + 1 >= 3) this._bump();
      return row.id;
    });
    this._maybePrune();
    return id;
  }

  // Назва сторінки приходить після навігації: оновлюємо ту саму адресу
  setTitle(url, title) {
    title = clip(title, TITLE_MAX);
    if (!title) return;
    const row = this.st.placeByUrl.get(String(url));
    if (row && row.title !== title) this.st.updTitle.run(title, row.id);
  }

  _maybePrune() {
    this._sinceCheck = (this._sinceCheck || 0) + 1;
    if (this._sinceCheck >= 200) { this._sinceCheck = 0; this.prune(); }
  }

  // Залишає не більше maxVisits останніх візитів; адреси без візитів видаляються
  prune() {
    const total = this.visitCount();
    if (total <= this.maxVisits) return 0;
    const excess = total - this.maxVisits;
    this.tx(() => {
      for (const { id } of this.st.oldest.all(excess)) this._removeVisitRow(id);
    });
    return excess;
  }

  _removeVisitRow(id) {
    const v = this.st.visitById.get(id);
    if (!v) return false;
    this.st.delVisit.run(id);
    const stats = this.st.placeStats.get(v.place_id);
    if (!stats.n) { this.st.delPlace.run(v.place_id); this._bump(); return true; }
    const place = this.st.placeCounters.get(v.place_id);
    this.st.setCounters.run(Math.max(stats.n, place.visit_count - 1), stats.last, Math.max(0, place.frecency - this.weight(v.time)), v.place_id);
    return true;
  }

  removeVisit(id) {
    id = Number(id);
    if (!Number.isInteger(id)) return false;
    return this.tx(() => this._removeVisitRow(id));
  }

  // Видаляє всі візити адреси (кнопка «забути сайт»)
  removeUrl(url) {
    const row = this.st.placeByUrl.get(String(url));
    if (!row) return false;
    this.st.delPlace.run(row.id);
    this._bump();
    return true;
  }

  clear() {
    this.tx(() => { this.db.exec('DELETE FROM visits; DELETE FROM places;'); });
    try { this.db.exec("INSERT INTO places_fts(places_fts) VALUES ('rebuild')"); } catch { /* ignore */ }
    this._bump();
  }

  visitCount() { return this.st.visitTotal.get().n; }
  placeCount() { return this.st.placeTotal.get().n; }

  // ---------- читання ----------
  // Візити для сторінки «Історія»: найновіші першими; запит — усі слова в назві/адресі (як і раніше)
  visits({ query = '', limit = 500 } = {}) {
    limit = Math.max(1, Math.min(5000, Number(limit) || 500));
    const match = matcher(query);
    if (!String(query || '').trim()) return this.st.newest.all(limit).map(r => ({ id: r.id, url: r.url, title: r.title, time: r.time }));
    const meta = new Map();
    for (const r of this.st.allForScan.all()) if (match(r.title, r.url)) meta.set(r.id, r);
    const out = [];
    if (!meta.size) return out;
    for (const v of this.st.allVisits.iterate()) {
      const m = meta.get(v.place_id);
      if (!m) continue;
      out.push({ id: v.id, url: m.url, title: m.title, time: v.time });
      if (out.length >= limit) break;
    }
    return out;
  }

  // Останні різні адреси (палітра команд)
  recentDistinct(limit = 300) { return this.st.recent.all(Math.max(1, Number(limit) || 300)).map(r => ({ title: r.title, url: r.url })); }

  // Підказки адресного рядка: FTS5 (префікси слів) за frecency, потім пошук підрядка в решті (щоб «oogle» знаходило google)
  search(query, { limit = 7, exclude = new Set() } = {}) {
    const match = matcher(query);
    const out = [];
    const seen = new Set(exclude);
    const take = (r) => {
      if (out.length >= limit || seen.has(r.url) || !match(r.title, r.url)) return;
      seen.add(r.url);
      out.push({ title: r.title, url: r.url });
    };
    const fts = ftsQuery(query);
    if (fts) {
      try { for (const r of this.st.ftsSearch.all(fts, limit * 4 + exclude.size)) take(r); }
      catch (e) { console.error('Places FTS:', e.message); }
    }
    if (out.length < limit) for (const r of this.st.allForScan.iterate()) { take(r); if (out.length >= limit) break; }
    return out;
  }

  // Найвідвідуваніші сайти: сума frecency за походженням (origin)
  topOrigins(originOf, limit = 8) {
    const byOrigin = new Map();
    for (const r of this.st.byFrecency.all(500)) {
      const o = originOf(r.url);
      if (!o) continue;
      const c = byOrigin.get(o) || { score: 0, url: r.url, title: r.title };
      c.score += r.frecency;
      byOrigin.set(o, c);
    }
    return [...byOrigin.values()].sort((a, b) => b.score - a.score).slice(0, limit).map(c => ({ url: c.url, title: c.title }));
  }

  // Список адрес із кількістю візитів (для визначення «своїх» доменів у захисті від шахрайства); кеш оновлюється лише
  // при появі/видаленні адреси або коли лічильник досягає 3
  list() {
    if (!this._listCache) {
      const arr = this.st.allPlacesList.all();
      arr.stamp = this._version;
      this._listCache = arr;
    }
    return this._listCache;
  }

  // Імпорт з інших браузерів: [{ url, title, time, n }]; дублікати (адреса + час) пропускаються
  importVisits(items) {
    let added = 0;
    this.tx(() => {
      for (const it of items) {
        const url = String((it && it.url) || ''), time = Number(it && it.time);
        if (!/^https?:/i.test(url) || url.length > URL_MAX || !(time > 0) || this.st.visitExists.get(url, time)) continue;
        const n = Math.max(1, Math.min(100000, Math.floor(Number(it.n) || 1)));
        const title = clip(it.title, TITLE_MAX);
        const row = this.st.placeByUrl.get(url);
        if (!row) this.st.insPlace.run(url, title || url, n, time, this.weight(time) * n);
        else this.st.updPlace.run(row.last_visit > time ? row.title : (title || row.title), row.visit_count + n, Math.max(row.last_visit, time), row.frecency + this.weight(time) * n, row.id);
        const id = row ? row.id : Number(this.st.placeByUrl.get(url).id);
        this.st.insVisit.run(id, time);
        added++;
      }
    });
    if (added) this._bump();
    this.prune();
    return added;
  }

  // ---------- закладки ----------
  loadBookmarks() {
    return this.db.prepare('SELECT url, title, added, mod FROM bookmarks ORDER BY rowid').all().map(r => ({ url: r.url, title: r.title, added: r.added, mod: r.mod }));
  }
  saveBookmarks(list) {
    const ins = this.db.prepare('INSERT OR REPLACE INTO bookmarks(url, title, added, mod) VALUES (?, ?, ?, ?)');
    this.tx(() => {
      this.db.exec('DELETE FROM bookmarks');
      for (const b of list) {
        if (!b || typeof b.url !== 'string' || !b.url || b.url.length > URL_MAX) continue;
        ins.run(b.url, clip(b.title, TITLE_MAX) || b.url, Number(b.added) || 0, Number(b.mod) || 0);
      }
    });
  }

  // ---------- міграція з history.json / bookmarks.json (одноразово; старі файли лишаються як *.migrated) ----------
  _migrateJson() {
    if (this._meta('json_migrated') === '1') return;
    const read = (name) => {
      const f = path.join(this.dir, name);
      if (!fs.existsSync(f)) return { f, data: null };
      try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); return { f, data: Array.isArray(d) ? d : null }; }
      catch { return { f, data: null }; }
    };
    const hist = read('history.json'), bms = read('bookmarks.json');
    const migrated = [];
    this.tx(() => {
      if (hist.data) {
        const entries = hist.data.filter(e => e && typeof e.url === 'string' && /^https?:/i.test(e.url) && e.url.length <= URL_MAX && Number(e.time) > 0).sort((a, b) => a.time - b.time);
        for (const e of entries) {
          const url = e.url, time = Number(e.time), n = Math.max(1, Math.min(100000, Math.floor(Number(e.n) || 1)));
          const row = this.st.placeByUrl.get(url);
          if (!row) this.st.insPlace.run(url, clip(e.title, TITLE_MAX) || url, n, time, this.weight(time) * n);
          else this.st.updPlace.run(clip(e.title, TITLE_MAX) || row.title, row.visit_count + n, Math.max(row.last_visit, time), row.frecency + this.weight(time) * n, row.id);
          this.st.insVisit.run(this.st.placeByUrl.get(url).id, time);
        }
        migrated.push(hist.f);
      }
      if (bms.data && this.db.prepare('SELECT count(*) AS n FROM bookmarks').get().n === 0) {
        const ins = this.db.prepare('INSERT OR IGNORE INTO bookmarks(url, title, added, mod) VALUES (?, ?, ?, ?)');
        for (const b of bms.data) if (b && typeof b.url === 'string' && b.url && b.url.length <= URL_MAX) ins.run(b.url, clip(b.title, TITLE_MAX) || b.url, Number(b.added) || 0, Number(b.mod) || 0);
        migrated.push(bms.f);
      } else if (bms.data) migrated.push(bms.f);
      this.st.setMeta.run('json_migrated', '1');
    });
    for (const f of migrated) { try { fs.renameSync(f, f + '.migrated'); } catch { /* ignore */ } }
    if (migrated.length) this._bump();
  }

  // ---------- завершення ----------
  flush() { try { this.db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch { /* ignore */ } }
  close() {
    places.delete(this);
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
    try { this.db.close(); } catch { /* ignore */ }
  }
}

// Закладки для решти коду: масив у пам'яті (синхронізація, імпорт, інтерфейс), запис у SQLite з відкладенням
class BookmarkStore {
  constructor(db) {
    this.db = db;
    this.data = db.loadBookmarks();
    this.timer = null;
    this.recovered = db.recovered;
  }
  save() { clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 400); }
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try { this.db.saveBookmarks(this.data); } catch (e) { console.error('Bookmarks write failed:', e.message); }
  }
}

function closeAllPlaces() { for (const p of [...places]) p.close(); }

module.exports = { Places, BookmarkStore, closeAllPlaces, ftsQuery, FILE };
