'use strict';
const { ipcMain, app, dialog, shell } = require('electron');
const { normOrigin } = require('./vault');
const { hexChain } = require('./wallet');
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
      case 'vault:copy': {
        if (!v.recentlyAuthed() && !(await v.reauth(str(arg.master, 256)))) return { ok: false, needAuth: true, error: arg.master ? 'Хибний майстер-пароль.' : '' };
        if (name === 'vault:copy') return { ok: v.copyPassword(arg.id), cleared: 20 };
        const e = v.get(arg.id);
        return e ? { ok: true, password: e.password, note: e.note } : { ok: false, error: 'Запис не знайдено.' };
      }
      case 'vault:save': {
        if (arg.id) {
          v.update(arg.id, { url: arg.url ? str(arg.url) : undefined, username: str(arg.username), password: arg.password ? str(arg.password, 1024) : undefined, note: str(arg.note, 8192) });
          return { ok: true };
        }
        v.add({ url: str(arg.url), username: str(arg.username), password: str(arg.password, 1024), note: str(arg.note, 8192) });
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
        const r = await require('electron').dialog.showSaveDialog(win.win, { title: 'Зашифрована резервна копія', defaultPath: 'w3ir-passwords-backup.w3irvault', filters: [{ name: 'W3IR vault', extensions: ['w3irvault'] }] });
        if (r.canceled || !r.filePath) return { ok: false, error: '' };
        return await v.exportBackup(r.filePath, str(arg.backupPassword, 256));
      }
      case 'vault:import': {
        const r = await require('electron').dialog.showOpenDialog(win.win, { title: 'Резервна копія', filters: [{ name: 'W3IR vault', extensions: ['w3irvault'] }], properties: ['openFile'] });
        if (r.canceled || !r.filePaths[0]) return { ok: false, error: '' };
        return await v.importBackup(r.filePaths[0], str(arg.backupPassword, 256));
      }
      case 'vault:importCsv': {
        const r = await require('electron').dialog.showOpenDialog(win.win, { title: 'CSV з паролями (Chrome, Edge, Firefox)', filters: [{ name: 'CSV', extensions: ['csv'] }], properties: ['openFile'] });
        if (r.canceled || !r.filePaths[0]) return { ok: false, error: '' };
        if (fs.statSync(r.filePaths[0]).size > MAX_CSV) return { ok: false, error: 'Файл надто великий.' };
        const res = v.importCsv(fs.readFileSync(r.filePaths[0], 'utf8'));
        if (res.ok) {
          const d = await require('electron').dialog.showMessageBox(win.win, {
            type: 'warning', buttons: ['Видалити файл безпечно', 'Залишити'], defaultId: 0, cancelId: 1,
            message: 'CSV-файл містить паролі у відкритому вигляді',
            detail: 'Імпортовано записів: ' + res.added + '. Рекомендуємо одразу видалити файл (його буде перезаписано й видалено).',
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
          type: 'warning', buttons: ['Видалити назавжди', 'Скасувати'], defaultId: 1, cancelId: 1,
          message: `Видалити профіль «${p.name}»?`,
          detail: 'Буде видалено закладки, історію, паролі, cookie та всі інші дані цього профілю. Дію неможливо скасувати.',
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
      default: throw new Error('unknown');
    }
  } catch (e) { return { ok: false, error: e.message }; }
}

async function walletApi(ctx, entry, name, arg) {
  const w = ctx.wallet;
  const v = ctx.vault;
  const authed = async () => v.recentlyAuthed() || (typeof arg.master === 'string' && v.status() === 'unlocked' && await v.reauth(arg.master.slice(0, 256)));
  try {
    switch (name) {
      case 'wallet:status': {
        const st = v.status();
        return { ok: true, vault: st, exists: w.exists(), inject: ctx.cfg().walletInject !== false, info: st === 'unlocked' && w.exists() ? w.info() : null };
      }
      case 'wallet:create': return { ok: true, phrase: w.create() };
      case 'wallet:import': w.importPhrase(arg.phrase); return { ok: true };
      case 'wallet:addAccount': return { ok: true, accounts: w.addAccount() };
      case 'wallet:reveal': if (!(await authed())) return { ok: false, needAuth: true, error: arg.master ? 'Хибний майстер-пароль.' : '' }; return { ok: true, phrase: w.reveal() };
      case 'wallet:remove': {
        if (!(await authed())) return { ok: false, needAuth: true, error: arg.master ? 'Хибний майстер-пароль.' : '' };
        const r = await dialog.showMessageBox(entry.win.win, {
          type: 'warning', buttons: ['Видалити гаманець', 'Скасувати'], defaultId: 1, cancelId: 1, message: 'Видалити гаманець із цього пристрою?',
          detail: 'Без фрази відновлення доступ до коштів буде втрачено назавжди. Переконайтеся, що фразу збережено.',
        });
        if (r.response !== 0) return { ok: false, error: '' };
        w.remove();
        return { ok: true };
      }
      case 'wallet:balances': return { ok: true, balances: await w.balances() };
      case 'wallet:setChain': w.setChain(Number(arg.id)); return { ok: true };
      case 'wallet:setRpc': w.setRpc(Number(arg.id), arg.url); return { ok: true };
      case 'wallet:disconnect': w.disconnectSite(String(arg.origin)); return { ok: true };
      case 'wallet:setInject': ctx.cfg().walletInject = !!arg.on; ctx.settingsStore.save(); return { ok: true };
      default: throw new Error('unknown');
    }
  } catch (e) { return { ok: false, error: e.code === 4100 ? 'Спершу розблокуйте сховище паролів.' : e.message }; }
}

async function sitesApi(ctx, name, arg) {
  switch (name) {
    case 'sites:list': {
      const perms = Object.entries(ctx.permsStore.data)
        .filter(([k, v]) => typeof v === 'boolean' && k.includes('|'))
        .map(([k, v]) => { const i = k.lastIndexOf('|'); return { origin: k.slice(0, i), perm: k.slice(i + 1), value: v }; })
        .sort((a, b) => a.origin.localeCompare(b.origin) || a.perm.localeCompare(b.perm));
      return { ok: true, perms, adblockAllow: (ctx.cfg().adblockAllow || []).slice().sort() };
    }
    case 'sites:resetPerm': return { ok: ctx.setSitePerm(ctx.session, String(arg.origin), String(arg.perm), null) };
    case 'sites:resetAllPerms': { const st = ctx.permsStore.data; for (const k of Object.keys(st)) delete st[k]; ctx.permsStore.save(); return { ok: true }; }
    case 'sites:adblockRemove': ctx.setAdblockAllowed(String(arg.domain), false); ctx.pushAll(); return { ok: true };
    default: throw new Error('unknown');
  }
}

async function safeApi(ctx, name, arg) {
  const t = ctx.threats;
  const httpUrl = (u) => { try { const x = new URL(String(u)); return /^https?:$/.test(x.protocol) ? x : null; } catch { return null; } };
  switch (name) {
    case 'safe:status': return { ok: true, ...t.status(), updating: !!t.running };
    case 'safe:update': await t.update(); return { ok: !t.meta.error, error: t.meta.error, ...t.status() };
    case 'safe:proceed': { const u = httpUrl(arg.url); if (!u) return { ok: false }; t.bypass.add(u.hostname.toLowerCase()); return { ok: true }; }
    case 'safe:trust': {
      const u = httpUrl(arg.url);
      if (!u) return { ok: false };
      const hn = u.hostname.toLowerCase();
      const had = t.bypass.delete(hn);
      const th = t.check(u.href);
      if (th && !th.canTrust) { if (had) t.bypass.add(hn); return { ok: false, error: 'Сайти зі списків шахрайських ресурсів не можна додати в довірені.' }; }
      const { parse } = require('tldts-experimental');
      const dom = parse(u.hostname).domain || u.hostname;
      const list = ctx.cfg().safeAllow = ctx.cfg().safeAllow || [];
      if (!list.includes(dom) && list.length < 200) list.push(dom);
      ctx.settingsStore.save();
      return { ok: true };
    }
    default: throw new Error('unknown');
  }
}

async function updateApi(ctx, name, arg, entry) {
  const m = ctx.manager;
  const base = m ? m.ctx('default') : ctx; // налаштування оновлення спільні й зберігаються в основному профілі
  const u = m && m.updater;
  if (!u) throw new Error('unavailable');
  const { parseFeed } = require('./updater');
  switch (name) {
    case 'update:status': return u.status();
    case 'update:check': return u.check({ manual: true });
    case 'update:setFeed': {
      const feed = String(arg.feed || '').trim().slice(0, 300);
      if (feed && !parseFeed(feed)) return { ok: false, error: 'Вкажіть https-адресу теки з оновленнями або github:власник/репозиторій.', ...u.status() };
      base.cfg().updateFeed = feed;
      base.settingsStore.save();
      return { ok: true, ...u.status() };
    }
    case 'update:install': if (entry) entry.win.exec('updateInstall'); return u.status();
    case 'update:download': await u.download(); return u.status();
    case 'update:setAuto': base.cfg().autoUpdate = !!arg.on; base.settingsStore.save(); return { ok: true, ...u.status() };
    default: throw new Error('unknown');
  }
}

async function syncApi(ctx, entry, name, arg) {
  const S = ctx.sync;
  const { dialog } = require('electron');
  switch (name) {
    case 'sync:status': return S.status();
    case 'sync:pickFolder': {
      const r = await dialog.showOpenDialog(entry.win.win, { title: 'Папка синхронізації (наприклад, у OneDrive або Dropbox)', properties: ['openDirectory', 'createDirectory'] });
      return r.canceled ? null : r.filePaths[0];
    }
    case 'sync:enable':
      try { await S.enable(String(arg.folder || ''), String(arg.passphrase || '').slice(0, 256)); return { ok: true }; }
      catch (e) { return { ok: false, error: e.message }; }
    case 'sync:disable': S.disable(); return { ok: true };
    case 'sync:now': await S.syncNow(); return S.status();
    default: throw new Error('unknown');
  }
}

function registerIpc(resolve) {
  // Провайдер гаманця для сторінок (EIP-1193): синхронна ініціалізація та запити
  ipcMain.on('wallet:init', (e) => {
    let r = { enabled: false };
    try {
      const ctx = resolve(e.sender);
      const entry = ctx && ctx.entryFor(e.sender);
      const origin = entry && e.senderFrame === e.sender.mainFrame ? normOrigin(e.senderFrame.url) : null;
      if (entry && entry.tab && !entry.win.incognito && origin && ctx.wallet.injectEnabled()) r = { enabled: true, chainId: hexChain(ctx.wallet.chainOf(origin)) };
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
    homepage: 'string', searchEngine: 'string', startup: 'string', adblock: 'boolean',
    sendGpc: 'boolean', showBookmarksBar: 'boolean', askDownload: 'boolean', downloadDir: 'string',
    httpsFirst: 'boolean', stripTracking: 'boolean', sleepTabs: 'boolean', verticalTabs: 'boolean', savePasswords: 'boolean', safeBrowsing: 'boolean', theme: 'string', keywords: 'string', torrentConfirm: 'boolean',
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
    // Менеджер паролів і синхронізація доступні лише зі своїх сторінок
    const onPasswords = /^w3ir:\/\/passwords\/?$/.test(frame.url);
    const onImport = /^w3ir:\/\/import\/?$/.test(frame.url);
    const onWallet = /^w3ir:\/\/wallet\/?$/.test(frame.url);
    if (name.startsWith('vault:') && !(onPasswords || (onImport && (name === 'vault:status' || name === 'vault:importCsv')) || (onWallet && (name === 'vault:status' || name === 'vault:unlock')))) throw new Error('forbidden');
    if (name.startsWith('wallet:')) {
      if (!onWallet) throw new Error('forbidden');
      return walletApi(ctx, entry, name, arg);
    }
    if (name.startsWith('import:') && !onImport) throw new Error('forbidden');
    if (name.startsWith('sites:')) {
      if (!/^w3ir:\/\/settings\/?$/.test(frame.url)) throw new Error('forbidden');
      return sitesApi(ctx, name, arg);
    }
    if (name.startsWith('safe:')) {
      const onWarning = /^w3ir:\/\/warning\/?(\?.*)?$/.test(frame.url); // сторінка попередження відкривається з параметрами в адресі
      const onSettings = /^w3ir:\/\/settings\/?$/.test(frame.url);
      if (!(onWarning && (name === 'safe:proceed' || name === 'safe:trust')) && !(onSettings && (name === 'safe:status' || name === 'safe:update'))) throw new Error('forbidden');
      return safeApi(ctx, name, arg);
    }
    if (name.startsWith('update:')) {
      if (!/^w3ir:\/\/settings\/?$/.test(frame.url)) throw new Error('forbidden');
      return updateApi(ctx, name, arg, entry);
    }
    if (name.startsWith('profiles:')) {
      if (!/^w3ir:\/\/profiles\/?$/.test(frame.url)) throw new Error('forbidden');
      return profilesApi(ctx, entry, name, arg);
    }
    if (name.startsWith('import:')) return importApi(ctx, entry, name, arg);
    if ((name.startsWith('sync:') || name.startsWith('github:')) && !/^w3ir:\/\/settings\/?$/.test(frame.url)) throw new Error('forbidden');
    if (name.startsWith('github:')) return githubApi(ctx, name, arg);
    if (name.startsWith('agent:')) {
      if (!/^w3ir:\/\/settings\/?$/.test(frame.url)) throw new Error('forbidden');
      return agentApi(ctx, name, arg);
    }
    if (name.startsWith('vault:')) return vaultApi(ctx, entry, name, arg);
    if (name.startsWith('sync:')) return syncApi(ctx, entry, name, arg);
    switch (name) {
      case 'settings:get':
        return { settings: ctx.cfg(), engines: Object.fromEntries(Object.entries(ctx.ENGINES).map(([k, v]) => [k, v.name])), incognito: entry.win.incognito, theme: (ctx.manager ? ctx.manager.ctx('default') : ctx).cfg().theme, version: app.getVersion(), adblockEngine: !!ctx.blocker, extensions: ctx.extStore.data.items };
      case 'settings:set': {
        const cfg = ctx.cfg();
        for (const [k, v] of Object.entries(arg)) {
          if (!(k in SETTING_TYPES) || typeof v !== SETTING_TYPES[k]) continue;
          if (k === 'searchEngine' && !ctx.ENGINES[v]) continue;
          if (k === 'startup' && !['newtab', 'restore'].includes(v)) continue;
          if (k === 'theme') {
            if (!['system', 'light', 'dark'].includes(v)) continue;
            // тема спільна для всіх профілів: зберігаємо в основному й застосовуємо до всього застосунку
            const base = ctx.manager ? ctx.manager.ctx('default') : ctx;
            base.cfg().theme = v; base.settingsStore.save();
            require('electron').nativeTheme.themeSource = v;
            continue;
          }
          cfg[k] = k === 'keywords' ? v.slice(0, 4000) : v;
        }
        ctx.settingsStore.save();
        ctx.relayoutAll();
        return cfg;
      }
      case 'reader:get': return entry.tab.reader || null;
      case 'defaultbrowser': shell.openExternal('ms-settings:defaultapps'); return true;
      case 'ext:add': {
        const r = await dialog.showOpenDialog(entry.win.win, { title: 'Папка розпакованого розширення', properties: ['openDirectory'] });
        if (r.canceled || !r.filePaths[0]) return ctx.extStore.data.items;
        const dir = r.filePaths[0];
        if (!fs.existsSync(path.join(dir, 'manifest.json'))) throw new Error('У папці немає manifest.json');
        const ext = await ctx.session.extensions.loadExtension(dir, { allowFileAccess: true });
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
      case 'history:get': {
        const q = String(arg.query || '').toLowerCase();
        const out = [];
        const h = ctx.history();
        for (let i = h.length - 1; i >= 0 && out.length < 500; i--) {
          const x = h[i];
          if (!q || x.title.toLowerCase().includes(q) || x.url.toLowerCase().includes(q)) out.push(x);
        }
        return out;
      }
      case 'history:remove': {
        const h = ctx.history();
        const i = h.findIndex(x => x.id === arg.id);
        if (i >= 0) { h.splice(i, 1); ctx.historyStore.save(); }
        return true;
      }
      case 'history:clear': ctx.historyStore.data = []; ctx.historyStore.save(); return true;
      case 'bookmarks:get': return ctx.bookmarks();
      case 'bookmarks:remove': {
        ctx.bookmarkDelete(arg.url);
        return true;
      }
      case 'downloads:get': return ctx.downloads.list();
      case 'downloads:action': ctx.downloads.action(arg.id, arg.action); return true;
      case 'clear': {
        const ses = entry.win.ses;
        if (arg.history) { ctx.historyStore.data = []; ctx.historyStore.save(); }
        if (arg.cookies) await ses.clearStorageData();
        if (arg.cache) await ses.clearCache();
        return true;
      }
      default: throw new Error('unknown');
    }
  });
}

module.exports = { registerIpc };
