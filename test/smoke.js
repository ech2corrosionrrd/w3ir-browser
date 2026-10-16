'use strict';
// Дим-тест: W3IR_SMOKE=1 W3IR_OUT=<папка> npx electron .
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = async function smoke(ctx) {
  const out = process.env.W3IR_OUT || __dirname;
  fs.mkdirSync(out, { recursive: true });
  const log = (...a) => console.log('[smoke]', ...a);
  const shot = async (name, wc) => {
    const img = await wc.capturePage();
    fs.writeFileSync(path.join(out, name + '.png'), img.toPNG());
  };
  try {
    await sleep(2500);
    const w = [...ctx.windows][0];
    log('tabs', w.tabs.length, 'chromeHeight', w.chromeHeight);

    // блокувальник: чекаємо на завантаження рушія
    for (let i = 0; i < 40 && !ctx.blocker; i++) await sleep(500);
    log('adblock engine loaded:', !!ctx.blocker);

    // HTTPS-first + прибирання трекінгових параметрів
    w.exec('newTab');
    w.exec('go', 'http://example.com/?utm_source=x&keep=1&fbclid=abc');
    await sleep(4000);
    log('https+strip ->', w.tabUrl(w.active()));

    // блокування реклами на реальному сайті
    w.exec('go', 'https://edition.cnn.com');
    await sleep(9000);
    log('cnn title:', w.wc().getTitle(), 'blocked:', w.active().blocked);

    // режим читання
    w.exec('go', 'https://en.wikipedia.org/wiki/Web_browser');
    await sleep(5000);
    await w.openReader();
    await sleep(1500);
    log('reader url:', w.wc().getURL(), 'title:', w.wc().getTitle());
    await shot('reader', w.wc());

    // закріплена вкладка + вертикальний режим + палітра
    w.exec('pinTab', w.activeId);
    w.exec('newTab');
    w.exec('go', 'https://example.org');
    await sleep(2500);
    w.exec('newTab');
    w.exec('go', 'https://example.com');
    await sleep(3000);
    log('pinned first:', w.tabs[0].pinned, 'tabs:', w.tabs.length);
    ctx.cfg().verticalTabs = true;
    ctx.relayoutAll();
    await sleep(800);
    await shot('vertical-chrome', w.chrome);
    log('page bounds x:', w.active().view.getBounds().x);
    w.exec('palette', 'all');
    await sleep(600);
    await shot('palette', w.overlay.webContents);
    w.exec('closeOverlay');
    ctx.cfg().verticalTabs = false;
    ctx.relayoutAll();

    // сплячі вкладки
    const bg = w.tabs.find(t => t.id !== w.activeId && /^https?:/.test(w.tabUrl(t)));
    if (bg) {
      const ok = w.sleepTab(bg);
      await sleep(500);
      log('slept:', ok, 'url kept:', w.tabUrl(bg), 'wc url:', bg.view.webContents.getURL());
      w.switchTab(bg.id);
      await sleep(3500);
      log('woke ->', bg.view.webContents.getURL(), 'sleep flag:', !!bg.sleep);
    }

    // меню і підказки
    w.exec('menu', 80);
    await sleep(500);
    await shot('overlay-menu', w.overlay.webContents);
    w.exec('closeOverlay');
    await shot('chrome', w.chrome);

    // інкогніто
    const before = ctx.history().length;
    const inc = ctx.openWindow({ incognito: true });
    await sleep(2500);
    inc.exec('go', 'https://example.org');
    await sleep(3000);
    log('incognito history unchanged:', before === ctx.history().length);
    inc.win.close();
    await sleep(500);
    log('DONE');
  } catch (e) {
    log('ERROR', e && e.stack || e);
  }
  app.quit();
};
