'use strict';
const { ipcMain, app, dialog, shell } = require('electron');
const { t: tr } = require('./i18n');
const { normOrigin } = require('./vault');
const { hexChain } = require('./wallet');
const { i18n, LANGS } = require('./i18n');
const protection = require('./protection');
const { walletApi, arweaveApi } = require('./ipc-wallet');
const { sitesApi, safeApi, updateApi, syncApi } = require('./ipc-browser');

// Після зміни мови: перезавантажити інтерфейс вікон і відкриті внутрішні сторінки всіх профілів
function reloadUi(ctx) {
  const all = ctx.manager ? ctx.manager.all() : [ctx];
  for (const c of all) for (const w of c.windows) {
    for (const t of w.tabs) { const wc = t.view.webContents; if (!wc.isDestroyed() && wc.getURL().startsWith('w3ir://')) wc.reload(); }
    for (const wc of [w.chrome, w.overlay && w.overlay.webContents]) if (wc && !wc.isDestroyed()) wc.reloadIgnoringCache();
    setTimeout(() => { try { w.push(); } catch { /* вікно закрите */ } }, 700);
  }
}
const path = require('path');
const fs = require('fs');

const MAX_CSV = 10 * 1024 * 1024;

// Перезаписує файл випадковими байтами перед видаленням (на SSD гарантій немає, але це краще за звичайне видалення)
function shred(file) {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r+');
    const buf = require('crypto').randomBytes(Math.min(Math.max(size, 1), 1 << 20));
    for (let w = 0; w < size; w += buf.length) fs.writeSync(fd, buf, 0, Math.min(buf.length, size - w), w);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch { /* ignore */ }
  fs.unlinkSync(file);
}

async function vaultApi(ctx, entry, name, arg) {
  const v = ctx.vault;
  const win = entry.win;
  const str = (x, n = 2048) => String(x == null ? '' : x).slice(0, n);
  const fail = (e) => ({ ok: false, error: e && e.message === 'locked' ? 'Сховище заблоковано.' : (e && e.message) || 'Помилка' });
  try {
    switch (name) {
      case 'vault:status': return { status: v.status(), autolock: ctx.cfg().autolockMinutes, pepper: !!(v.header && v.header.pepper) || require('electron').safeStorage.isEncryptionAvailable() };
      case 'vault:create': { const r = await v.create(str(arg.master, 256)); if (r.ok) ctx.flushPending(); return r; }
      case 'vault:unlock': { const r = await v.unlock(str(arg.master, 256)); if (r.ok) ctx.flushPending(); return r; }
      case 'vault:lock': v.lock(); return { ok: true };
      case 'vault:list': return { ok: true, entries: v.list() };
      case 'vault:reveal':
      case 'vault:copy':
      case 'vault:totp':
      case 'vault:copyTotp': {
        if (!v.recentlyAuthed() && !(await v.reauth(str(arg.master, 256)))) return { ok: false, needAuth: true, error: arg.master ? 'Хибний майстер-пароль.' : '' };
        if (name === 'vault:copy') return { ok: v.copyPassword(arg.id), cleared: 20 };
        if (name === 'vault:totp') return v.getTotp(str(arg.id, 64));
        if (name === 'vault:copyTotp') return { ok: v.copyTotp(str(arg.id, 64)), cleared: 20 };
        const e = v.get(arg.id);
        return e ? { ok: true, password: e.password, note: e.note, totp: e.totp || '' } : { ok: false, error: 'Запис не знайдено.' };
      }
      case 'vault:save': {
        if (arg.id) {
          v.update(arg.id, { url: arg.url ? str(arg.url) : undefined, username: str(arg.username), password: arg.password ? str(arg.password, 1024) : undefined, note: str(arg.note, 8192), totp: arg.totp !== undefined ? str(arg.totp, 2048) : undefined });
          return { ok: true };
        }
        v.add({ url: str(arg.url), username: str(arg.username), password: str(arg.password, 1024), note: str(arg.note, 8192), totp: str(arg.totp, 2048) });
        return { ok: true };
      }
      case 'vault:remove': v.remove(str(arg.id, 64)); return { ok: true };
      case 'vault:generate': return { ok: true, password: v.generate({ length: arg.length, symbols: arg.symbols !== false }) };
      case 'vault:changeMaster': return await v.changeMaster(str(arg.oldPw, 256), str(arg.newPw, 256));
      case 'vault:setAutolock': {
        const m = Math.max(1, Math.min(240, Number(arg.minutes) || 15));
        ctx.cfg().autolockMinutes = m; ctx.settingsStore.save(); v.setAutolock(m);
        return { ok: true };
      }
      case 'vault:export': {
        if (!v.recentlyAuthed() && !(await v.reauth(str(arg.master, 256)))) return { ok: false, needAuth: true, error: arg.master ? 'Хибний майстер-пароль.' : '' };
        const r = await require('electron').dialog.showSaveDialog(win.win, { title: tr('Зашифрована резервна копія'), defaultPath: 'w3ir-passwords-backup.w3irvault', filters: [{ name: 'W3IR vault', extensions: ['w3irvault'] }] });
        if (r.canceled || !r.filePath) return { ok: false, error: '' };
        return await v.exportBackup(r.filePath, str(arg.backupPassword, 256));
      }
      case 'vault:import': {
        const r = await require('electron').dialog.showOpenDialog(win.win, { title: tr('Резервна копія'), filters: [{ name: 'W3IR vault', extensions: ['w3irvault'] }], properties: ['openFile'] });
        if (r.canceled || !r.filePaths[0]) return { ok: false, error: '' };
        return await v.importBackup(r.filePaths[0], str(arg.backupPassword, 256));
      }
      case 'vault:importCsv': {
        const r = await require('electron').dialog.showOpenDialog(win.win, { title: tr('CSV з паролями (Chrome, Edge, Firefox)'), filters: [{ name: 'CSV', extensions: ['csv'] }], properties: ['openFile'] });
        if (r.canceled || !r.filePaths[0]) return { ok: false, error: '' };
        if (fs.statSync(r.filePaths[0]).size > MAX_CSV) return { ok: false, error: 'Файл надто великий.' };
        const res = v.importCsv(fs.readFileSync(r.filePaths[0], 'utf8'));
        if (res.ok) {
          const d = await require('electron').dialog.showMessageBox(win.win, {
            type: 'warning', buttons: [tr('Видалити файл безпечно'), tr('Залишити')], defaultId: 0, cancelId: 1,
            message: tr('CSV-файл містить паролі у відкритому вигляді'),
            detail: tr('Імпортовано записів: {0}. Рекомендуємо одразу видалити файл (його буде перезаписано й видалено).', res.added),
          });
          if (d.response === 0) { try { shred(r.filePaths[0]); res.deleted = true; } catch { res.deleted = false; } }
        }
        return res;
      }
      default: throw new Error('unknown');
    }
  } catch (e) { return fail(e); }
}

async function importApi(ctx, entry, name, arg) {
  const imp = require('./importer');
  switch (name) {
    case 'import:detect': return imp.detect().map(s => ({ id: s.id, browser: s.browser, name: s.name, kind: s.kind }));
    case 'import:run': {
      const src = imp.findSource(String(arg.id || ''));
      if (!src) return { ok: false, error: 'Профіль не знайдено.' };
      const out = { ok: true };
      try {
        if (arg.bookmarks) out.bookmarks = ctx.importBookmarks(imp.readBookmarks(src));
        if (arg.history) out.history = ctx.importHistory(imp.readHistory(src));
      } catch (e) { return { ok: false, error: e.message, ...out }; }
      return out;
    }
    default: throw new Error('unknown');
  }
}

async function profilesApi(ctx, entry, name, arg) {
  const m = ctx.manager;
  const { dialog } = require('electron');
  try {
    switch (name) {
      case 'profiles:list': return { ok: true, current: ctx.id, profiles: m.list().map(p => ({ ...p, open: !!(m.ctxs.get(p.id) && m.ctxs.get(p.id).windows.size) })) };
      case 'profiles:create': { const id = m.create(arg.name, arg.color); if (arg.open) m.open(id); return { ok: true, id }; }
      case 'profiles:rename': m.rename(String(arg.id), arg.name); return { ok: true };
      case 'profiles:open': if (!m.has(arg.id)) throw new Error('Профіль не знайдено.'); m.open(arg.id); return { ok: true };
      case 'profiles:remove': {
        if (arg.id === 'default' || !m.has(arg.id)) throw new Error('Цей профіль видалити не можна.');
        if (arg.id === ctx.id) throw new Error('Не можна видалити профіль із його власного вікна. Відкрийте цю сторінку з іншого профілю.');
        const p = m.info(arg.id);
        const r = await dialog.showMessageBox(entry.win.win, {
          type: 'warning', buttons: [tr('Видалити назавжди'), tr('Скасувати')], defaultId: 1, cancelId: 1,
          message: tr('Видалити профіль «{0}»?', p.name),
          detail: tr('Буде видалено закладки, історію, паролі, cookie та всі інші дані цього профілю. Дію неможливо скасувати.'),
        });
        if (r.response !== 0) return { ok: false, error: '' };
        await m.remove(arg.id);
        return { ok: true };
      }
      default: throw new Error('unknown');
    }
  } catch (e) { return { ok: false, error: e.message }; }
}

async function githubApi(ctx, name, arg) {
  const g = ctx.github;
  try {
    switch (name) {
      case 'github:status': return { ok: true, ...g.status() };
      case 'github:connect': await g.connect(String(arg.token || '')); return { ok: true, ...g.status() };
      case 'github:disconnect': g.disconnect(); return { ok: true, ...g.status() };
      default: throw new Error('unknown');
    }
  } catch (e) { return { ok: false, error: e.message }; }
}

// ---------- права внутрішніх сторінок: ЄДИНА таблиця ----------
// Адреса сторінки: w3ir://<назва>[/][?запит]. Групи команд (за префіксом) → які сторінки й які саме команди дозволено
// ('*' — усі команди групи). Конфіденційні групи не приймають адреси із запитом (QUERY_OK).
const PAGE_RE = /^w3ir:\/\/([a-z]+)\/?(\?[^#]*)?(#.*)?$/;
const POLICY = {
  'wallet:': { wallet: '*', settings: ['wallet:hide', 'wallet:unhide'] },
  'pdf:': { pdftools: '*' },
  'arweave:': { wallet: '*', dashboard: '*' },
  'assistant:': { assistant: '*' },
  'import:': { import: '*' },
  'sites:': { settings: '*' }, 'update:': { settings: '*' }, 'sync:': { settings: '*' }, 'github:': { settings: '*' }, 'agent:': { settings: '*' },
  'profiles:': { profiles: '*' },
  'dashboard:': { dashboard: '*' },
  'vault:': { passwords: '*', import: ['vault:status', 'vault:importCsv'], wallet: ['vault:status', 'vault:unlock', 'vault:lock'] },
  'safe:': { warning: ['safe:proceed', 'safe:trust'], settings: ['safe:status', 'safe:update'] },
};
// Окремі команди без групи: назва → сторінки
const PAGE_ONLY = {
  'settings:get': ['settings', 'help'], 'settings:set': ['settings'], defaultbrowser: ['settings'],
  'ext:add': ['settings'], 'ext:remove': ['settings'], clear: ['settings'],
  'reader:get': ['reader'], 'reader:translate': ['reader'], 'reader:summarize': ['reader'], 'doc:get': ['doc'], 'doc:print': ['doc'], 'doc:savePdf': ['doc'], resolve: ['newtab'], topsites: ['newtab'], startinfo: ['newtab'],
  'history:get': ['history'], 'history:remove': ['history'], 'history:clear': ['history'],
  'bookmarks:get': ['bookmarks'], 'bookmarks:remove': ['bookmarks'],
  'downloads:get': ['downloads'], 'downloads:action': ['downloads'],
};
// Сторінки, що відкриваються із запитом в адресі (попередження, службові); решта — лише точна адреса
const QUERY_OK = new Set(['warning', 'history', 'bookmarks', 'downloads', 'newtab', 'reader', 'help']);

function permitted(name, url) {
  const m = PAGE_RE.exec(String(url || ''));
  if (!m) return false;
  const page = m[1];
  if (m[2] && !QUERY_OK.has(page)) return false;
  const prefix = Object.keys(POLICY).find(x => String(name).startsWith(x));
  if (prefix) {
    const rule = POLICY[prefix][page];
    return rule === '*' || (Array.isArray(rule) && rule.includes(name));
  }
  const only = PAGE_ONLY[name];
  return only ? only.includes(page) : false; // невідомі команди суворо відхиляються (default-deny)
}

async function agentApi(ctx, name, arg) {
  const base = ctx.manager ? ctx.manager.ctx('default') : ctx;
  const a = base.agent;
  if (!a) return { ok: false, error: 'Недоступно.' };
  try {
    switch (name) {
      case 'agent:status': return { ok: true, ...a.status(), tools: require('./agent').TOOLS.map(t => t.name) };
      case 'agent:enable': await a.enable(); return { ok: true, ...a.status() };
      case 'agent:disable': a.disable(); return { ok: true, ...a.status() };
      case 'agent:token': return { ok: true, token: a.token || '' };
      case 'agent:regenerate': a.regenerate(); if (a.server) await a.start(); return { ok: true, ...a.status() };
      case 'agent:setPort': a.setPort(arg.port); return { ok: true, ...a.status() };
      case 'agent:closeWindow': a.closeWindow(); return { ok: true, ...a.status() };
      case 'agent:test': return { ...(await a.selfTest()), ...{ status: a.status() } };
      case 'agent:unshareAll': a.unshareAll('припинено в налаштуваннях'); return { ok: true, ...a.status() };
      default: throw new Error('unknown');
    }
  } catch (e) { return { ok: false, error: e.message }; }
}

// Локальний ШІ-помічник (Ollama): лише зі сторінки w3ir://assistant, лише з не приватного вікна
async function assistantApi(ctx, entry, name, arg) {
  const base = ctx.manager ? ctx.manager.ctx('default') : ctx;
  const a = base.assistant;
  if (!a || entry.win.incognito || entry.win.agent) return { ok: false, error: 'Недоступно у приватному вікні та у вікні ШІ.' };
  try {
    switch (name) {
      case 'assistant:status': return { ok: true, config: a.config(), ...a.snapshot() };
      case 'assistant:models': return { ok: true, models: await a.models() };
      case 'assistant:save': return { ok: true, config: a.save({ url: arg.url, model: arg.model }) };
      case 'assistant:run': a.start(arg.prompt); return { ok: true };
      case 'assistant:poll': return { ok: true, ...a.snapshot() };
      case 'assistant:stop': return { ok: true, was: a.stop() };
      case 'assistant:share': {
        // вкладка, з якої користувач відкрив помічника: лише читання, зі згодою у довіреному вікні
        const src = entry.win.assistantFrom;
        if (!src || !entry.win.tabs.includes(src)) return { ok: false, error: 'Вкладку, з якої ви відкрили помічника, закрито. Відкрийте потрібну сторінку й викличте помічника знову (Ctrl+K).' };
        await base.agent.share(entry.win, src, 'read', { local: true });
        return { ok: true };
      }
      default: throw new Error('unknown');
    }
  } catch (e) { return { ok: false, error: String(e.message || 'Помилка').slice(0, 400) }; }
}

function registerIpc(resolve) {
  // Провайдер гаманця та параметри приватності для сторінок: синхронна ініціалізація
  ipcMain.on('wallet:init', (e) => {
    let r = { enabled: false, fingerprint: false };
    try {
      const ctx = resolve(e.sender);
      const entry = ctx && ctx.entryFor(e.sender);
      const origin = entry && e.senderFrame === e.sender.mainFrame ? normOrigin(e.senderFrame.url) : null;
      if (ctx) {
        let host = '';
        try { host = new URL(e.senderFrame.url).hostname.toLowerCase(); } catch { /* ignore */ }
        const allowed = host && ctx.adblockAllowed && ctx.adblockAllowed(host);
        r.fingerprint = !allowed && !!(ctx.cfg().fingerprintProtection || ctx.protection() === 'maximum');
      }
      if (entry && entry.tab && !entry.win.incognito && origin && ctx.wallet.injectEnabled()) {
        r.enabled = true;
        r.chainId = hexChain(ctx.wallet.chainOf(origin));
      }
    } catch { /* ignore */ }
    e.returnValue = r;
  });
  ipcMain.handle('wallet:request', async (e, req) => {
    const fail = (code, message) => ({ error: { code, message } });
    const ctx = resolve(e.sender);
    const entry = ctx && ctx.entryFor(e.sender);
    if (!entry || !entry.tab || entry.win.incognito || e.senderFrame !== e.sender.mainFrame) return fail(4100, 'Недоступно');
    const origin = normOrigin(e.senderFrame.url);
    if (!origin) return fail(4100, 'Гаманець доступний лише на https-сайтах');
    if (!ctx.wallet.injectEnabled()) return fail(4100, 'Гаманець вимкнено');
    try {
      const result = await ctx.wallet.request(entry.win, entry.tab, origin, req);
      return { result: result === undefined ? null : result };
    } catch (err) {
      return fail(Number.isInteger(err.code) ? err.code : -32603, String(err.message || 'Помилка').slice(0, 400));
    }
  });

  // Перехоплені форми входу (від preload вкладки, лише головний фрейм, не інкогніто)
  ipcMain.on('vault:captured', (e, data) => {
    const ctx = resolve(e.sender);
    if (!ctx) return;
    const entry = ctx.entryFor(e.sender);
    if (!entry || !entry.tab || entry.win.incognito || e.senderFrame !== e.sender.mainFrame) return;
    if (!data || typeof data.password !== 'string' || typeof data.username !== 'string') return;
    if (!data.password || data.password.length > 1024 || data.username.length > 512) return;
    entry.win.offerSave(entry.tab, { username: data.username, password: data.password }, e.senderFrame.url);
  });

  // WebAuthn недоступний у цій збірці: показуємо підказку (не частіше, ніж раз на 30 с на вікно)
  ipcMain.on('webauthn:unsupported', (e) => {
    const ctx = resolve(e.sender);
    if (!ctx) return;
    const entry = ctx.entryFor(e.sender);
    if (!entry || !entry.tab || e.senderFrame !== e.sender.mainFrame) return;
    const win = entry.win;
    if (win.agent || Date.now() - (win._waToast || 0) < 30000) return;
    win._waToast = Date.now();
    win.toast('Passkeys і ключі безпеки поки не підтримуються в W3IR Browser: увійдіть паролем (🔑 менеджер паролів) або іншим способом.');
  });

  // Команди з інтерфейсу браузера (панель вкладок / оверлей).
  ipcMain.handle('cmd', (e, cmd, arg) => {
    const ctx = resolve(e.sender);
    if (!ctx) return;
    const w = ctx.winFor(e.sender);
    // Команди приймаємо лише від власного UI, а не від вебсторінок.
    if (!w || (e.sender !== w.chrome && e.sender !== w.overlay.webContents)) return;
    return w.exec(cmd, arg);
  });
  ipcMain.handle('suggest', (e, text) => {
    const ctx = resolve(e.sender);
    if (!ctx) return [];
    const w = ctx.winFor(e.sender);
    if (!w || e.sender !== w.chrome) return [];
    return ctx.suggest(text);
  });

  // API внутрішніх сторінок w3ir://
  const SETTING_TYPES = {
    homepage: 'string', searchEngine: 'string', startup: 'string', adblock: 'boolean', cookieBanners: 'boolean',
    sendGpc: 'boolean', showBookmarksBar: 'boolean', askDownload: 'boolean', downloadDir: 'string',
    httpsFirst: 'boolean', stripTracking: 'boolean', protection: 'string', fingerprintProtection: 'boolean', sleepTabs: 'boolean', sleepMinutes: 'number', verticalTabs: 'boolean', savePasswords: 'boolean', safeBrowsing: 'boolean', theme: 'string', language: 'string', keywords: 'string', torrentConfirm: 'boolean',
  };

  ipcMain.handle('internal', async (e, name, arg) => {
    const ctx = resolve(e.sender);
    if (!ctx) throw new Error('forbidden');
    const entry = ctx.entryFor(e.sender);
    const frame = e.senderFrame;
    if (!entry || !entry.tab || !frame || frame !== e.sender.mainFrame || !frame.url.startsWith('w3ir://')) {
      throw new Error('forbidden');
    }
    if (entry.win.agent) throw new Error('forbidden'); // у вікні під керуванням ШІ внутрішні сторінки не мають доступу до даних
    arg = arg || {};
    // Єдина таблиця прав (POLICY / PAGE_ONLY): яка внутрішня сторінка може викликати яку команду
    if (!permitted(name, frame.url)) throw new Error('forbidden');
    if (name.startsWith('wallet:')) return walletApi(ctx, entry, name, arg);
    if (name.startsWith('pdf:')) return require('./pdf-tools').api(ctx, entry, name, arg);
    if (name.startsWith('assistant:')) return assistantApi(ctx, entry, name, arg || {});
    if (name.startsWith('arweave:')) return arweaveApi(ctx, name, arg);
    if (name.startsWith('sites:')) return sitesApi(ctx, name, arg);
    if (name.startsWith('safe:')) return safeApi(ctx, name, arg);
    if (name.startsWith('update:')) return updateApi(ctx, name, arg, entry);
    if (name.startsWith('profiles:')) return profilesApi(ctx, entry, name, arg);
    if (name.startsWith('import:')) return importApi(ctx, entry, name, arg);
    if (name.startsWith('github:')) return githubApi(ctx, name, arg);
    if (name.startsWith('dashboard:')) {
      if (!ctx.dashboardApi) ctx.dashboardApi = require('./dashboard').createApi(ctx);
      return ctx.dashboardApi(name, arg);
    }
    if (name.startsWith('agent:')) return agentApi(ctx, name, arg);
    if (name.startsWith('vault:')) return vaultApi(ctx, entry, name, arg);
    if (name.startsWith('sync:')) return syncApi(ctx, entry, name, arg);
    switch (name) {
      case 'settings:get':
        return { settings: ctx.cfg(), engines: Object.fromEntries(Object.entries(ctx.ENGINES).map(([k, v]) => [k, v.name])), incognito: entry.win.incognito, theme: (ctx.manager ? ctx.manager.ctx('default') : ctx).cfg().theme, language: (ctx.manager ? ctx.manager.ctx('default') : ctx).cfg().language || 'auto', languages: Object.fromEntries(Object.entries(LANGS).map(([k, v]) => [k, v.name])), version: app.getVersion(), adblockEngine: !!ctx.blocker, extensions: ctx.extStore.data.items };
      case 'settings:set': {
        const cfg = ctx.cfg();
        for (const [k, v] of Object.entries(arg)) {
          if (!(k in SETTING_TYPES) || typeof v !== SETTING_TYPES[k]) continue;
          if (k === 'searchEngine' && !ctx.ENGINES[v]) continue;
          if (k === 'startup' && !['newtab', 'restore'].includes(v)) continue;
          if (k === 'sleepMinutes' && ![5, 15, 30, 60, 120].includes(v)) continue;
          if (k === 'protection') {
            if (!protection.LEVELS.includes(v)) continue;
            // режим вмикає потрібні перемикачі приватності; окремі з них можна потім вимкнути вручну
            if (v !== 'maximum') cfg.fingerprintProtection = false;
            Object.assign(cfg, protection.PRESETS[v]);
            cfg.protection = v;
            ctx.applyProtection();
            continue;
          }
          if (k === 'cookieBanners') {
            // як тема: одне значення на всі профілі, рушій блокувальника підміняється одразу
            const base = ctx.manager ? ctx.manager.ctx('default') : ctx;
            base.cfg().cookieBanners = v; base.settingsStore.save();
            require('./adblock').reloadBlocker(ctx).catch(e => console.error('Adblock reload failed:', e.message));
            continue;
          }
          if (k === 'theme') {
            if (!['system', 'light', 'dark'].includes(v)) continue;
            // тема спільна для всіх профілів: зберігаємо в основному й застосовуємо до всього застосунку
            const base = ctx.manager ? ctx.manager.ctx('default') : ctx;
            base.cfg().theme = v; base.settingsStore.save();
            require('electron').nativeTheme.themeSource = v;
            continue;
          }
          if (k === 'language') {
            if (v !== 'auto' && !LANGS[v]) continue;
            // мова спільна для всіх профілів (як тема): зберігаємо в основному профілі й перезавантажуємо інтерфейс
            const base = ctx.manager ? ctx.manager.ctx('default') : ctx;
            base.cfg().language = v; base.settingsStore.save();
            i18n.setLang(v, app.getLocale());
            setImmediate(() => reloadUi(ctx));
            continue;
          }
          cfg[k] = k === 'keywords' ? v.slice(0, 4000) : v;
        }
        ctx.settingsStore.save();
        ctx.relayoutAll();
        return cfg;
      }
      case 'reader:get': return entry.tab.reader || null;
      case 'reader:translate':
      case 'reader:summarize': {
        const base = ctx.manager ? ctx.manager.ctx('default') : ctx;
        const cfg = base.cfg();
        const url = cfg.ollamaUrl || require('./ollama').DEFAULT_URL;
        const model = cfg.ollamaModel || '';
        if (!model) return { ok: false, error: 'Виберіть модель Ollama.' };
        try {
          const fn = name === 'reader:summarize' ? require('./ollama').summarize : require('./ollama').translate;
          const r = await fn(url, { model, text: String(arg.text || ''), targetLang: String(arg.lang || 'Ukrainian') });
          return { ok: true, text: r.content, model };
        } catch (err) {
          return { ok: false, error: String((err && err.message) || 'Помилка').slice(0, 300) };
        }
      }
      case 'doc:get': return entry.tab.doc || null;
      case 'doc:print': entry.tab.view.webContents.print(); return true;
      case 'doc:savePdf': {
        const r = await require('./pdf').savePageAsPdf(entry.win, entry.tab.view.webContents, {});
        return { ok: r.ok, error: r.error };
      }
      case 'defaultbrowser': shell.openExternal('ms-settings:defaultapps'); return true;
      case 'ext:add': {
        const r = await dialog.showOpenDialog(entry.win.win, { title: tr('Папка розпакованого розширення'), properties: ['openDirectory'] });
        if (r.canceled || !r.filePaths[0]) return ctx.extStore.data.items;
        const dir = r.filePaths[0];
        if (!fs.existsSync(path.join(dir, 'manifest.json'))) throw new Error('У папці немає manifest.json');
        const ext = await ctx.session.extensions.loadExtension(dir, { allowFileAccess: false });
        const items = ctx.extStore.data.items;
        if (!items.some(i => i.path === dir)) items.push({ path: dir, name: ext.name, id: ext.id });
        ctx.extStore.save();
        return items;
      }
      case 'ext:remove': {
        const items = ctx.extStore.data.items;
        const i = items.findIndex(x => x.path === arg.path);
        if (i >= 0) {
          try { ctx.session.extensions.removeExtension(items[i].id); } catch {}
          items.splice(i, 1);
          ctx.extStore.save();
        }
        return items;
      }
      case 'resolve': return ctx.resolveInput(arg.text);
      case 'topsites': return ctx.topSites(8);
      case 'startinfo': return require('./startpage').info(ctx);
      case 'history:get': return ctx.places.visits({ query: arg && arg.query, limit: 500 });
      case 'history:remove': ctx.places.removeVisit(arg && arg.id); return true;
      case 'history:clear': ctx.places.clear(); return true;
      case 'bookmarks:get': return ctx.bookmarks();
      case 'bookmarks:remove': {
        ctx.bookmarkDelete(arg.url);
        return true;
      }
      case 'downloads:get': return ctx.downloads.list();
      case 'downloads:action': ctx.downloads.action(arg.id, arg.action, entry.win); return true;
      case 'clear': {
        const ses = entry.win.ses;
        if (arg.history) ctx.places.clear();
        const all = [ses, ...(entry.win.incognito ? [] : ctx.containerSessions.values())];
        if (arg.cookies) for (const s of all) await s.clearStorageData();
        if (arg.cache) for (const s of all) await s.clearCache();
        return true;
      }
      default: throw new Error('unknown');
    }
  });
}

module.exports = { registerIpc, permitted };
