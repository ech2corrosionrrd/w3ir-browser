'use strict';
// Сторінка «Панель» (w3ir://dashboard): зведений стан браузера в Bento-картках.
// Логіка в головному процесі: сторінка отримує лише готові дані (без токенів, ключів і мнемоніки).
const fs = require('fs');
const path = require('path');
const isSafeRpc = (url) => require('./wallet-evm-core').isSafeRpc(url); // wallet-evm-core тягне ethers: вантажимо при першому виклику
const { assertPublicRpc } = require('./rpc-guard');

const PING_TIMEOUT = 6000;
const PING_MIN_INTERVAL = 10000;
const CLIP_CLEAR_MS = 20000;
const { stripCtl } = require('./util');
const clean = (s, n = 160) => stripCtl(s, n);

// Пінг eth_chainId на RPC кожної мережі: зелений лише якщо відповів правильний chainId
async function pingNetworks(networks, { timeout = PING_TIMEOUT, fetchFn = fetch } = {}) {
  return Promise.all(networks.map(async (n) => {
    const base = { chainId: n.chainId, name: clean(n.name, 60) };
    if (!isSafeRpc(n.rpc)) return { ...base, ok: false, error: 'небезпечна адреса RPC' };
    // мережа «зелена», якщо відповідає основний вузол або будь-який із запасних (гаманець переходить на запасний сам)
    const urls = [n.rpc, ...(Array.isArray(n.rpcFallback) ? n.rpcFallback : [])].filter(u => isSafeRpc(u));
    let last = { ...base, ok: false, error: 'немає відповіді' };
    for (let i = 0; i < urls.length; i++) {
      const t0 = Date.now();
      try {
        await assertPublicRpc(urls[i]);
        const res = await fetchFn(urls[i], {
          method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error',
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(timeout),
        });
        if (!res.ok) { last = { ...base, ok: false, error: 'HTTP ' + res.status }; continue; }
        const j = await res.json();
        const ok = !!j && j.result === '0x' + Number(n.chainId).toString(16);
        if (ok) return { ...base, ok, ms: Date.now() - t0, error: '', ...(i > 0 ? { fallback: true } : {}) };
        last = { ...base, ok: false, error: 'інший chainId' };
      } catch (e) { last = { ...base, ok: false, error: e && e.name === 'TimeoutError' ? 'тайм-аут' : 'немає відповіді' }; }
    }
    return last;
  }));
}

// ---------- сховище профілю: кеш і дані сайтів ----------
// Кеш (його можна безпечно скинути: перебудовується сам) і дані сайтів (cookie-сховища, IndexedDB тощо: лише показуються).
// Чіпаємо тільки каталоги власного профілю браузера, нічого поза ним.
const CACHE_DIRS = ['Cache', 'Code Cache'];
const SITE_DIRS = ['Local Storage', 'IndexedDB', 'Session Storage', 'Service Worker', 'Shared Dictionary'];
const SCAN_LIMIT = 50000; // не більше файлів за один підрахунок
const STORAGE_TTL = 30000;
const LOG_KEEP = 10;

async function dirSize(dir, budget) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = await fs.promises.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (--budget.left < 0) return total;
      if (e.isSymbolicLink()) continue; // посилання не відстежуємо
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) { try { total += (await fs.promises.stat(p)).size; } catch { /* зник під час підрахунку */ } }
    }
  }
  return total;
}

async function measureStorage(root) {
  const sum = async (names) => {
    const budget = { left: SCAN_LIMIT };
    let n = 0;
    for (const x of names) n += await dirSize(path.join(root, x), budget);
    return n;
  };
  return { cache: await sum(CACHE_DIRS), site: await sum(SITE_DIRS) };
}

// ---------- метрики роботи браузера ----------
const KB = 1024;
const GROUPS = { Browser: 'main', Tab: 'tabs', GPU: 'gpu', Utility: 'utility' };
const round1 = (x) => Math.round(x * 10) / 10;

// app.getAppMetrics() → суми за групами процесів. Пам'ять у КБ (privateBytes — приватна частина, ближча до правди, ніж робочий набір).
function aggregateProcesses(metrics, cores = 1) {
  const groups = {};
  let priv = 0, ws = 0, cpu = 0;
  for (const m of Array.isArray(metrics) ? metrics : []) {
    const key = GROUPS[m && m.type] || 'other';
    const mem = (m && m.memory) || {};
    const p = Number(mem.privateBytes) || 0, w = Number(mem.workingSetSize) || 0, c = Number(m && m.cpu && m.cpu.percentCPUUsage) || 0;
    const g = groups[key] || (groups[key] = { key, n: 0, privMb: 0, wsMb: 0, cpu: 0 });
    g.n++; g.privMb += p / KB; g.wsMb += w / KB; g.cpu += c;
    priv += p; ws += w; cpu += c;
  }
  const list = Object.values(groups).map(g => ({ key: g.key, n: g.n, privMb: Math.round(g.privMb), wsMb: Math.round(g.wsMb), cpu: round1(g.cpu) })).sort((a, b) => b.privMb - a.privMb);
  return { privMb: Math.round(priv / KB), wsMb: Math.round(ws / KB), cpu: Math.min(100, round1(cpu / Math.max(1, cores))), groups: list };
}

// Вкладки звичайних вікон (інкогніто й вікна ШІ не показуються): тільки хост, без шляху й параметрів адреси
function tabRows(ctx, privByPid = new Map()) {
  const rows = [];
  let total = 0, sleeping = 0, pinned = 0, playing = 0, windows = 0;
  for (const w of ctx.windows) {
    if (w.incognito) { total += w.tabs.length; windows++; continue; }
    windows++;
    for (const t of w.tabs) {
      total++;
      if (t.sleep) sleeping++;
      if (t.pinned) pinned++;
      if (t.playing) playing++;
      let host = '';
      try {
        const u = new URL(w.tabUrl(t));
        host = u.protocol === 'w3ir:' ? 'w3ir://' + u.hostname : u.hostname;
      } catch { host = ''; }
      let pid = 0;
      try { pid = t.sleep ? 0 : t.view.webContents.getOSProcessId(); } catch { pid = 0; }
      rows.push({ host: clean(host || '—', 80), pid, mb: privByPid.get(pid) || 0, sleeping: !!t.sleep, pinned: !!t.pinned, playing: !!t.playing, blocked: t.blocked || 0 });
    }
  }
  rows.sort((a, b) => b.mb - a.mb);
  return { total, sleeping, pinned, playing, windows, rows: rows.slice(0, 8) };
}

// Вік вбудованого Chromium без мережі. Опорна точка — Chromium 152 у актуальному на той момент Electron 44.9.0 (2026-10-17):
// далі рахуємо мажори по 4 тижні. Оцінка навмисно щедра (Electron сам відстає від Chrome на 1–3 мажори), тож попередження
// з'являється лише коли збірку давно не оновлювали. Опорну точку треба зсувати при кожному оновленні мажора Electron.
const CHROME_ANCHOR = { major: 152, ms: Date.UTC(2026, 9, 17) };
const CHROME_CYCLE_MS = 28 * 24 * 3600 * 1000;
const STALE_MAJORS = 4;
function engineLag(chromeVersion, now = Date.now()) {
  const major = parseInt(String(chromeVersion || '').split('.')[0], 10);
  if (!Number.isFinite(major) || !Number.isFinite(now)) return { lagMajors: 0, stale: false };
  const current = CHROME_ANCHOR.major + Math.floor((now - CHROME_ANCHOR.ms) / CHROME_CYCLE_MS);
  const lagMajors = Math.max(0, current - major);
  return { lagMajors, stale: lagMajors >= STALE_MAJORS };
}

function metrics(ctx, deps = {}) {
  const os = require('os');
  const appMetrics = deps.appMetrics || (() => require('electron').app.getAppMetrics());
  const raw = appMetrics();
  const proc = aggregateProcesses(raw, os.cpus().length);
  const privByPid = new Map((raw || []).map(m => [m.pid, Math.round((Number(m.memory && m.memory.privateBytes) || 0) / KB)]));
  const base = ctx.manager ? ctx.manager.ctx('default') : ctx;
  const up = ctx.manager && ctx.manager.updater ? ctx.manager.updater.brief() : null;
  const cfg = ctx.cfg();
  const th = ctx.threats ? ctx.threats.status() : null;
  return {
    now: Date.now(),
    uptimeSec: Math.round(process.uptime()),
    versions: { app: deps.version || require('electron').app.getVersion(), chrome: process.versions.chrome, electron: process.versions.electron },
    engine: engineLag(process.versions.chrome, deps.now),
    memory: { privMb: proc.privMb, wsMb: proc.wsMb, totalGb: Math.round(os.totalmem() / 2 ** 30) },
    cpu: proc.cpu,
    groups: proc.groups,
    tabs: tabRows(base, privByPid),
    stats: { ...ctx.stats },
    update: up,
    protection: { mode: cfg.protection || 'standard', engine: !!ctx.blocker, lists: th ? th.counts : { malware: 0, phishing: 0 }, listsUpdated: th ? th.updated : 0 },
  };
}

function state(ctx) {
  const base = ctx.manager ? ctx.manager.ctx('default') : ctx;
  const a = base.agent ? base.agent.status() : null;
  const w = ctx.wallet;
  const hidden = !!w && w.hidden(); // прихований гаманець: ні адрес, ні мереж, ні подій гаманця
  const unlocked = !hidden && !!w && w.exists() && ctx.vault.status() === 'unlocked';
  const info = unlocked ? w.info() : null;
  const nets = w && !hidden ? w.networks() : [];
  const active = info ? nets.find(n => n.chainId === info.activeChain) : null;
  const events = [];
  if (a) for (const l of a.log) events.push({ t: Date.parse(l.t) || 0, src: 'ШІ', text: clean(l.tool + ' ' + l.detail) });
  if (info) for (const l of info.log.slice(0, 30)) events.push({ t: l.t, src: 'Гаманець', text: clean(l.action + (l.origin ? ' · ' + l.origin : '')) });
  events.sort((x, y) => y.t - x.t);
  const th = ctx.threats ? ctx.threats.status() : null;
  const cfg = ctx.cfg();
  return {
    agent: a && { enabled: a.enabled, running: a.running, port: a.port, windowOpen: a.windowOpen, sites: a.sites.length, lastCall: a.lastCall, error: a.error, client: a.client, shares: a.shares.map(x => ({ id: x.id, site: clean(x.site, 80), mode: x.mode, until: x.until })) },
    wallet: { hidden, exists: !!w && w.exists() && !hidden, unlocked, accounts: info ? info.accounts : [], chain: active ? { id: active.chainId, name: clean(active.name, 60), symbol: clean(active.symbol, 10) } : null },
    networks: nets.map(n => ({ chainId: n.chainId, name: clean(n.name, 60) })),
    protection: { safe: cfg.safeBrowsing !== false, adblock: !!cfg.adblock, https: cfg.httpsFirst !== false, lists: th ? th.counts : { malware: 0, phishing: 0 }, updated: th ? th.updated : 0 },
    events: events.slice(0, 30),
  };
}

function createApi(ctx, { fetchFn } = {}) {
  let lastPing = { t: 0, data: null };
  let clipTimer = null;
  let storageCache = { t: 0, data: null };
  const baseCtx = () => (ctx.manager ? ctx.manager.ctx('default') : ctx);
  const cleanupStore = () => {
    const b = baseCtx();
    if (!b.cleanupStore) { const { Store } = require('./store'); b.cleanupStore = new Store('cleanup', { log: [] }, b.dir); }
    return b.cleanupStore;
  };
  async function storageSnapshot(force) {
    const ses = baseCtx().session;
    const root = ses && ses.getStoragePath && ses.getStoragePath();
    if (!root) return { ok: false, error: 'Недоступно.' };
    if (force || !storageCache.data || Date.now() - storageCache.t > STORAGE_TTL) storageCache = { t: Date.now(), data: await measureStorage(root) };
    return { ok: true, cacheBytes: storageCache.data.cache, siteBytes: storageCache.data.site, log: cleanupStore().data.log.slice(0, LOG_KEEP) };
  }
  return async function dashboardApi(name, arg) {
    try {
      switch (name) {
        case 'dashboard:state': return { ok: true, ...state(ctx) };
        case 'dashboard:metrics': return { ok: true, ...metrics(ctx) };
        case 'dashboard:ping': {
          if (lastPing.data && Date.now() - lastPing.t < PING_MIN_INTERVAL) return { ok: true, results: lastPing.data, cached: true };
          const results = await pingNetworks(ctx.wallet && !ctx.wallet.hidden() ? ctx.wallet.networks() : [], { fetchFn });
          lastPing = { t: Date.now(), data: results };
          return { ok: true, results };
        }
        case 'dashboard:storage': return storageSnapshot(false);
        case 'dashboard:cacheClear': {
          const ses = baseCtx().session;
          const before = await storageSnapshot(true);
          if (!before.ok) return before;
          await ses.clearCache();
          await ses.clearCodeCaches({});
          const after = await storageSnapshot(true);
          const freed = Math.max(0, before.cacheBytes - after.cacheBytes);
          const st = cleanupStore();
          st.data.log.unshift({ t: Date.now(), freed });
          st.data.log.length = Math.min(st.data.log.length, LOG_KEEP);
          st.save();
          return { ...(await storageSnapshot(false)), freed };
        }
        case 'dashboard:copy': {
          const addr = String(arg && arg.address || '');
          const info = ctx.wallet && ctx.vault.status() === 'unlocked' && ctx.wallet.exists() ? ctx.wallet.info() : null;
          if (!info || !info.accounts.includes(addr)) return { ok: false, error: 'Адресу не знайдено (розблокуйте сховище).' };
          const { clipboard } = require('electron');
          clipboard.writeText(addr);
          clearTimeout(clipTimer);
          clipTimer = setTimeout(() => { try { if (clipboard.readText() === addr) clipboard.clear(); } catch { /* ignore */ } }, CLIP_CLEAR_MS);
          return { ok: true, cleared: CLIP_CLEAR_MS / 1000 };
        }
        case 'dashboard:agent': {
          const base = ctx.manager ? ctx.manager.ctx('default') : ctx;
          if (!base.agent) return { ok: false, error: 'Недоступно.' };
          if (arg && arg.on) await base.agent.enable(); else base.agent.disable();
          return { ok: true };
        }
        case 'dashboard:agentTest': {
          const base = ctx.manager ? ctx.manager.ctx('default') : ctx;
          return base.agent ? await base.agent.selfTest() : { ok: false, error: 'Недоступно.' };
        }
        case 'dashboard:unshare': {
          const base = ctx.manager ? ctx.manager.ctx('default') : ctx;
          if (base.agent) base.agent.unshareAll('припинено з панелі');
          return { ok: true };
        }
        default: throw new Error('unknown');
      }
    } catch (e) { return { ok: false, error: clean(e && e.message, 200) }; }
  };
}

module.exports = { engineLag, measureStorage, pingNetworks, state, metrics, aggregateProcesses, tabRows, createApi, CLIP_CLEAR_MS };
