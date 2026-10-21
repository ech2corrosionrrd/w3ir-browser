'use strict';
// Менеджер паролів і довірене вікно підтвердження дій гаманця (методи змішуються в прототип AppWindow).
const { normOrigin } = require('./vault');

const methods = {
  // ---------- менеджер паролів ----------
  vaultState(curUrl) {
    const v = this.ctx.vault;
    const origin = normOrigin(curUrl);
    const st = v.status();
    return { status: st, count: st === 'unlocked' && origin ? v.count(origin) : 0, canFill: !!origin };
  },

  vaultPanel() {
    const v = this.ctx.vault;
    const t = this.active();
    const url = t ? this.tabUrl(t) : '';
    const origin = normOrigin(url);
    const st = v.status();
    let host = '';
    try { host = new URL(url).host; } catch {}
    return {
      status: st, host, canFill: !!origin, secureOnly: !origin && /^http:/.test(url),
      entries: st === 'unlocked' && origin ? v.list(origin).map(e => ({ id: e.id, username: e.username })) : [],
    };
  },

  refreshVaultOverlay() {
    if (this.overlayType === 'vault') this.overlay.webContents.send('overlay', { type: 'vault', ...this.vaultPanel() });
  },

  async vaultUnlock(master) {
    const r = await this.ctx.vault.unlock(String(master || '').slice(0, 256));
    if (r.ok) { this.refreshVaultOverlay(); this.ctx.flushPending(); }
    return r;
  },

  vaultFill(id) {
    const t = this.active();
    if (!t || t.sleep) return;
    let e;
    try { e = this.ctx.vault.get(id); } catch { return; }
    const origin = normOrigin(this.tabUrl(t));
    if (!e || !origin || origin !== e.origin) { this.toast('Адреса сторінки не збігається із записом — заповнення скасовано'); return; }
    t.view.webContents.send('vault:fill', { origin, username: e.username, password: e.password });
    this.closeOverlay();
  },

  offerSave(tab, { username, password }, frameUrl) {
    const ctx = this.ctx;
    if (!ctx.cfg().savePasswords || this.incognito) return;
    const origin = normOrigin(frameUrl);
    if (!origin || origin !== normOrigin(this.tabUrl(tab))) return;
    const v = ctx.vault;
    const st = v.status();
    let kind = 'new';
    if (st === 'unlocked') {
      if (v.isNever(origin)) return;
      const ex = v.find(origin, username);
      if (ex && ex.password === password) return;
      if (ex) kind = 'update';
    }
    let host = origin;
    try { host = new URL(origin).host; } catch {}
    clearTimeout(this.pendingTimer);
    this.pendingSave = { origin, host, username, password, kind, confirmed: false };
    this.pendingTimer = setTimeout(() => this.clearPending(), 5 * 60 * 1000);
    this.chrome.send('savebar', { kind, host, username, needs: st === 'none' ? 'create' : st === 'locked' ? 'unlock' : null });
  },

  clearPending() {
    clearTimeout(this.pendingTimer);
    this.pendingSave = null;
    if (!this.win.isDestroyed()) this.chrome.send('savebar', null);
  },

  // Користувач підтвердив збереження (можливо, ще до розблокування сховища)
  flushPending() {
    const p = this.pendingSave;
    const v = this.ctx.vault;
    if (!p || !p.confirmed || v.status() !== 'unlocked') return;
    try {
      v.add({ url: p.origin, username: p.username, password: p.password });
      this.toast('Пароль збережено');
    } catch (e) { this.toast(e.message); }
    this.clearPending();
  },

  saveAnswer(action) {
    const p = this.pendingSave;
    if (!p) return;
    const v = this.ctx.vault;
    if (action === 'dismiss') return this.clearPending();
    if (action === 'never') {
      if (v.status() === 'unlocked') { try { v.addNever(p.origin); } catch {} }
      return this.clearPending();
    }
    if (action === 'save') {
      p.confirmed = true;
      const st = v.status();
      if (st === 'unlocked') this.flushPending();
      else if (st === 'none') this.createTab('w3ir://passwords');
      else {
        const [w, h] = this.win.getContentSize();
        this.chrome.send('savebar', null);
        this.openOverlay('vault', this.vaultPanel(), { x: 0, y: this.chromeHeight, width: w, height: h - this.chromeHeight });
      }
    }
  },

  // ---------- підтвердження дій гаманця (довіреним вікном, яке сторінка не може підробити) ----------
  requestApproval(spec) {
    return new Promise((resolve) => {
      if (this.approvalQueue.length >= 5) { resolve({ approved: false }); return; }
      this.approvalQueue.push({ id: require('crypto').randomUUID(), spec, resolve, timer: null });
      this.showNextApproval();
    });
  },

  showNextApproval() {
    if (this.approval || !this.approvalQueue.length || this.win.isDestroyed()) return;
    const item = this.approvalQueue.shift();
    this.approval = item;
    item.timer = setTimeout(() => this.finishApproval(false), 120000);
    // пауза перед підтвердженням (великі суми): кнопка «Підтвердити» недоступна, а рішення раніше строку відхиляється й тут
    const delay = Number(item.spec.delay);
    item.notBefore = Number.isFinite(delay) && delay > 0 ? Date.now() + Math.min(delay, 30) * 1000 : 0;
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.openOverlay('approve', this.approvalPayload(item), {});
    this.push();
  },

  approvalPayload(item) {
    const v = this.ctx.vault;
    const st = v.status();
    if (item.spec.agent) return { id: item.id, ...item.spec, needsUnlock: false, needsAuth: false }; // підтвердження сайту для ШІ не потребує майстер-пароля
    return { id: item.id, ...item.spec, needsUnlock: st !== 'unlocked', needsAuth: st === 'unlocked' && !v.recentlyAuthed(this.ctx.wallet.reauthMs()) };
  },

  finishApproval(approved, choice, choice2) {
    const item = this.approval;
    if (!item) return;
    clearTimeout(item.timer);
    this.approval = null;
    if (this.overlayType === 'approve') { this.overlayType = null; try { this.win.contentView.removeChildView(this.overlay); } catch {} }
    item.resolve({ approved, ...(choice !== undefined ? { choice } : {}), ...(choice2 !== undefined ? { choice2 } : {}) });
    this.push();
    this.showNextApproval();
  },

  async decide(id, approve, master, choice, choice2) {
    const item = this.approval;
    if (!item || item.id !== id) return { ok: false, error: 'Запит застарів.' };
    if (!approve) { this.finishApproval(false); return { ok: true }; }
    if (item.notBefore && Date.now() < item.notBefore) return { ok: false, error: `Зачекайте ще ${Math.ceil((item.notBefore - Date.now()) / 1000)} с: це велика сума.` };
    // вибір дозволено лише серед запропонованих у запиті варіантів
    const opts = (item.spec.choice && item.spec.choice.options) || [];
    if (choice !== undefined && !(typeof choice === 'string' && opts.some(o => o.value === choice))) return { ok: false, error: 'Некоректний вибір.' };
    if (choice === undefined && opts.length) choice = item.spec.choice.value;
    const opts2 = (item.spec.choice2 && item.spec.choice2.options) || [];
    if (choice2 !== undefined && !(typeof choice2 === 'string' && opts2.some(o => o.value === choice2))) return { ok: false, error: 'Некоректний вибір.' };
    if (choice2 === undefined && opts2.length) choice2 = item.spec.choice2.value;
    if (item.spec.agent) { this.finishApproval(true); return { ok: true }; }
    const v = this.ctx.vault;
    master = String(master || '').slice(0, 256);
    if (v.status() !== 'unlocked') {
      const r = await v.unlock(master);
      if (!r.ok) return r;
    } else if (!v.recentlyAuthed(this.ctx.wallet.reauthMs())) {
      if (!(await v.reauth(master))) return { ok: false, error: 'Хибний майстер-пароль.' };
    }
    this.finishApproval(true, choice, choice2);
    return { ok: true };
  },
};

module.exports = { methods };
