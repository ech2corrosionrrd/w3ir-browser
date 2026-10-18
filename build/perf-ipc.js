'use strict';
// Вимірювання вартості синхронного IPC (`ipcRenderer.sendSync`), яким сторінки отримують `wallet:init`.
// Запуск як головного процесу Electron: electron build/perf-ipc.js (його викликає build/perf.js).
// Обробник тут порожній: міряється саме канал, а не логіка гаманця (вона O(1), див. src/ipc.js).
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'w3ir-perf-ipc-')));
ipcMain.on('perf:sync', (e) => { e.returnValue = { enabled: true, chainId: '0x1' }; });

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  await win.loadURL('data:text/html,<title>perf</title>');
  const r = await win.webContents.executeJavaScript(`(() => {
    const { ipcRenderer } = require('electron');
    for (let i = 0; i < 200; i++) ipcRenderer.sendSync('perf:sync');
    const N = 2000, t = [];
    for (let i = 0; i < N; i++) { const s = performance.now(); ipcRenderer.sendSync('perf:sync'); t.push(performance.now() - s); }
    t.sort((a, b) => a - b);
    const r = (x) => +x.toFixed(3); return { n: N, p50: r(t[N >> 1]), p95: r(t[Math.floor(N * 0.95)]), max: r(t[N - 1]) };
  })()`);
  console.log(JSON.stringify(r));
  app.exit(0);
});
