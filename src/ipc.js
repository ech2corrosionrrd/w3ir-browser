'use strict';
const { ipcMain, app, dialog, shell } = require('electron');
const { t: tr } = require('./i18n');
const { normOrigin } = require('./vault');
const { hexChain } = require('./wallet');
const { i18n, LANGS } = require('./i18n');

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
  'wallet:': { wallet: '*' },
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
  'reader:get': ['reader'], resolve: ['newtab'], topsites: ['newtab'],
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
  return only ? only.includes(page) : true; // невідомі команди відхилить сам перемикач нижче
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

async function walletApi(ctx, entry, name, arg) {
  const w = ctx.wallet;
  const v = ctx.vault;
  const authed = async () => v.recentlyAuthed() || (typeof arg.master === 'string' && v.status() === 'unlocked' && await v.reauth(arg.master.slice(0, 256)));
  try {
    switch (name) {
      case 'wallet:status': {
        const st = v.status();
        return { ok: true, vault: st, exists: w.exists(), inject: ctx.cfg().walletInject !== false, prices: ctx.cfg().walletPrices !== false, nftAnyHost: ctx.cfg().walletNftAnyHost === true, info: st === 'unlocked' && w.exists() ? w.info() : null };
      }
      case 'wallet:create': return { ok: true, phrase: w.create() };
      case 'wallet:import': w.importPhrase(arg.phrase, { passphrase: arg.passphrase, evmPath: arg.evmPath, solPath: arg.solPath }); return { ok: true };
      case 'wallet:previewImport': return { ok: true, ...w.previewDerivation(arg.phrase, { passphrase: arg.passphrase, evmPath: arg.evmPath, solPath: arg.solPath }) };
      case 'wallet:addAccount': return { ok: true, accounts: w.addAccount() };
      case 'wallet:reveal': if (!(await authed())) return { ok: false, needAuth: true, error: arg.master ? 'Хибний майстер-пароль.' : '' }; return { ok: true, passphrase: w.revealPassphrase(), phrase: w.reveal() };
      case 'wallet:remove': {
        if (!(await authed())) return { ok: false, needAuth: true, error: arg.master ? 'Хибний майстер-пароль.' : '' };
        const r = await dialog.showMessageBox(entry.win.win, {
          type: 'warning', buttons: [tr('Видалити гаманець'), tr('Скасувати')], defaultId: 1, cancelId: 1, message: tr('Видалити гаманець із цього пристрою?'),
          detail: tr('Без фрази відновлення доступ до коштів буде втрачено назавжди. Переконайтеся, що фразу збережено.'),
        });
        if (r.response !== 0) return { ok: false, error: '' };
        w.remove();
        return { ok: true };
      }
      case 'wallet:balances': return { ok: true, balances: await w.balances() };
      case 'wallet:evmTokens': return { ok: true, ...(await w.evmTokens(arg.index)) };
      case 'wallet:prices': return { ok: true, ...(await w.priceInfo({ chain: arg.chain === 'sol' ? 'sol' : 'evm', tokens: arg.tokens })) };
      case 'wallet:setPrices': ctx.cfg().walletPrices = !!arg.on; ctx.settingsStore.save(); return { ok: true };
      case 'wallet:nfts': return { ok: true, ...(await w.evmNfts(arg.index)) };
      case 'wallet:evmNftMeta': return { ok: true, ...(await w.evmNftMeta(String(arg.contract), String(arg.id))) };
      case 'wallet:addNft': return { ok: true, nft: await w.addNft(String(arg.contract), String(arg.id)) };
      case 'wallet:removeNft': return { ok: true, removed: w.removeNft(String(arg.contract), String(arg.id)) };
      case 'wallet:discoverNfts': return { ok: true, ...(await w.discoverNfts(arg.index)) };
      case 'wallet:sendNft': return { ok: true, hash: await w.sendNft(entry.win, () => entry.win.tabs.includes(entry.tab), { index: arg.index, contract: String(arg.contract), tokenId: String(arg.id), to: arg.to, amount: arg.amount === undefined ? undefined : String(arg.amount), speed: arg.speed }) };
      case 'wallet:addToken': return { ok: true, token: await w.addToken(String(arg.address)) };
      case 'wallet:removeToken': return { ok: true, removed: w.removeToken(String(arg.address)) };
      case 'wallet:solHistory': return { ok: true, ...(await w.solHistory(String(arg.address))) };
      case 'wallet:txStatuses': return { ok: true, statuses: await w.txStatuses(arg.items) };
      case 'wallet:pending': return { ok: true, items: await w.evmPending() };
      case 'wallet:replace': return { ok: true, hash: await w.replacePending(entry.win, () => entry.win.tabs.includes(entry.tab), { hash: String(arg.hash), mode: String(arg.mode) }) };
      case 'wallet:setPolicy': if (!(await authed())) return { ok: false, needAuth: true, error: arg.master ? 'Хибний майстер-пароль.' : '' }; return { ok: true, policy: w.setPolicy(arg.policy) };
      case 'wallet:portfolio': return { ok: true, ...(await w.portfolio({ force: !!arg.force })) };
      case 'wallet:scanApprovals': return { ok: true, ...(await w.scanApprovals(arg.index)) };
      case 'wallet:approvals': return { ok: true, ...(await w.listApprovals(arg.index)) };
      case 'wallet:revokeApproval': return { ok: true, hash: await w.revokeApproval(entry.win, () => entry.win.tabs.includes(entry.tab), { index: arg.index, kind: String(arg.kind), token: arg.token, spender: arg.spender }) };
      case 'wallet:backupQuiz': if (!(await authed())) return { ok: false, needAuth: true, error: arg.master ? 'Хибний майстер-пароль.' : '' }; return { ok: true, ...w.backupQuiz() };
      case 'wallet:backupCheck': return { ok: true, correct: w.backupCheck(arg.answers) };
      case 'wallet:backupExport': {
        if (!(await authed())) return { ok: false, needAuth: true, error: arg.master ? 'Хибний майстер-пароль.' : '' };
        const pw = String(arg.password || ''), pw2 = String(arg.password2 || '');
        if (pw !== pw2) return { ok: false, error: 'Паролі резервної копії не збігаються.' };
        const data = w.backupExport(pw); // перевіряє довжину пароля
        const stamp = new Date().toISOString().slice(0, 10);
        const r = await dialog.showSaveDialog(entry.win.win, { title: tr('Зберегти резервну копію гаманця'), defaultPath: `w3ir-wallet-backup-${stamp}.w3irbackup`, filters: [{ name: 'W3IR backup', extensions: ['w3irbackup'] }] });
        if (r.canceled || !r.filePath) return { ok: false, error: 'Збереження скасовано.' };
        require('fs').writeFileSync(r.filePath, data, { mode: 0o600 });
        return { ok: true, path: r.filePath };
      }
      case 'wallet:backupImport': {
        const r = await dialog.showOpenDialog(entry.win.win, { title: tr('Відновити гаманець із резервної копії'), properties: ['openFile'], filters: [{ name: 'W3IR backup', extensions: ['w3irbackup'] }] });
        if (r.canceled || !r.filePaths[0]) return { ok: false, error: 'Вибір скасовано.' };
        const fs = require('fs');
        if (fs.statSync(r.filePaths[0]).size > 1024 * 1024) return { ok: false, error: 'Файл завеликий для резервної копії.' };
        return { ok: true, ...w.backupImport(fs.readFileSync(r.filePaths[0]), String(arg.password || '')) };
      }
      case 'wallet:revoke': return { ok: true, hash: await w.revokeAllowance(entry.win, () => entry.win.tabs.includes(entry.tab), { index: arg.index, token: arg.token, spender: arg.spender }) };
      case 'wallet:contacts': return { ok: true, contacts: w.contacts() };
      case 'wallet:addContact': return { ok: true, contact: w.addContact(arg.name, arg.address) };
      case 'wallet:removeContact': return { ok: true, removed: w.removeContact(String(arg.address)) };
      case 'wallet:resolveName': return { ok: true, address: await w.resolveName(arg.name) };
      case 'wallet:importKey': return { ok: true, account: w.importKey(arg.key, arg.name) };
      case 'wallet:revealKey': if (!(await authed())) return { ok: false, needAuth: true, error: arg.master ? 'Хибний майстер-пароль.' : '' }; return { ok: true, key: w.revealKey(arg.id) };
      case 'wallet:removeImported': {
        if (!(await authed())) return { ok: false, needAuth: true, error: arg.master ? 'Хибний майстер-пароль.' : '' };
        const r = await dialog.showMessageBox(entry.win.win, {
          type: 'warning', buttons: [tr('Видалити рахунок'), tr('Скасувати')], defaultId: 1, cancelId: 1, message: tr('Видалити імпортований рахунок із гаманця?'),
          detail: tr('Приватний ключ буде стерто з цього пристрою. Без окремої резервної копії ключа доступ до коштів на цьому рахунку буде втрачено назавжди.'),
        });
        if (r.response !== 0) return { ok: false, error: '' };
        return { ok: true, removed: w.removeImported(arg.id) };
      }
      case 'wallet:addWatch': return { ok: true, account: w.addWatch(arg.address, arg.name) };
      case 'wallet:removeWatch': return { ok: true, removed: w.removeWatch(arg.id) };
      case 'wallet:qr': return { ok: true, qr: w.qrFor(arg.text) };
      case 'wallet:setDappAccount': return { ok: true, index: w.setDappAccount(String(arg.chain), arg.index) };
      case 'wallet:setSiteAccount': return { ok: true, address: w.setSiteAccount(arg.origin, String(arg.chain), arg.index) };
      case 'wallet:rename': return { ok: true, name: w.rename(arg.index, arg.name) };
      case 'wallet:send': {
        const sameTab = () => entry.win.tabs.includes(entry.tab);
        if (arg.chain === 'sol') {
          const hash = arg.asset ? await w.solSendToken(entry.win, sameTab, { index: arg.index, mint: arg.asset, to: arg.to, amount: arg.amount, speed: arg.speed }) : await w.solSend(entry.win, sameTab, { index: arg.index, to: arg.to, amount: arg.amount, speed: arg.speed });
          return { ok: true, hash, chain: 'sol' };
        }
        if (arg.chain === 'evm') {
          const hash = arg.asset ? await w.sendToken(entry.win, sameTab, { index: arg.index, token: arg.asset, to: arg.to, amount: arg.amount, speed: arg.speed }) : await w.sendNative(entry.win, sameTab, { index: arg.index, to: arg.to, amount: arg.amount, speed: arg.speed });
          return { ok: true, hash, chain: 'evm' };
        }
        throw new Error('unknown');
      }
      case 'wallet:solNfts': return { ok: true, ...(await w.solNfts(String(arg.address), { offset: arg.offset, limit: arg.limit })) };
      case 'wallet:solNftMeta': return { ok: true, ...(await w.solNftMeta(String(arg.address), String(arg.mint))) };
      case 'wallet:setNftAnyHost': ctx.cfg().walletNftAnyHost = !!arg.on; ctx.settingsStore.save(); return { ok: true };
      case 'wallet:solTokens': return { ok: true, ...(await w.solTokens(String(arg.address))) };
      case 'wallet:solBalances': return { ok: true, balances: await w.solBalances() };
      case 'wallet:solSetCluster': w.setSolCluster(String(arg.id)); return { ok: true };
      case 'wallet:solSetRpc': w.setSolRpc(String(arg.cluster), arg.url); return { ok: true };
      case 'wallet:setChain': w.setChain(Number(arg.id)); return { ok: true };
      case 'wallet:setRpc': w.setRpc(Number(arg.id), arg.url); return { ok: true };
      case 'wallet:disconnect': w.disconnectSite(String(arg.origin)); return { ok: true };
      case 'wallet:setInject': ctx.cfg().walletInject = !!arg.on; ctx.settingsStore.save(); return { ok: true };
      default: throw new Error('unknown');
    }
  } catch (e) { return { ok: false, error: e.code === 4100 ? 'Спершу розблокуйте сховище паролів.' : e.message }; }
}

async function arweaveApi(ctx, name, arg) {
  const ar = ctx.arweave;
  try {
    switch (name) {
      case 'arweave:status':
        return { ok: true, gateways: ar.DEFAULT_GATEWAYS };
      case 'arweave:resolve': {
        const input = String(arg.url || arg.txId || '').trim();
        let txId = input;
        let pathname = '';
        if (input.startsWith('ar://')) {
          const parsed = ar.parseArweaveUrl(input);
          if (!parsed) return { ok: false, error: 'Недійсний формат посилання ar://' };
          txId = parsed.txId;
          pathname = parsed.pathname + parsed.search;
        }
        if (!ar.isValidTxId(txId)) return { ok: false, error: 'Недійсний хеш транзакції Arweave (має бути 43 символи base64url).' };
        return {
          ok: true,
          txId,
          arweaveUrl: ar.formatArweaveUrl(txId, pathname),
          gatewayUrl: ar.resolveGatewayUrl(txId, pathname, 0)
        };
      }
      case 'arweave:nft': {
        const input = String(arg.txId || arg.url || '').trim();
        const txId = input.startsWith('ar://') ? (ar.parseArweaveUrl(input)?.txId || '') : input;
        if (!ar.isValidTxId(txId)) return { ok: false, error: 'Недійсний хеш транзакції Arweave.' };
        const metadata = await ar.fetchMetadata(txId);
        return { ok: true, metadata };
      }
      case 'arweave:tags': {
        const input = String(arg.txId || arg.url || '').trim();
        const txId = input.startsWith('ar://') ? (ar.parseArweaveUrl(input)?.txId || '') : input;
        if (!ar.isValidTxId(txId)) return { ok: false, error: 'Недійсний хеш транзакції Arweave.' };
        const tags = await ar.fetchTags(txId);
        return { ok: true, tags };
      }
      default: throw new Error('unknown');
    }
  } catch (e) {
    return { ok: false, error: e.message || 'Помилка звернення до Arweave' };
  }
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
      const r = await dialog.showOpenDialog(entry.win.win, { title: tr('Папка синхронізації (наприклад, у OneDrive або Dropbox)'), properties: ['openDirectory', 'createDirectory'] });
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
    homepage: 'string', searchEngine: 'string', startup: 'string', adblock: 'boolean',
    sendGpc: 'boolean', showBookmarksBar: 'boolean', askDownload: 'boolean', downloadDir: 'string',
    httpsFirst: 'boolean', stripTracking: 'boolean', sleepTabs: 'boolean', verticalTabs: 'boolean', savePasswords: 'boolean', safeBrowsing: 'boolean', theme: 'string', language: 'string', keywords: 'string', torrentConfirm: 'boolean',
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
      case 'history:get': return ctx.places.visits({ query: arg && arg.query, limit: 500 });
      case 'history:remove': ctx.places.removeVisit(arg && arg.id); return true;
      case 'history:clear': ctx.places.clear(); return true;
      case 'bookmarks:get': return ctx.bookmarks();
      case 'bookmarks:remove': {
        ctx.bookmarkDelete(arg.url);
        return true;
      }
      case 'downloads:get': return ctx.downloads.list();
      case 'downloads:action': ctx.downloads.action(arg.id, arg.action); return true;
      case 'clear': {
        const ses = entry.win.ses;
        if (arg.history) ctx.places.clear();
        if (arg.cookies) await ses.clearStorageData();
        if (arg.cache) await ses.clearCache();
        return true;
      }
      default: throw new Error('unknown');
    }
  });
}

module.exports = { registerIpc, permitted };
