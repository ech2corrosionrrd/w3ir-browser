'use strict';
const { app, protocol, Menu, BrowserWindow, powerMonitor, nativeTheme } = require('electron');
const { t: tr } = require('./src/i18n');
const path = require('path');

app.enableSandbox(); // усі рендерери — в пісочниці

// Встановлена збірка не запускається з параметрами налагодження (відкритий порт керування сторінками): див. src/launch-guard.js
if (require('./src/launch-guard').shouldBlock({ argv: process.argv, packaged: app.isPackaged, env: process.env })) {
  if (!process.env.W3IR_NO_DIALOG) try { require('electron').dialog.showErrorBox('W3IR Browser', 'Запуск із параметрами налагодження (--remote-debugging-port, --inspect тощо) заблоковано з міркувань безпеки.\nДля тестування встановіть змінну середовища W3IR_ALLOW_DEBUG=1.'); } catch { /* ignore */ }
  app.exit(2);
  return;
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'w3ir', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// Лише для розробки/тестів: окрема тека даних (ізоляція від встановленої копії та власне блокування одного екземпляра)
if (!app.isPackaged && process.env.W3IR_USER_DATA) app.setPath('userData', process.env.W3IR_USER_DATA);

if (!app.requestSingleInstanceLock()) { app.quit(); return; }

const { ProfileManager } = require('./src/profiles');
const { registerIpc } = require('./src/ipc');
const { flushAll } = require('./src/store');
const { initBlocker } = require('./src/adblock');
const { Updater, installerIsRunning } = require('./src/updater');

let manager;
let ctx; // основний профіль

const urlsFromArgv = (argv) => argv.filter(a => /^https?:\/\//i.test(a));

app.on('second-instance', (e, argv) => {
  if (!manager) return;
  const urls = urlsFromArgv(argv);
  // Посилання з інших програм відкриваються в основному профілі
  if (urls.length) manager.open('default', { urls });
  else {
    const w = [...ctx.windows].pop();
    if (w) { if (w.win.isMinimized()) w.win.restore(); w.win.focus(); } else manager.launch('default');
  }
});

app.on('before-quit', () => {
  if (manager) for (const c of manager.all()) { c.vault.lock(); c.saveSession(); c.quitting = true; }
  flushAll();
});
app.on('will-quit', flushAll);
app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  app.setAppUserModelId('com.w3ir.browser');
  // Не запускаємося, поки триває встановлення оновлення (інакше браузер і інсталятор заважатимуть одне одному)
  if (app.isPackaged && await installerIsRunning()) {
    const f = path.join(app.getPath('userData'), 'update-attempt.json');
    let to = '';
    try { to = JSON.parse(require('fs').readFileSync(f, 'utf8')).to; } catch { /* немає спроби */ }
    if (to && to !== app.getVersion()) {
      require('electron').dialog.showMessageBoxSync({ type: 'info', buttons: ['OK'], message: tr('Триває встановлення оновлення'), detail: tr('Зачекайте приблизно 30 секунд — браузер запуститься сам після завершення.') });
      app.exit(0);
      return;
    }
  }
  manager = new ProfileManager();
  ctx = manager.ctx('default');
  // W3IR_LANG (uk|en|…) перекриває мову — для тестів; у режимі автотестів завжди українська (рядки тестів українські)
  require('./src/i18n').i18n.setLang(process.env.W3IR_LANG || (process.env.W3IR_SMOKE === 'security' ? 'uk' : ctx.cfg().language), app.getLocale());
  nativeTheme.themeSource = ['system', 'light', 'dark'].includes(ctx.cfg().theme) ? ctx.cfg().theme : 'system';
  // Автооновлення (спільне для всіх профілів; налаштування беруться з основного)
  manager.updater = new Updater({
    getCfg: () => ctx.cfg(),
    publicKey: require('./src/update-key'),
    onChange: () => manager.all().forEach(c => c.pushAll()),
    onReady: (v) => manager.all().forEach(c => c.windows.forEach(w => w.toast(`Оновлення ${v} готове й перевірене — натисніть ⬆ у панелі, щоб встановити`))),
    logFile: path.join(app.getPath('userData'), 'updater.log'),
  });
  registerIpc((wc) => manager.ctxOf(wc));
  // Сховища паролів блокуються при блокуванні екрана та сні комп'ютера
  for (const ev of ['lock-screen', 'suspend']) powerMonitor.on(ev, () => manager.all().forEach(c => c.vault.lock()));

  manager.launch('default', urlsFromArgv(process.argv));
  manager.updater.start();
  setTimeout(() => manager.updater.afterStart({
    toast: (t) => { const w = [...ctx.windows].pop(); if (w) w.toast(t); },
    parent: [...ctx.windows].pop() && [...ctx.windows].pop().win,
  }), 4000);
  ctx.threats.start();

  // Розширення Chrome (експериментально) та розумний блокувальник — у фоні, щоб не гальмувати запуск.
  for (const item of ctx.extStore.data.items) {
    ctx.session.extensions.loadExtension(item.path, { allowFileAccess: true })
      .catch(e => console.error('Extension failed', item.path, e.message));
  }
  initBlocker(ctx).then(() => manager.all().forEach(c => c.pushAll())).catch(e => console.error('Adblock engine unavailable, using built-in list:', e.message));

  if (!app.isPackaged && process.env.W3IR_SMOKE) require(process.env.W3IR_SMOKE === 'security' ? './test/security' : process.env.W3IR_SMOKE === 'shots' ? './test/ui-shots' : './test/smoke')(ctx);

  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) manager.launch('default'); });
});
