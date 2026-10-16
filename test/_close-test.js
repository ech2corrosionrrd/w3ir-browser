'use strict';
const { app } = require('electron');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
module.exports = async function (ctx) {
  const w = [...ctx.windows][0];
  w.win.setSize(1300, 800); await sleep(2500);
  const log = (m) => console.log('[close]', m);
  const slowClick = async (x, y, hold) => { w.chrome.sendInputEvent({ type: 'mouseMove', x, y }); w.chrome.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); await sleep(hold); w.chrome.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }); await sleep(500); };
  const rect = (sel) => w.chrome.executeJavaScript(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  for (const u of ['https://example.com', 'https://example.org', 'https://example.net', 'w3ir://history']) w.createTab(u, { activate: false });
  await sleep(2500);
  for (const hold of [10, 120, 250]) {
    let n = w.tabs.length, r = await rect('.tab:last-of-type .close');
    await slowClick(r.x, r.y, hold); log(`хрестик НЕАКТИВНОЇ вкладки, утримання ${hold} мс: ${n} -> ${w.tabs.length}`);
    n = w.tabs.length; r = await rect('.tab.active .close');
    await slowClick(r.x, r.y, hold); log(`хрестик АКТИВНОЇ вкладки, утримання ${hold} мс: ${n} -> ${w.tabs.length}`);
  }
  app.quit();
};
