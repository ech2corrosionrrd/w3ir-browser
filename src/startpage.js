'use strict';
// Дані для стартової сторінки (w3ir://newtab): короткий стан браузера для інформаційного рядка й останні закладки.
// Сторінка отримує лише готові безпечні дані: жодних сум гаманця, адрес рахунків, токенів і адрес вкладок інкогніто.
const { cleanStrict } = require('./util');

const clean = (s, n) => cleanStrict(s, n);
const isWeb = (u) => /^https?:\/\//i.test(String(u || ''));

// Останні закладки (за часом додавання): лише http(s), без дублікатів за адресою
function recentBookmarks(list, limit = 8) {
  const seen = new Set();
  const out = [];
  const items = (Array.isArray(list) ? list : []).filter(b => b && isWeb(b.url)).sort((a, b) => (Number(b.added) || 0) - (Number(a.added) || 0));
  for (const b of items) {
    if (seen.has(b.url)) continue;
    seen.add(b.url);
    out.push({ url: String(b.url).slice(0, 2000), title: clean(b.title || b.url, 120) });
    if (out.length >= limit) break;
  }
  return out;
}

function info(ctx, deps = {}) {
  const base = ctx.manager ? ctx.manager.ctx('default') : ctx;
  let total = 0, sleeping = 0;
  for (const w of base.windows) {
    if (w.incognito) continue;
    for (const t of w.tabs) { total++; if (t.sleep) sleeping++; }
  }
  const w = ctx.wallet;
  const walletState = w && w.hidden() ? 'hidden' : (!w || !w.exists() ? 'none' : (ctx.vault.status() === 'unlocked' ? 'ready' : 'locked'));
  const up = ctx.manager && ctx.manager.updater ? ctx.manager.updater.brief() : null;
  const s = ctx.stats || { blocked: 0, cookies: 0, https: 0, threats: 0 };
  const dl = ctx.downloads ? ctx.downloads.summary() : { active: 0, percent: -1 };
  const cfg = ctx.cfg();
  return {
    version: deps.version || require('electron').app.getVersion(),
    tabs: { total, sleeping },
    protection: { mode: cfg.protection || 'standard', adblock: !!cfg.adblock, safe: cfg.safeBrowsing !== false, blocked: s.blocked + s.cookies + s.https + s.threats },
    update: up ? { state: up.state, version: up.version || '' } : null,
    wallet: walletState,
    downloads: { active: dl.active, percent: dl.percent },
    bookmarks: recentBookmarks(ctx.bookmarks ? ctx.bookmarks() : [], 8),
    bookmarkCount: (ctx.bookmarks ? ctx.bookmarks() : []).length,
    engine: (ctx.ENGINES[cfg.searchEngine] || ctx.ENGINES.google).name,
  };
}

module.exports = { info, recentBookmarks };
