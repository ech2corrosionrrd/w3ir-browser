'use strict';
/**
 * W3IR Browser — Glance / Peek Preview
 * 
 * Плаваючий швидкий перегляд посилань (Alt+Клік або контекстне меню)
 * поверх сторінки без створення постійної вкладки.
 */

const { WebContentsView } = require('electron');
const { t: tr } = require('./i18n');

const ALLOWED_SCHEMES = /^(https?:|ar:\/\/|ipfs:\/\/|ipns:\/\/)/i;

const methods = {
  openGlance(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return false;
    const url = rawUrl.trim();
    if (!ALLOWED_SCHEMES.test(url)) {
      this.toast(tr('Недопустима адреса для швидкого перегляду'));
      return false;
    }
    // Закриваємо попередній Glance, якщо він відкритий
    if (this.glanceView) this.closeGlance();

    const [w, h] = this.win.getContentSize();
    const topBar = this.chromeHeight || 72;
    const availH = Math.max(300, h - topBar);
    const width = Math.min(1040, Math.max(480, Math.round(w * 0.82)));
    const height = Math.min(740, Math.max(320, Math.round(availH * 0.82)));
    const x = Math.round((w - width) / 2);
    const y = topBar + Math.round((availH - height) / 2);

    this.glanceUrl = url;
    const ses = this.active() ? this.tabSes(this.active()) : this.win.webContents.session;

    this.glanceView = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        session: ses,
        // Без preload: у вікні швидкого перегляду немає ні мосту гаманця (window.ethereum тощо), ні IPC браузера
      },
    });

    this.glanceView.setBounds({ x, y, width, height });
    this.win.contentView.addChildView(this.glanceView);

    const wc = this.glanceView.webContents;
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      if (input.key === 'Escape') this.closeGlance();
      else if (input.key === 'Enter' && (input.control || input.meta)) { e.preventDefault(); this.glanceToTab(); }
    });

    const guard = (e, navUrl) => { if (!ALLOWED_SCHEMES.test(navUrl)) e.preventDefault(); };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    // Нові вікна з Glance не створюються: посилання відкривається в тому ж перегляді
    wc.setWindowOpenHandler(({ url }) => {
      if (ALLOWED_SCHEMES.test(url)) setImmediate(() => { if (this.glanceView) wc.loadURL(url).catch(() => {}); });
      return { action: 'deny' };
    });
    wc.on('did-navigate', (_e, navUrl) => { this.glanceUrl = navUrl; });

    wc.loadURL(url).catch(() => {});
    wc.focus();
    return true;
  },

  closeGlance() {
    if (!this.glanceView) return;
    try {
      this.win.contentView.removeChildView(this.glanceView);
      if (!this.glanceView.webContents.isDestroyed()) {
        this.glanceView.webContents.close();
      }
    } catch { /* ignore */ }
    this.glanceView = null;
    this.glanceUrl = null;
    const act = this.active();
    if (act && act.view && !act.view.webContents.isDestroyed()) {
      act.view.webContents.focus();
    }
  },

  glanceToTab() {
    if (!this.glanceUrl) return;
    const u = this.glanceUrl;
    this.closeGlance();
    this.createTab(u, { activate: true });
  },
};

module.exports = { methods };
