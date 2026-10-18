'use strict';
// Блокувальник на рушії Ghostery (списки EasyList / EasyPrivacy / uBlock) з косметичною фільтрацією.
const fs = require('fs');
const path = require('path');
const { app, ipcMain, utilityProcess } = require('electron');

const MAX_AGE = 7 * 864e5;
const BUILD_TIMEOUT = 120000;

// Будує кеш рушія в окремому процесі (src/adblock-build.js), щоб ≈160 МБ пам'яті побудови не лишалися в головному процесі.
// Повертає true, якщо файл записано; false (без винятків) при будь-якій невдачі, тоді initBlocker будує рушій сам.
function buildCacheInChild(file) {
  return new Promise((resolve) => {
    let child, done = false;
    const finish = (ok) => { if (done) return; done = true; clearTimeout(timer); try { child && child.kill(); } catch { /* уже завершився */ } resolve(ok); };
    const timer = setTimeout(() => finish(false), BUILD_TIMEOUT);
    try {
      child = utilityProcess.fork(path.join(__dirname, 'adblock-build.js'), [], { serviceName: 'W3IR adblock build', env: { ...process.env, W3IR_ADBLOCK_OUT: file } });
      child.on('message', (m) => finish(!!(m && m.ok)));
      child.on('exit', () => finish(false));
    } catch { finish(false); }
  });
}

async function initBlocker(ctx) {
  const { ElectronBlocker } = require('@ghostery/adblocker-electron');
  const PRELOAD_PATH = require.resolve('@ghostery/adblocker-electron-preload');
  const file = path.join(app.getPath('userData'), 'adblock-engine.bin');

  let stale = false, exists = false;
  try { exists = true; stale = Date.now() - fs.statSync(file).mtimeMs > MAX_AGE; } catch { exists = false; }
  // немає кешу або він старший за 7 діб: будуємо в окремому процесі й далі лише завантажуємо готовий файл
  if ((stale || !exists) && await buildCacheInChild(file)) { stale = false; exists = true; }

  let blocker;
  const cache = { path: file, read: fs.promises.readFile, write: fs.promises.writeFile };
  try {
    blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, stale ? undefined : cache);
    if (stale) await fs.promises.writeFile(file, blocker.serialize());
  } catch (e) {
    if (!exists) throw e;
    blocker = ElectronBlocker.deserialize(await fs.promises.readFile(file));
  }

  ctx.blocker = blocker;
  ctx.blockerPreload = PRELOAD_PATH;

  const cfgFor = (e) => ((ctx.manager && ctx.manager.ctxOf(e.sender)) || ctx).cfg();
  ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', (e, url, msg) => {
    const c = (ctx.manager && ctx.manager.ctxOf(e.sender)) || ctx;
    if (!cfgFor(e).adblock || !/^https?:/i.test(url || '') || c.adblockAllowed(c.topHost(e.sender.id))) return;
    return blocker.onInjectCosmeticFilters(e, url, msg);
  });
  ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', (e) => cfgFor(e).adblock && blocker.config.enableMutationObserver);

  for (const ses of ctx.sessions) attachCosmetic(ctx, ses);
  return blocker;
}

function attachCosmetic(ctx, ses) {
  if (!ctx.blocker || ses.__w3irCosmetic) return;
  ses.__w3irCosmetic = true;
  ses.registerPreloadScript({ type: 'frame', filePath: ctx.blockerPreload });
}

module.exports = { initBlocker, attachCosmetic };
