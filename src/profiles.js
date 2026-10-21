'use strict';
// Профілі: кожен має власні cookie/кеш (окремий partition), закладки, історію, паролі, налаштування та синхронізацію.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const { Store } = require('./store');

const COLORS = ['#5a8dee', '#e5675f', '#4caf8a', '#d8963a', '#a078f0', '#3aa7c9', '#c8639b', '#7a8a99'];
const DEFAULT_PROFILE = { id: 'default', name: 'Основний', color: COLORS[0] };

class ProfileManager {
  constructor() {
    this.shared = { blocker: null, blockerPreload: null, sessions: [], threats: null };
    this.store = new Store('profiles', { profiles: [DEFAULT_PROFILE] });
    if (!this.store.data.profiles.some(p => p.id === 'default')) this.store.data.profiles.unshift({ ...DEFAULT_PROFILE });
    this.ctxs = new Map();
  }

  list() { return this.store.data.profiles.map(p => ({ ...p })); }
  info(id) { return this.store.data.profiles.find(p => p.id === id) || { id, name: id, color: '#7a8a99' }; }
  has(id) { return this.store.data.profiles.some(p => p.id === id); }
  dirOf(id) { return id === 'default' ? app.getPath('userData') : path.join(app.getPath('userData'), 'profiles', id); }

  ctx(id = 'default') {
    if (!this.has(id)) throw new Error('Профіль не знайдено');
    let c = this.ctxs.get(id);
    if (!c) {
      const { createContext } = require('./context');
      c = createContext({ id, dir: this.dirOf(id), shared: this.shared, manager: this });
      this.ctxs.set(id, c);
    }
    return c;
  }

  all() { return [...this.ctxs.values()]; }

  ctxOf(wc) {
    for (const c of this.ctxs.values()) if (c.registry.has(wc.id)) return c;
    return null;
  }

  create(name, color) {
    name = String(name || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 40);
    if (!name) throw new Error('Вкажіть назву профілю.');
    if (this.store.data.profiles.some(p => p.name.toLowerCase() === name.toLowerCase())) throw new Error('Профіль із такою назвою вже існує.');
    if (this.store.data.profiles.length >= 20) throw new Error('Досягнуто ліміт профілів.');
    const id = crypto.randomBytes(6).toString('hex');
    const dir = this.dirOf(id);
    fs.mkdirSync(dir, { recursive: true });
    // Нові профілі починають із налаштувань основного (мова пошуку, блокувальник тощо), але без даних
    try { fs.copyFileSync(path.join(this.dirOf('default'), 'settings.json'), path.join(dir, 'settings.json')); } catch { /* ignore */ }
    this.store.data.profiles.push({ id, name, color: COLORS.includes(color) ? color : COLORS[this.store.data.profiles.length % COLORS.length] });
    this.store.flush();
    return id;
  }

  rename(id, name) {
    const p = this.store.data.profiles.find(p => p.id === id);
    name = String(name || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 40);
    if (!p || !name) throw new Error('Некоректна назва.');
    if (this.store.data.profiles.some(x => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) throw new Error('Профіль із такою назвою вже існує.');
    p.name = name;
    this.store.flush();
    for (const c of this.ctxs.values()) c.pushAll();
  }

  async remove(id) {
    if (id === 'default') throw new Error('Основний профіль видалити не можна.');
    const idx = this.store.data.profiles.findIndex(p => p.id === id);
    if (idx < 0) return;
    const c = this.ctxs.get(id);
    if (c) {
      c.quitting = true; // не перезаписувати сесію під час закриття
      for (const w of [...c.windows]) w.win.destroy();
      c.vault.lock();
      c.sync.stop();
      c.github.stop();
      try { for (const s of [c.session, ...c.containerSessions.values()]) { await s.clearStorageData(); await s.clearCache(); } } catch { /* ignore */ }
      // зупиняємо відкладений запис, щоб файли не з'явилися знову після видалення
      const stores = [c.settingsStore, c.bookmarksStore, c.windowStore, c.sessionStore, c.permsStore, c.extStore, c.downloads.store, c.sync.state];
      for (const s of stores) { clearTimeout(s.timer); s.timer = null; s.save = () => {}; s.flush = () => {}; }
      try { c.places.close(); } catch { /* ignore */ } // відкритий файл бази не можна видалити
      this.ctxs.delete(id);
    }
    try { fs.rmSync(this.dirOf(id), { recursive: true, force: true }); } catch { /* ignore */ }
    this.store.data.profiles.splice(idx, 1);
    this.store.flush();
  }

  // Відкриває вікно профілю (або фокусує наявне)
  open(id, { urls, forceNew } = {}) {
    const c = this.ctx(id);
    const existing = [...c.windows].filter(w => !w.incognito).pop();
    if (existing && !forceNew && !(urls && urls.length)) {
      if (existing.win.isMinimized()) existing.win.restore();
      existing.win.focus();
      return existing;
    }
    if (existing && urls && urls.length) {
      existing.win.focus();
      urls.forEach(u => existing.createTab(u));
      return existing;
    }
    return this.launch(id, urls);
  }

  // Початкові вікна профілю: відновлення сесії або нова вкладка
  launch(id, urls) {
    const c = this.ctx(id);
    const ws = c.windowStore.data;
    const bounds = ws && ws.width ? { x: ws.x, y: ws.y, width: ws.width, height: ws.height } : undefined;
    if ((!urls || !urls.length) && c.cfg().startup === 'restore') {
      const saved = c.sessionStore.data.windows || [];
      let first;
      saved.forEach((s, i) => {
        if (!s.urls || !s.urls.length) return;
        const w = c.openWindow({ urls: s.urls, activeIndex: s.activeIndex, pinned: s.pinned, containers: s.containers, groups: s.groups, groupOf: s.groupOf, split: s.split, bounds: i === 0 ? bounds : undefined, maximized: i === 0 && ws.maximized });
        first = first || w;
      });
      if (first) return first;
    }
    const home = c.cfg().homepage;
    return c.openWindow({ urls: urls && urls.length ? urls : [home || 'w3ir://newtab'], bounds, maximized: ws && ws.maximized });
  }
}

module.exports = { ProfileManager, COLORS };
