'use strict';
// Знімки нових екранів: W3IR_SMOKE=shots W3IR_OUT=<папка> npx electron .
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');
const { Vault } = require('../src/vault');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = async function (ctx) {
  const out = process.env.W3IR_OUT || __dirname;
  fs.mkdirSync(out, { recursive: true });
  const shot = async (name, wc) => fs.writeFileSync(path.join(out, name + '.png'), (await wc.capturePage()).toPNG());
  const w = [...ctx.windows][0];
  await sleep(2500);
  ctx.vault = new Vault({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'w3ir-shot-')), onChange: () => ctx.pushAll() });

  w.exec('openPage', 'passwords');
  await sleep(1200);
  await shot('pw-create', w.wc());
  await ctx.vault.create('Screenshot-Master-77!');
  ctx.vault.add({ url: 'https://github.com', username: 'octocat', password: 'x1y2z3-secret' });
  ctx.vault.add({ url: 'https://mail.example.org', username: 'me@example.org', password: 'another-secret-9' });
  w.exec('openPage', 'settings'); w.exec('openPage', 'passwords');
  await w.wc().executeJavaScript('location.reload()');
  await sleep(1200);
  await shot('pw-list', w.wc());

  w.exec('newTab');
  w.exec('go', 'https://github.com/login');
  await sleep(4000);
  w.exec('vaultMenu', 80);
  await sleep(600);
  await shot('vault-overlay', w.overlay.webContents);
  w.exec('closeOverlay');

  w.chrome.send('savebar', { kind: 'new', host: 'github.com', username: 'octocat', needs: null });
  await sleep(500);
  await shot('savebar-chrome', w.chrome);

  w.exec('openPage', 'settings');
  await sleep(1200);
  await w.wc().executeJavaScript('window.scrollTo(0, 1100)');
  await sleep(300);
  await shot('settings-sync', w.wc());
  app.quit();
};
