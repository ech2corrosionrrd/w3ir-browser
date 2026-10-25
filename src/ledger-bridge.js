'use strict';
// Міст до Ledger: прихований службовий BrowserWindow із сторінкою w3ir://ledger (WebHID). Головний процес викликає
// window.ledgerIo.* через executeJavaScript; протокол кадрів і APDU — у src/ledger.js (тестується без пристрою).
const { BrowserWindow } = require('electron');
const { Transport, EthApp, LedgerError } = require('./ledger');

const LEDGER_VENDOR = 0x2c97;
const HELPER_ORIGIN = 'w3ir://ledger';

// Дозвіл WebHID: лише службова сторінка й лише пристрої Ledger
const isHelperOrigin = (origin) => typeof origin === 'string' && origin.replace(/\/$/, '') === HELPER_ORIGIN;
function allowDevice(details) {
  return !!details && details.deviceType === 'hid' && isHelperOrigin(details.origin) && !!details.device && details.device.vendorId === LEDGER_VENDOR;
}

class LedgerBridge {
  constructor(ctx) {
    this.ctx = ctx;
    this.win = null;
    this.loading = null;
    this.transport = new Transport({
      begin: () => this.run('window.ledgerIo.reset()'),
      write: (buf) => this.run(`window.ledgerIo.write(${JSON.stringify(buf.toString('hex'))})`),
      read: async () => Buffer.from(await this.run('window.ledgerIo.read()'), 'hex'),
    });
    this.eth = new EthApp(this.transport);
  }

  app() { return this.eth; }

  async page() {
    if (this.win && !this.win.isDestroyed()) { await this.loading; return this.win.webContents; }
    const win = new BrowserWindow({
      show: false, width: 320, height: 200, skipTaskbar: true,
      webPreferences: { session: this.ctx.session, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.on('closed', () => { if (this.win === win) this.win = null; });
    this.win = win;
    this.loading = win.loadURL(HELPER_ORIGIN + '/');
    await this.loading;
    return win.webContents;
  }

  async run(code) {
    try {
      const wc = await this.page();
      return await wc.executeJavaScript(code);
    } catch (e) {
      if (e instanceof LedgerError) throw e;
      throw new LedgerError(String((e && e.message) || e).replace(/^Error invoking remote method.*?: (Error: )?/, ''));
    }
  }

  close() { if (this.win && !this.win.isDestroyed()) this.win.destroy(); this.win = null; }
}

module.exports = { LedgerBridge, allowDevice, isHelperOrigin, HELPER_ORIGIN };
