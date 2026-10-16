'use strict';
const { app, session, dialog, BrowserWindow, net, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { randomUUID } = require('crypto');
const { Store } = require('./store');
const { isBlockedUrl } = require('./blocklist');
const { Downloads } = require('./downloads');
const { Vault } = require('./vault');
const { Sync } = require('./sync');
const { GitHub } = require('./github');
const { Wallet } = require('./wallet');
const { Threats } = require('./threats');
const { parse: parseHost } = require('tldts-experimental');
const { attachCosmetic } = require('./adblock');
const { stripTracking, upgradeHttps } = require('./urlrules');

const PAGES = path.join(__dirname, '..', 'pages');
const UI = path.join(__dirname, '..', 'ui');

const DEFAULT_SETTINGS = {
  homepage: 'w3ir://newtab',
  searchEngine: 'google',
  startup: 'newtab', // newtab | restore
  adblock: true,
  sendGpc: true,
  showBookmarksBar: true,
  askDownload: false,
  downloadDir: '',
  httpsFirst: true,
  stripTracking: true,
  sleepTabs: true,
  verticalTabs: false,
  savePasswords: true,
  theme: 'system',
  adblockAllow: [],
  safeBrowsing: true,
  safeAllow: [],
  autoUpdate: true,
  updateFeed: '',
  keywords: '',
  walletEnabled: false,
  walletInject: true,
  walletChain: 1,
  torrentConfirm: true,
  autolockMinutes: 15,
};

const ENGINES = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=%s' },
};

const ALWAYS_ALLOW = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock', 'speaker-selection']);
const ASK = {
  media: 'камери та/або мікрофона',
  geolocation: 'вашого місцезнаходження',
  notifications: 'надсилання сповіщень',
  'clipboard-read': 'читання буфера обміну',
};

function originOf(u) { try { return new URL(u).origin; } catch { return ''; } }

function createContext({ id = 'default', dir, shared, manager } = {}) {
  const dataDir = dir || app.getPath('userData');
  fs.mkdirSync(dataDir, { recursive: true });
  shared = shared || { blocker: null, blockerPreload: null, sessions: [] };
  const ctx = {
    id,
    dir: dataDir,
    manager: manager || null,
    session: id === 'default' ? session.defaultSession : session.fromPartition('persist:profile-' + id),
    settingsStore: new Store('settings', DEFAULT_SETTINGS, dataDir),
    bookmarksStore: new Store('bookmarks', [], dataDir),
    historyStore: new Store('history', [], dataDir),
    windowStore: new Store('window', {}, dataDir),
    sessionStore: new Store('session', { windows: [] }, dataDir),
    permsStore: new Store('permissions', {}, dataDir),
    extStore: new Store('extensions', { items: [] }, dataDir),
    sessions: shared.sessions,
    upgraded: new Map(),
    httpsBypass: new Set(),
    windows: new Set(),
    registry: new Map(), // webContents.id -> { win, tab }
    incognitoSessions: new Map(),
    quitting: false,
    ENGINES,
    DEFAULT_SETTINGS,
  };

  // блокувальник і його preload спільні для всіх профілів
  for (const k of ['blocker', 'blockerPreload']) Object.defineProperty(ctx, k, { get: () => shared[k], set: (v) => { shared[k] = v; } });
  ctx.profile = () => (manager ? manager.info(id) : { id, name: 'Основний', color: '#5a8dee' });
  ctx.cfg = () => ctx.settingsStore.data;
  ctx.bookmarks = () => ctx.bookmarksStore.data;
  ctx.history = () => ctx.historyStore.data;
  ctx.downloads = new Downloads(ctx);

  const userData = dataDir;
  ctx.vault = new Vault({ dir: userData, autolockMinutes: ctx.cfg().autolockMinutes, onChange: () => { ctx.pushAll(); if (ctx.wallet) ctx.wallet.onVaultChange(); } });
  ctx.wallet = new Wallet(ctx);
  // Захист від шахрайських сайтів: списки спільні для всіх профілів і лежать у теці основного профілю
  shared.threats = shared.threats || { lists: null };
  ctx.threats = new Threats({
    dir: manager ? manager.dirOf('default') : dataDir, cfg: () => ctx.cfg(), history: () => ctx.history(), bookmarks: () => ctx.bookmarks(),
    shared: shared.threats.lists ? shared.threats : undefined, onChange: () => ctx.pushAll(),
  });
  if (!shared.threats.lists) shared.threats = ctx.threats.shared;
  ctx.sync = new Sync({
    dir: userData,
    bookmarks: {
      get: () => ctx.bookmarks(),
      set: (arr) => { ctx.bookmarksStore.data = arr; ctx.bookmarksStore.save(); },
    },
    onChange: () => ctx.pushAll(),
  });
  ctx.github = new GitHub({
    dir: userData,
    onChange: () => { ctx.pushAll(); for (const w of ctx.windows) w.refreshGithubOverlay(); },
  });
  if (ctx.github.connected()) setTimeout(() => ctx.github.start(), 5000);
  if (ctx.sync.state.data.enabled) { ctx.sync.start(); setTimeout(() => ctx.sync.syncNow(), 4000); }

  // Усі зміни закладок проходять тут — потрібні мітки часу та надгробки для синхронізації.
  ctx.bookmarkSet = (url, title) => {
    const l = ctx.bookmarks();
    const now = Date.now();
    const b = l.find(x => x.url === url);
    if (b) { b.title = title; b.mod = now; } else l.push({ url, title, added: now, mod: now });
    delete ctx.sync.tomb()[url];
    ctx.bookmarksStore.save();
    ctx.sync.schedule();
    ctx.pushAll();
  };
  ctx.bookmarkDelete = (url) => {
    const l = ctx.bookmarks();
    const i = l.findIndex(x => x.url === url);
    if (i < 0) return;
    l.splice(i, 1);
    ctx.sync.tomb()[url] = Date.now();
    ctx.bookmarksStore.save();
    ctx.sync.schedule();
    ctx.pushAll();
  };

  // ---------- реєстр вікон / вкладок ----------
  ctx.register = (wc, win, tab) => ctx.registry.set(wc.id, { win, tab });
  ctx.unregister = (wc) => ctx.registry.delete(wc.id);
  ctx.entryFor = (wc) => ctx.registry.get(wc.id);
  ctx.winFor = (wc) => (ctx.registry.get(wc.id) || {}).win;
  ctx.pushAll = () => { for (const w of ctx.windows) w.push(); };
  ctx.flushPending = () => { for (const w of ctx.windows) w.flushPending(); };
  ctx.relayoutAll = () => { for (const w of ctx.windows) { w.layout(); w.push(); } };
  ctx.onBlocked = (wcId) => {
    const e = ctx.registry.get(wcId);
    if (e && e.tab) { e.tab.blocked++; e.win.push(); }
  };

  // ---------- керування сайтами: дозволи, винятки блокувальника, дані ----------
  ctx.siteKey = (host) => { try { return parseHost(String(host)).domain || String(host).toLowerCase(); } catch { return String(host).toLowerCase(); } };
  ctx.topHost = (wcId) => {
    const e = ctx.registry.get(wcId);
    if (!e || !e.tab) return '';
    try { return new URL(e.tab.view.webContents.getURL()).hostname.toLowerCase(); } catch { return ''; }
  };
  ctx.adblockAllowed = (host) => !!host && (ctx.cfg().adblockAllow || []).includes(ctx.siteKey(host));
  ctx.setAdblockAllowed = (host, allowed) => {
    const key = ctx.siteKey(host);
    const list = ctx.cfg().adblockAllow = ctx.cfg().adblockAllow || [];
    const i = list.indexOf(key);
    if (allowed && i < 0 && list.length < 500) list.push(key);
    if (!allowed && i >= 0) list.splice(i, 1);
    ctx.settingsStore.save();
  };
  // Дозволи: у звичайних сеансах — у файлі профілю, в інкогніто — лише в пам'яті сеансу
  ctx.permStore = (ses) => ses.__w3irPerms || ctx.permsStore.data;
  ctx.permDecision = (ses, origin, permission) => { const v = ctx.permStore(ses)[origin + '|' + permission]; return typeof v === 'boolean' ? v : null; };
  ctx.sitePerms = (ses, origin) => Object.fromEntries(Object.keys(ASK).map(p => [p, ctx.permDecision(ses, origin, p)]));
  ctx.setSitePerm = (ses, origin, perm, value) => {
    if (!ASK[perm] || !originOf(origin) || originOf(origin) === 'null') return false;
    const store = ctx.permStore(ses);
    const key = originOf(origin) + '|' + perm;
    if (value === null || value === undefined) delete store[key]; else store[key] = !!value;
    if (!ses.__w3irPerms) ctx.permsStore.save();
    return true;
  };
  ctx.siteCookies = async (ses, host) => {
    const base = ctx.siteKey(host);
    const all = await ses.cookies.get({});
    return all.filter(c => { const d = String(c.domain || '').replace(/^\./, '').toLowerCase(); return d === base || d.endsWith('.' + base); });
  };
  ctx.clearSiteData = async (ses, host) => {
    const cookies = await ctx.siteCookies(ses, host);
    for (const c of cookies) {
      const d = String(c.domain).replace(/^\./, '');
      try { await ses.cookies.remove((c.secure ? 'https://' : 'http://') + d + (c.path || '/'), c.name); } catch { /* ignore */ }
    }
    for (const origin of [`https://${host}`, `http://${host}`]) {
      try { await ses.clearStorageData({ origin }); } catch { /* ignore */ }
    }
    return cookies.length;
  };

  // ---------- введення в адресний рядок ----------
  ctx.resolveInput = (input) => {
    input = String(input || '').trim();
    if (!input) return null;
    if (/^javascript:/i.test(input)) return null;
    if (/^(https?|file|about|w3ir|view-source):/i.test(input)) return input;
    const kw = ctx.keywordUrl(input);
    if (kw) return kw;
    if (!/\s/.test(input)) {
      if (/^(localhost|(\d{1,3}\.){3}\d{1,3})(:\d+)?([/?#].*)?$/i.test(input)) return 'http://' + input;
      if (/^[^\s/?#]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(input)) return 'https://' + input;
    }
    const engine = ENGINES[ctx.cfg().searchEngine] || ENGINES.google;
    return engine.url.replace('%s', encodeURIComponent(input));
  };
  // Ключові слова адресного рядка: «gh owner/repo», «npm react», власні — у налаштуваннях
  ctx.keywordUrl = (input) => {
    const m = /^(\S+)\s+(.+)$/.exec(input);
    if (!m) return null;
    const kw = m[1].toLowerCase();
    const q = m[2].trim();
    const enc = encodeURIComponent;
    const repo = /^[\w.-]+\/[\w.-]+$/.test(q);
    const gh = (suffix, fallback) => (repo ? `https://github.com/${q}${suffix}` : fallback);
    switch (kw) {
      case 'gh': return gh('', /^[\w-]+$/.test(q) ? `https://github.com/${q}` : `https://github.com/search?q=${enc(q)}&type=repositories`);
      case 'ghi': return gh('/issues', `https://github.com/search?q=${enc(q)}&type=issues`);
      case 'ghp': return gh('/pulls', `https://github.com/search?q=${enc(q)}&type=pullrequests`);
      case 'gha': return gh('/actions', null);
      case 'ghc': return `https://github.com/search?q=${enc(q)}&type=code`;
      case 'npm': return `https://www.npmjs.com/search?q=${enc(q)}`;
      case 'mdn': return `https://developer.mozilla.org/search?q=${enc(q)}`;
      case 'yt': return `https://www.youtube.com/results?search_query=${enc(q)}`;
      case 'wiki': return `https://uk.wikipedia.org/w/index.php?search=${enc(q)}`;
      case 'crates': return `https://crates.io/search?q=${enc(q)}`;
      case 'pypi': return `https://pypi.org/search/?q=${enc(q)}`;
    }
    for (const line of String(ctx.cfg().keywords || '').split('\n').slice(0, 100)) {
      const mm = /^\s*(\S+)\s*=\s*(https?:\/\/\S*%s\S*)\s*$/i.exec(line);
      if (mm && mm[1].toLowerCase() === kw) return mm[2].replace('%s', enc(q));
    }
    return null;
  };
  ctx.looksLikeUrl = (input) => {
    const r = ctx.resolveInput(input);
    return !!r && !r.startsWith(ENGINES[ctx.cfg().searchEngine]?.url.split('%s')[0] || '\0');
  };

  // ---------- історія ----------
  ctx.historyAdd = (url, title) => {
    if (!/^https?:/i.test(url)) return;
    const h = ctx.history();
    const last = h[h.length - 1];
    if (last && last.url === url && Date.now() - last.time < 5000) {
      last.time = Date.now();
      if (title) last.title = title;
    } else {
      h.push({ id: randomUUID(), url, title: title || url, time: Date.now() });
      if (h.length > 20000) h.splice(0, h.length - 20000);
    }
    ctx.historyStore.save();
  };
  // ---------- імпорт з інших браузерів ----------
  ctx.importBookmarks = (items) => {
    const l = ctx.bookmarks();
    const have = new Set(l.map(b => b.url));
    const now = Date.now();
    let added = 0;
    for (const it of items) {
      if (have.has(it.url)) continue;
      have.add(it.url);
      l.push({ url: it.url, title: it.title, added: it.added || now, mod: now }); // mod=now, щоб імпорт не «програв» старому видаленню
      delete ctx.sync.tomb()[it.url];
      added++;
    }
    ctx.bookmarksStore.save();
    ctx.sync.schedule();
    ctx.pushAll();
    return { added, skipped: items.length - added };
  };
  ctx.importHistory = (items) => {
    const h = ctx.history();
    const have = new Set(h.map(e => e.url + '|' + e.time));
    let added = 0;
    for (const it of items) {
      const key = it.url + '|' + it.time;
      if (have.has(key) || !(it.time > 0)) continue;
      have.add(key);
      h.push({ id: randomUUID(), url: it.url, title: it.title, time: it.time, n: it.n || 1 });
      added++;
    }
    h.sort((a, b) => a.time - b.time);
    if (h.length > 20000) h.splice(0, h.length - 20000);
    ctx.historyStore.save();
    return { added, skipped: items.length - added };
  };
  ctx.historyTitle = (url, title) => {
    const h = ctx.history();
    for (let i = h.length - 1, n = 0; i >= 0 && n < 20; i--, n++) {
      if (h[i].url === url) { h[i].title = title; ctx.historyStore.save(); return; }
    }
  };
  ctx.topSites = (limit = 8) => {
    const out = [];
    const seen = new Set();
    const add = (url, title) => {
      const o = originOf(url);
      if (!o || seen.has(o) || out.length >= limit) return;
      seen.add(o);
      out.push({ url, title: title || new URL(url).hostname });
    };
    for (const b of ctx.bookmarks()) add(b.url, b.title);
    const counts = new Map();
    for (const e of ctx.history()) {
      const o = originOf(e.url);
      if (!o) continue;
      const c = counts.get(o) || { n: 0, url: e.url, title: e.title };
      c.n += e.n || 1; c.url = e.url; c.title = e.title;
      counts.set(o, c);
    }
    [...counts.values()].sort((a, b) => b.n - a.n).forEach(c => add(c.url, c.title));
    return out;
  };
  ctx.suggest = (text) => {
    const q = String(text || '').trim();
    if (!q) return [];
    const ql = q.toLowerCase();
    const items = [{ type: ctx.looksLikeUrl(q) ? 'url' : 'search', title: q, url: q }];
    const seen = new Set();
    const match = (e) => (e.title || '').toLowerCase().includes(ql) || e.url.toLowerCase().includes(ql);
    for (const b of ctx.bookmarks()) {
      if (items.length >= 7) break;
      if (match(b) && !seen.has(b.url)) { seen.add(b.url); items.push({ type: 'bookmark', title: b.title, url: b.url }); }
    }
    const h = ctx.history();
    for (let i = h.length - 1; i >= 0 && items.length < 7; i--) {
      const e = h[i];
      if (match(e) && !seen.has(e.url)) { seen.add(e.url); items.push({ type: 'history', title: e.title, url: e.url }); }
    }
    return items;
  };

  // ---------- сесія ----------
  ctx.saveSession = () => {
    if (ctx.quitting) return;
    const wins = [...ctx.windows].filter(w => !w.incognito && !w.closing).map(w => w.snapshot()).filter(s => s.urls.length);
    if (!wins.length) return; // не затираємо останній збережений стан
    ctx.sessionStore.data = { windows: wins };
    ctx.sessionStore.save();
  };

  ctx.openWindow = (opts) => {
    const { AppWindow } = require('./app-window');
    return new AppWindow(ctx, opts);
  };

  // ---------- сесії Electron ----------
  ctx.getIncognitoSession = (id) => {
    let ses = ctx.incognitoSessions.get(id);
    if (!ses) {
      ses = session.fromPartition('incognito-' + id + '-' + Date.now());
      ctx.incognitoSessions.set(id, ses);
      ctx.setupSession(ses, true);
    }
    return ses;
  };

  ctx.setupSession = (ses, incognito) => {
    ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|w3ir-browser|W3IR\S*)\/\S+/g, ''));

    ses.protocol.handle('w3ir', (req) => {
      let u;
      try { u = new URL(req.url); } catch { return new Response('Bad request', { status: 400 }); }
      const ext = path.extname(u.pathname);
      const file = u.hostname === 'ui'
        ? path.join(UI, path.basename(u.pathname))
        : path.join(PAGES, ext ? path.basename(u.pathname) : path.basename(u.hostname) + '.html');
      if (!fs.existsSync(file)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });

    ctx.sessions.push(ses);
    attachCosmetic(ctx, ses);

    ses.webRequest.onBeforeRequest((details, cb) => {
      const cfg = ctx.cfg();
      const url = details.url;
      if (details.resourceType === 'mainFrame') {
        if (details.method === 'GET' && /^https?:/i.test(url)) {
          let target = url;
          if (cfg.stripTracking) target = stripTracking(target);
          if (cfg.httpsFirst) {
            const up = upgradeHttps(target, ctx.httpsBypass);
            if (up) {
              ctx.upgraded.set(up, target);
              if (ctx.upgraded.size > 200) ctx.upgraded.delete(ctx.upgraded.keys().next().value);
              target = up;
            }
          }
          if (cfg.safeBrowsing !== false) {
            const th = ctx.threats.check(target);
            if (th) return cb({ redirectURL: ctx.threats.warningUrl(th, target) });
          }
          if (target !== url) return cb({ redirectURL: target });
        }
        return cb({});
      }
      if (cfg.adblock && /^https?:/i.test(url) && !ctx.adblockAllowed(ctx.topHost(details.webContentsId))) {
        if (ctx.blocker) {
          return ctx.blocker.onBeforeRequest(details, (resp) => {
            if ((resp.cancel || resp.redirectURL) && details.webContentsId) ctx.onBlocked(details.webContentsId);
            cb(resp);
          });
        }
        if (isBlockedUrl(url)) {
          if (details.webContentsId) ctx.onBlocked(details.webContentsId);
          return cb({ cancel: true });
        }
      }
      cb({});
    });
    ses.webRequest.onHeadersReceived((details, cb) => {
      if (ctx.blocker && ctx.cfg().adblock && /^https?:/i.test(details.url) && !ctx.adblockAllowed(ctx.topHost(details.webContentsId))) return ctx.blocker.onHeadersReceived(details, cb);
      cb({});
    });
    ses.webRequest.onBeforeSendHeaders((details, cb) => {
      if (ctx.cfg().sendGpc) { details.requestHeaders['Sec-GPC'] = '1'; details.requestHeaders['DNT'] = '1'; }
      cb({ requestHeaders: details.requestHeaders });
    });

    if (incognito) ses.__w3irPerms = {};
    const decisions = () => ctx.permStore(ses);
    const remember = (key, val) => { decisions()[key] = val; if (!incognito) ctx.permsStore.save(); };

    ses.setPermissionRequestHandler((wc, permission, cb, details) => {
      if (ALWAYS_ALLOW.has(permission)) return cb(true);
      if (!ASK[permission]) return cb(false);
      const origin = originOf(details.requestingUrl || wc.getURL());
      if (!origin || origin === 'null') return cb(false);
      const key = origin + '|' + permission;
      const known = decisions()[key];
      if (typeof known === 'boolean') return cb(known);
      const parent = (ctx.winFor(wc) || {}).win || BrowserWindow.getFocusedWindow();
      dialog.showMessageBox(parent, {
        type: 'question',
        buttons: ['Дозволити', 'Заблокувати'],
        defaultId: 1, cancelId: 1,
        title: 'Запит дозволу',
        message: `${origin} запитує доступ до ${ASK[permission]}`,
        checkboxLabel: 'Запам\'ятати вибір для цього сайту',
      }).then(r => {
        const allow = r.response === 0;
        if (r.checkboxChecked) remember(key, allow);
        cb(allow);
      }).catch(() => cb(false));
    });
    ses.setPermissionCheckHandler((wc, permission, origin) => {
      if (ALWAYS_ALLOW.has(permission)) return true;
      return decisions()[originOf(origin) + '|' + permission] === true;
    });

    ctx.downloads.attach(ses, incognito);
  };

  ctx.setupSession(ctx.session, false);
  return ctx;
}

module.exports = { createContext, DEFAULT_SETTINGS, ENGINES, ASK };
