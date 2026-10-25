'use strict';
// Імпорт закладок та історії з Chrome/Edge/Brave/Chromium/Vivaldi і Firefox.
// Дані читаються з тимчасової копії файлів профілю (оригінали не змінюються).
// Паролі автоматично НЕ витягуються: браузери захищають їх ключами, прив'язаними до себе
// (у Chrome — App-Bound Encryption); їх імпортують через CSV, який користувач експортує сам.
const fs = require('fs');
const os = require('os');
const path = require('path');

const WEBKIT_EPOCH_MS = 11644473600000;
const MAX_HISTORY = 20000;
const MAX_BOOKMARKS = 20000;

const CHROMIUM = [
  { id: 'chrome', label: 'Google Chrome', rel: ['Google', 'Chrome', 'User Data'] },
  { id: 'edge', label: 'Microsoft Edge', rel: ['Microsoft', 'Edge', 'User Data'] },
  { id: 'brave', label: 'Brave', rel: ['BraveSoftware', 'Brave-Browser', 'User Data'] },
  { id: 'chromium', label: 'Chromium', rel: ['Chromium', 'User Data'] },
  { id: 'vivaldi', label: 'Vivaldi', rel: ['Vivaldi', 'User Data'] },
  // Opera зберігає єдиний профіль просто в каталозі застосунку в Roaming (без Default/Profile N)
  { id: 'opera', label: 'Opera', roaming: true, flat: true, rel: ['Opera Software', 'Opera Stable'] },
  { id: 'operagx', label: 'Opera GX', roaming: true, flat: true, rel: ['Opera Software', 'Opera GX Stable'] },
  { id: 'arc', label: 'Arc', rel: ['Arc', 'User Data'] },
  { id: 'thorium', label: 'Thorium', rel: ['Thorium', 'User Data'] },
  { id: 'supermium', label: 'Supermium', rel: ['Supermium', 'User Data'] },
  { id: 'helium', label: 'Helium', rel: ['imput', 'Helium', 'User Data'] },
  { id: 'cromite', label: 'Cromite', rel: ['Cromite', 'User Data'] },
  { id: 'catsxp', label: 'CatsXP', rel: ['ArcSoft', 'CatsXP', 'User Data'] },
];

// Форки Firefox зберігають профілі за тією самою схемою, що й Firefox
const FIREFOX = [
  { id: 'firefox', label: 'Mozilla Firefox', rel: ['Mozilla', 'Firefox', 'Profiles'] },
  { id: 'librewolf', label: 'LibreWolf', rel: ['LibreWolf', 'Profiles'] },
  { id: 'waterfox', label: 'Waterfox', rel: ['Waterfox', 'Profiles'] },
  { id: 'floorp', label: 'Floorp', rel: ['Floorp', 'Profiles'] },
  { id: 'zen', label: 'Zen', rel: ['Zen', 'Profiles'] },
];

const isImportable = (u) => typeof u === 'string' && u.length <= 4096 && /^(https?|file):/i.test(u);
const { stripCtl } = require('./util');
const clean = (s, n = 500) => stripCtl(s, n);

// Позначки часу Chrome (мкс від 1601 р.) не вміщуються в double, тому читаємо BigInt і ділимо точно
const big = (st) => { st.setReadBigInts(true); return st; };
const msFrom = (v, divisor) => Number(BigInt(v) / BigInt(divisor));

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Профілі Chromium-браузерів: каталоги, де є Bookmarks або History
function detectChromium(localBase = process.env.LOCALAPPDATA, roamingBase = process.env.APPDATA) {
  const out = [];
  for (const b of CHROMIUM) {
    const base = b.roaming ? roamingBase : localBase;
    if (!base) continue;
    const root = path.join(base, ...b.rel);
    if (!fs.existsSync(root)) continue;
    const state = readJson(path.join(root, 'Local State')) || {};
    const cache = (state.profile && state.profile.info_cache) || {};
    let dirs = [];
    if (b.flat) dirs = ['.'];
    else try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && (d.name === 'Default' || /^Profile \d+$/.test(d.name))).map(d => d.name); } catch { /* ignore */ }
    for (const d of dirs) {
      const dir = path.join(root, d);
      if (!fs.existsSync(path.join(dir, 'Bookmarks')) && !fs.existsSync(path.join(dir, 'History'))) continue;
      if (b.flat) { out.push({ id: `${b.id}:.`, kind: 'chromium', browser: b.label, name: 'Основний профіль', dir }); continue; }
      const name = clean(((cache[d] && cache[d].name) || d) + (cache[d] && cache[d].name ? ' (' + d + ')' : ''), 80);
      out.push({ id: `${b.id}:${d}`, kind: 'chromium', browser: b.label, name, dir });
    }
  }
  return out;
}

function detectFirefox(base = process.env.APPDATA) {
  const out = [];
  if (!base) return out;
  for (const b of FIREFOX) {
    const root = path.join(base, ...b.rel);
    if (!fs.existsSync(root)) continue;
    try {
      for (const d of fs.readdirSync(root, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const dir = path.join(root, d.name);
        if (!fs.existsSync(path.join(dir, 'places.sqlite'))) continue;
        out.push({ id: `${b.id}:${d.name}`, kind: 'firefox', browser: b.label, name: clean(d.name.replace(/^[a-z0-9]{8}./i, ''), 80), dir });
      }
    } catch { /* ignore */ }
  }
  return out;
}

function detect(opts = {}) {
  return [...detectChromium(opts.localAppData, opts.appData), ...detectFirefox(opts.appData)];
}

// Копіюємо базу (разом із WAL) у тимчасову папку, бо оригінал може бути заблокований запущеним браузером
function withDbCopy(dbPath, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w3ir-import-'));
  try {
    const target = path.join(tmp, 'db.sqlite');
    try { fs.copyFileSync(dbPath, target); }
    catch { throw new Error('Не вдалося прочитати файл — закрийте цей браузер і повторіть.'); }
    for (const ext of ['-wal', '-shm']) {
      try { if (fs.existsSync(dbPath + ext)) fs.copyFileSync(dbPath + ext, target + ext); } catch { /* необов'язково */ }
    }
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(target, { readOnly: true });
    try { return fn(db); } finally { db.close(); }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---------- закладки ----------
function chromiumBookmarks(src) {
  const j = readJson(path.join(src.dir, 'Bookmarks'));
  if (!j || !j.roots) return [];
  const out = [];
  const walk = (node, depth) => {
    if (!node || depth > 32 || out.length >= MAX_BOOKMARKS) return;
    if (node.type === 'url' && isImportable(node.url)) {
      const added = node.date_added ? Math.round(Number(node.date_added) / 1000 - WEBKIT_EPOCH_MS) : Date.now();
      out.push({ url: node.url, title: clean(node.name) || node.url, added: added > 0 && added < Date.now() + 864e5 ? added : Date.now() });
    }
    if (Array.isArray(node.children)) for (const c of node.children) walk(c, depth + 1);
  };
  for (const root of Object.values(j.roots)) if (root && typeof root === 'object') walk(root, 0);
  return out;
}

function firefoxBookmarks(src) {
  return withDbCopy(path.join(src.dir, 'places.sqlite'), (db) => {
    const rows = big(db.prepare(`SELECT p.url AS url, b.title AS title, b.dateAdded AS added
      FROM moz_bookmarks b JOIN moz_places p ON p.id = b.fk
      WHERE b.type = 1 AND p.url IS NOT NULL LIMIT ?`)).all(MAX_BOOKMARKS);
    return rows.filter(r => isImportable(r.url)).map(r => ({
      url: r.url, title: clean(r.title) || r.url, added: r.added ? msFrom(r.added, 1000) : Date.now(),
    }));
  });
}

// ---------- історія ----------
function chromiumHistory(src) {
  const file = path.join(src.dir, 'History');
  if (!fs.existsSync(file)) return [];
  return withDbCopy(file, (db) => {
    const rows = big(db.prepare(`SELECT url, title, visit_count AS n, last_visit_time AS t FROM urls
      WHERE hidden = 0 AND last_visit_time > 0 ORDER BY last_visit_time DESC LIMIT ?`)).all(MAX_HISTORY);
    return rows.filter(r => isImportable(r.url)).map(r => ({
      url: r.url, title: clean(r.title) || r.url, n: Math.max(1, Math.min(Number(r.n) || 1, 1000)),
      time: msFrom(r.t, 1000) - WEBKIT_EPOCH_MS,
    }));
  });
}

function firefoxHistory(src) {
  return withDbCopy(path.join(src.dir, 'places.sqlite'), (db) => {
    const rows = big(db.prepare(`SELECT url, title, visit_count AS n, last_visit_date AS t FROM moz_places
      WHERE hidden = 0 AND last_visit_date IS NOT NULL ORDER BY last_visit_date DESC LIMIT ?`)).all(MAX_HISTORY);
    return rows.filter(r => isImportable(r.url)).map(r => ({
      url: r.url, title: clean(r.title) || r.url, n: Math.max(1, Math.min(Number(r.n) || 1, 1000)),
      time: msFrom(r.t, 1000),
    }));
  });
}

function readBookmarks(src) { return src.kind === 'firefox' ? firefoxBookmarks(src) : chromiumBookmarks(src); }
function readHistory(src) { return src.kind === 'firefox' ? firefoxHistory(src) : chromiumHistory(src); }

// Знаходимо джерело лише серед виявлених (id від сторінки не перетворюється на довільний шлях)
function findSource(id, opts) { return detect(opts).find(s => s.id === id) || null; }

module.exports = { detect, findSource, readBookmarks, readHistory, MAX_HISTORY };
