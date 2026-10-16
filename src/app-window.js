'use strict';
const { BrowserWindow, WebContentsView, Menu, clipboard, shell, dialog, app, session } = require('electron');
const { normOrigin } = require('./vault');
const { githubRepo, HTML_URL } = require('./github');
const { ASK } = require('./context');
const { withTip } = require('./tips');
const tabGroups = require('./tab-groups');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ICON = path.join(ROOT, 'build', 'icon.png');
const NEWTAB = 'w3ir://newtab';
const SIDEBAR_W = 240;
const SLEEP_AFTER = Number(process.env.W3IR_SLEEP_MS) || 15 * 60 * 1000;
let counter = 0;
let readabilitySrc = null;

const isBlankUrl = (u) => !u || u === 'about:blank' || /^w3ir:\/\/newtab\/?$/.test(u);
// Лише безпечні символи URL: без лапок, пробілів, <>, `, ^, |, \ та ' — щоб не «вийти» за межі аргументу зовнішньої програми
const SAFE_EXTERNAL = /^[A-Za-z0-9\-._~:\/?#\[\]@!$&()*+,;=%]+$/;
const EXTERNAL_SCHEME = /^(mailto|tel|magnet|x-github-client|vscode|vscode-insiders):/i;
const ANCHORED_OVERLAYS = new Set(['menu', 'vault', 'github', 'site']); // панелі під панеллю інструментів
const isWebUrl = (u) => /^https?:/i.test(u || '');

class AppWindow {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.id = ++counter;
    this.agent = !!opts.agent; // вікно під керуванням ШІ (src/agent.js): завжди тимчасове й ізольоване
    this.incognito = !!opts.incognito || this.agent;
    this.ses = this.incognito ? ctx.getIncognitoSession(this.id) : ctx.session;
    if (this.agent) this.ses.__w3irAgent = true;
    this.tabs = [];
    this.initGroups();
    this.activeId = null;
    this.nextTabId = 1;
    this.chromeHeight = 118;
    this.closedStack = [];
    this.htmlFullscreen = false;
    this.overlayType = null;
    this.overlayAnchor = 0;
    this.pendingSave = null;
    this.pendingTimer = null;
    this.protected = false;
    this.approval = null;
    this.approvalQueue = [];
    this.pushTimer = null;
    this.closing = false;

    const b = opts.bounds || {};
    this.win = new BrowserWindow({
      x: b.x, y: b.y, width: b.width || 1280, height: b.height || 800,
      minWidth: 480, minHeight: 320, show: false,
      title: 'W3IR Browser', icon: ICON,
      backgroundColor: this.incognito ? '#1b1626' : (require('electron').nativeTheme.shouldUseDarkColors ? '#1e1f22' : '#f1f3f4'),
      webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    this.chrome = this.win.webContents;
    this.chrome.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.chrome.on('will-navigate', (e) => e.preventDefault());
    this.chrome.on('before-input-event', (e, input) => this.onKey(e, input));
    ctx.register(this.chrome, this);

    this.overlay = new WebContentsView({
      webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    this.overlay.setBackgroundColor('#00000000');
    this.overlay.webContents.on('before-input-event', (e, input) => this.onKey(e, input));
    this.overlay.webContents.on('will-navigate', (e) => e.preventDefault());
    ctx.register(this.overlay.webContents, this);
    this.overlay.webContents.loadURL('w3ir://ui/overlay.html');

    this.win.on('resize', () => this.layout());
    this.win.on('enter-full-screen', () => this.layout());
    this.win.on('leave-full-screen', () => this.layout());
    this.win.on('close', () => this.onClose());
    this.win.on('closed', () => this.onClosed());
    this.win.once('ready-to-show', () => {
      this.win.show();
      if (opts.maximized) this.win.maximize();
    });

    this.sleepTimer = setInterval(() => this.sleepIdle(), Math.min(60000, SLEEP_AFTER));
    ctx.windows.add(this);
    this.chrome.once('did-finish-load', () => {
      const urls = (opts.urls && opts.urls.length) ? opts.urls : [NEWTAB];
      const gids = this.restoreGroups(opts.groups);
      urls.forEach((u, i) => this.createTab(u, { activate: i === (opts.activeIndex || 0), pinned: !!(opts.pinned && opts.pinned[i]), group: opts.groupOf && gids[opts.groupOf[i]] ? gids[opts.groupOf[i]] : null }));
      if (urls.length === 1 && urls[0] === NEWTAB) this.focusUrlBar();
    });
    this.win.loadURL('w3ir://ui/index.html');
  }

  // ---------- допоміжне ----------
  active() { return this.tabs.find(t => t.id === this.activeId); }
  wc() { const t = this.active(); return t ? t.view.webContents : null; }
  tabUrl(tab) {
    if (tab.sleep) return tab.sleep.url;
    const u = tab.view.webContents.getURL();
    return u.startsWith('w3ir://error') ? (tab.errorUrl || '') : u;
  }
  displayUrl(tab) {
    const u = this.tabUrl(tab);
    return isBlankUrl(u) ? '' : u;
  }
  vertical() { return !!this.ctx.cfg().verticalTabs; }
  snapshot() {
    const urls = [], pinned = [], included = [];
    let active = 0;
    this.tabs.forEach(t => {
      const u = this.tabUrl(t);
      if (!u || u === 'about:blank') return;
      if (t.id === this.activeId) active = urls.length;
      urls.push(u);
      pinned.push(!!t.pinned);
      included.push(t);
    });
    return { urls, activeIndex: active, pinned, ...this.snapshotGroups(included) };
  }
  focusUrlBar() {
    this.chrome.focus();
    this.chrome.send('focus-url');
  }
  toast(text) { this.chrome.send('toast', text); }

  layout() {
    if (this.win.isDestroyed()) return;
    const [w, h] = this.win.getContentSize();
    const top = this.htmlFullscreen ? 0 : this.chromeHeight;
    const left = this.htmlFullscreen || !this.vertical() ? 0 : SIDEBAR_W;
    const t = this.active();
    if (t) t.view.setBounds({ x: left, y: top, width: Math.max(0, w - left), height: Math.max(0, h - top) });
    if (ANCHORED_OVERLAYS.has(this.overlayType)) {
      const y = this.overlayAnchor || top;
      this.overlay.setBounds({ x: 0, y, width: w, height: Math.max(0, h - y) });
    } else if (this.overlayType === 'palette' || this.overlayType === 'approve') {
      this.overlay.setBounds({ x: 0, y: 0, width: w, height: h });
    }
  }

  // ---------- стан для інтерфейсу ----------
  push() {
    if (this.pushTimer || this.win.isDestroyed()) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      if (this.win.isDestroyed()) return;
      this.sendState();
      this.ctx.saveSession();
    }, 30);
  }

  sendState() {
    const ctx = this.ctx;
    const cfg = ctx.cfg();
    const a = this.active();
    const curUrl = a ? this.tabUrl(a) : '';
    const bookmarks = ctx.bookmarks();
    const state = {
      incognito: this.incognito,
      agent: this.agent,
      vertical: this.vertical(),
      activeId: this.activeId,
      tabs: this.tabs.map(t => {
        const wc = t.view.webContents;
        const url = this.displayUrl(t);
        const sl = t.sleep;
        return {
          id: t.id,
          title: (sl ? sl.title : wc.getTitle()) || (isBlankUrl(this.tabUrl(t)) ? 'Нова вкладка' : url || 'Завантаження…'),
          url,
          favicon: sl ? sl.favicon : t.favicon,
          loading: !sl && wc.isLoading(),
          canBack: sl ? sl.index > 0 : wc.navigationHistory.canGoBack(),
          canForward: sl ? sl.index < sl.entries.length - 1 : wc.navigationHistory.canGoForward(),
          audible: !sl && wc.isCurrentlyAudible(),
          muted: wc.isAudioMuted(),
          blocked: t.blocked,
          secure: url.startsWith('https:'),
          pinned: !!t.pinned,
          sleeping: !!sl,
          group: t.group || null,
          ai: this.aiMode(t),
        };
      }),
      bookmarked: !!curUrl && bookmarks.some(b => b.url === curUrl),
      bookmarks: cfg.showBookmarksBar ? bookmarks.slice(0, 40) : [],
      groups: this.groupList(),
      adblock: cfg.adblock,
      engine: !!ctx.blocker,
      downloads: ctx.downloads.summary(),
      readable: isWebUrl(curUrl),
      vault: this.vaultState(curUrl),
      profile: ctx.profile(),
      github: { connected: ctx.github.connected(), count: ctx.github.count() },
      update: ctx.manager && ctx.manager.updater ? ctx.manager.updater.brief() : { state: 'idle' },
    };
    this.chrome.send('state', state);
    // Екран із паролями не потрапляє в скріншоти та запис екрана
    const protect = curUrl.startsWith('w3ir://passwords') || curUrl.startsWith('w3ir://wallet') || this.overlayType === 'vault' || this.overlayType === 'approve';
    if (protect !== this.protected) { this.protected = protect; try { this.win.setContentProtection(protect); } catch {} }
    const at = a ? state.tabs.find(t => t.id === a.id) : null;
    const prof = ctx.profile();
    this.win.setTitle((at && at.title ? at.title + ' — ' : '') + 'W3IR Browser' + (prof.id !== 'default' ? ` [${prof.name}]` : '') + (this.agent ? ' (Керує ШІ)' : this.incognito ? ' (Інкогніто)' : ''));
  }

  // ---------- вкладки ----------
  createTab(input, { activate = true, pinned = false, group = null, opener = null } = {}) {
    const view = new WebContentsView({
      webPreferences: {
        session: this.ses, sandbox: true, contextIsolation: true, nodeIntegration: false,
        preload: path.join(ROOT, 'page-preload.js'), spellcheck: true,
      },
    });
    const tab = { id: this.nextTabId++, view, favicon: '', blocked: 0, errorUrl: '', pinned, sleep: null, lastActive: Date.now(), reader: null, group: pinned ? null : group };
    if (pinned) this.tabs.splice(this.tabs.filter(t => t.pinned).length, 0, tab);
    else if (opener && opener.group && this.groups.has(opener.group) && this.tabs.includes(opener)) {
      // нова вкладка з посилання відкривається в групі відкривача, одразу після нього
      tab.group = opener.group;
      this.tabs.splice(this.tabs.indexOf(opener) + 1, 0, tab);
    } else this.tabs.push(tab);
    if (tab.group && !this.groups.has(tab.group)) tab.group = null;
    this.ctx.register(view.webContents, this, tab);
    this.bindTab(tab);
    this.navigate(tab, input);
    if (activate) this.switchTab(tab.id); else this.push();
    return tab;
  }

  navigate(tab, input) {
    if (/^\s*magnet:/i.test(String(input))) { this.openMagnet(input); return; }
    const url = this.ctx.resolveInput(input);
    if (!url) return;
    if (tab.sleep) tab.sleep = null;
    tab.view.webContents.loadURL(url).catch(() => { /* помилки показує did-fail-load */ });
  }

  showError(tab, code, desc, url) {
    tab.errorUrl = url;
    const q = `code=${encodeURIComponent(code)}&desc=${encodeURIComponent(desc)}&url=${encodeURIComponent(url)}`;
    tab.view.webContents.loadURL('w3ir://error?' + q).catch(() => {});
  }

  bindTab(tab) {
    const wc = tab.view.webContents;
    const push = () => this.push();
    for (const ev of ['did-start-loading', 'did-stop-loading', 'did-navigate-in-page', 'audio-state-changed'])
      wc.on(ev, push);

    wc.on('page-title-updated', (e, title) => {
      if (!this.incognito && !tab.sleep) this.ctx.historyTitle(wc.getURL(), title);
      push();
    });
    wc.on('page-favicon-updated', (e, favicons) => { if (!tab.sleep) { tab.favicon = favicons[0] || ''; push(); } });
    wc.on('did-start-navigation', (d) => {
      if (d.isMainFrame && !d.isSameDocument) tab.blocked = 0;
    });
    wc.on('did-navigate', (e, url) => {
      if (tab.sleep) return;
      tab.favicon = '';
      if (!url.startsWith('w3ir://error')) tab.errorUrl = '';
      if (!this.incognito) this.ctx.historyAdd(url, wc.getTitle());
      push();
    });
    wc.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3 || url.startsWith('w3ir:') || tab.sleep) return;
      // HTTPS-first: якщо оновлена адреса недоступна (не через сертифікат) — відкриваємо http.
      const original = this.ctx.upgraded.get(url);
      if (original) {
        this.ctx.upgraded.delete(url);
        if (!(code <= -200 && code > -300)) {
          try { this.ctx.httpsBypass.add(new URL(original).hostname); } catch {}
          wc.loadURL(original).catch(() => {});
          return;
        }
      }
      this.showError(tab, code, desc, url);
    });
    wc.on('render-process-gone', (e, details) => {
      this.showError(tab, -1, 'RENDERER_CRASHED (' + details.reason + ')', this.tabUrl(tab));
    });
    wc.on('before-input-event', (e, input) => this.onKey(e, input));

    if (this.agent) {
      // у вікні ШІ кожен перехід, ініційований сторінкою, перевіряється: лише http(s) і лише підтверджені сайти
      const gate = (e, url) => { if (!this.ctx.agent.pageNavigation(this, tab, url, 'nav')) e.preventDefault(); };
      wc.on('will-navigate', gate);
      wc.on('will-redirect', gate);
    }
    wc.on('will-navigate', (e, url) => {
      if (EXTERNAL_SCHEME.test(url)) { e.preventDefault(); this.openExternal(url); }
      else if (!/^(https?|w3ir|file|about|blob|data|view-source):/i.test(url)) e.preventDefault();
    });
    wc.setWindowOpenHandler((d) => {
      if (this.agent) { this.ctx.agent.pageNavigation(this, tab, d.url, 'popup'); return { action: 'deny' }; }
      if (EXTERNAL_SCHEME.test(d.url)) { this.openExternal(d.url); return { action: 'deny' }; }
      if (d.disposition === 'new-window') {
        return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: ICON, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } } };
      }
      if (/^(https?|w3ir|file|about):/i.test(d.url)) this.createTab(d.url, { activate: d.disposition !== 'background-tab', opener: tab });
      return { action: 'deny' };
    });
    wc.on('did-create-window', (w) => { w.setMenuBarVisibility(false); });

    wc.on('enter-html-full-screen', () => { this.htmlFullscreen = true; this.win.setFullScreen(true); this.layout(); });
    wc.on('leave-html-full-screen', () => { this.htmlFullscreen = false; this.win.setFullScreen(false); this.layout(); });
    wc.on('found-in-page', (e, r) => {
      this.chrome.send('find-result', { active: r.activeMatchOrdinal, total: r.matches });
    });
    wc.on('context-menu', (e, p) => this.contextMenu(tab, p));
  }

  // magnet-посилання передаємо у зовнішній торент-клієнт (власного клієнта в браузері немає навмисно)
  async openMagnet(url) {
    url = String(url).trim();
    if (url.length > 8192 || !SAFE_EXTERNAL.test(url) || !/^magnet:\?(.*&)?xt=urn:(btih|btmh):[a-z0-9]{32,}/i.test(url)) {
      this.toast('Некоректне magnet-посилання');
      return;
    }
    const client = app.getApplicationNameForProtocol('magnet:');
    if (!client) {
      dialog.showMessageBox(this.win, {
        type: 'info', buttons: ['OK'], message: 'Торент-клієнт не знайдено',
        detail: 'Встановіть торент-клієнт (наприклад, qBittorrent або Transmission) — і magnet-посилання відкриватимуться в ньому.',
      }).catch(() => {});
      return;
    }
    const cfg = this.ctx.cfg();
    let name = '';
    try { name = new URL(url).searchParams.get('dn') || ''; } catch {}
    if (cfg.torrentConfirm) {
      const r = await dialog.showMessageBox(this.win, {
        type: 'question', buttons: ['Відкрити в ' + client, 'Скасувати'], defaultId: 1, cancelId: 1,
        message: 'Відкрити magnet-посилання у торент-клієнті?',
        detail: (name ? name.slice(0, 200) + '\n\n' : '') + 'Під час роздачі та завантаження торентів ваша IP-адреса видима іншим учасникам. Завантажуйте лише те, на що маєте право.',
        checkboxLabel: 'Більше не питати',
      });
      if (r.response !== 0) return;
      if (r.checkboxChecked) { cfg.torrentConfirm = false; this.ctx.settingsStore.save(); }
    }
    shell.openExternal(url).catch(() => this.toast('Не вдалося відкрити торент-клієнт'));
  }

  openExternal(url) {
    if (/^magnet:/i.test(url)) { this.openMagnet(url); return; }
    if (!SAFE_EXTERNAL.test(url)) return; // символи на кшталт " або пробілів можуть зламати командний рядок обробника
    dialog.showMessageBox(this.win, {
      type: 'question', buttons: ['Відкрити', 'Скасувати'], defaultId: 1, cancelId: 1,
      message: 'Відкрити зовнішню програму?', detail: url.slice(0, 200),
    }).then(r => { if (r.response === 0) shell.openExternal(url); }).catch(() => {});
  }

  switchTab(id) {
    const t = this.tabs.find(t => t.id === id);
    if (!t) return;
    this.closeOverlay();
    const prev = this.active();
    if (prev && prev !== t) {
      prev.lastActive = Date.now();
      try { prev.view.webContents.stopFindInPage('clearSelection'); } catch {}
      this.win.contentView.removeChildView(prev.view);
      this.chrome.send('find-close');
    }
    const tg = t.group && this.groups.get(t.group);
    if (tg && tg.collapsed) tg.collapsed = false; // перехід на вкладку розгортає її групу
    this.activeId = id;
    t.lastActive = Date.now();
    if (t.sleep) this.wake(t);
    this.win.contentView.addChildView(t.view);
    this.layout();
    if (!isBlankUrl(this.tabUrl(t))) t.view.webContents.focus();
    this.push();
  }

  closeTab(id) {
    const i = this.tabs.findIndex(t => t.id === id);
    if (i < 0) return;
    const tab = this.tabs[i];
    const url = this.tabUrl(tab);
    if (url && !/^w3ir:\/\/(newtab|error|reader)/.test(url) && url !== 'about:blank') {
      this.closedStack.push(url);
      if (this.closedStack.length > 25) this.closedStack.shift();
    }
    if (this.tabs.length === 1) { this.win.close(); return; }
    this.tabs.splice(i, 1);
    this.enforceGroups();
    if (id === this.activeId) {
      this.win.contentView.removeChildView(tab.view);
      this.activeId = null;
    }
    this.ctx.unregister(tab.view.webContents);
    try { tab.view.webContents.close(); } catch {}
    if (this.activeId === null) this.switchTab(this.tabs[Math.min(i, this.tabs.length - 1)].id);
    else this.push();
  }

  moveTab({ id, index }) {
    const from = this.tabs.findIndex(t => t.id === id);
    if (from < 0) return;
    const [t] = this.tabs.splice(from, 1);
    this.tabs.splice(Math.max(0, Math.min(index, this.tabs.length)), 0, t);
    this.adjustGroupAfterMove(t);
    this.sortPinned();
    this.push();
  }

  sortPinned() {
    this.tabs = [...this.tabs.filter(t => t.pinned), ...this.tabs.filter(t => !t.pinned)];
    this.enforceGroups();
  }

  duplicateTab(id) {
    const t = this.tabs.find(t => t.id === id);
    if (!t) return;
    const nt = this.createTab(this.tabUrl(t) || NEWTAB, { activate: true });
    const i = this.tabs.indexOf(t), j = this.tabs.indexOf(nt);
    this.tabs.splice(j, 1);
    this.tabs.splice(i + 1, 0, nt);
    nt.group = t.group || null;
    this.sortPinned();
    this.push();
  }

  // ---------- менеджер паролів ----------
  vaultState(curUrl) {
    const v = this.ctx.vault;
    const origin = normOrigin(curUrl);
    const st = v.status();
    return { status: st, count: st === 'unlocked' && origin ? v.count(origin) : 0, canFill: !!origin };
  }

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
  }

  refreshVaultOverlay() {
    if (this.overlayType === 'vault') this.overlay.webContents.send('overlay', { type: 'vault', ...this.vaultPanel() });
  }

  async vaultUnlock(master) {
    const r = await this.ctx.vault.unlock(String(master || '').slice(0, 256));
    if (r.ok) { this.refreshVaultOverlay(); this.ctx.flushPending(); }
    return r;
  }

  vaultFill(id) {
    const t = this.active();
    if (!t || t.sleep) return;
    let e;
    try { e = this.ctx.vault.get(id); } catch { return; }
    const origin = normOrigin(this.tabUrl(t));
    if (!e || !origin || origin !== e.origin) { this.toast('Адреса сторінки не збігається із записом — заповнення скасовано'); return; }
    t.view.webContents.send('vault:fill', { origin, username: e.username, password: e.password });
    this.closeOverlay();
  }

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
  }

  clearPending() {
    clearTimeout(this.pendingTimer);
    this.pendingSave = null;
    if (!this.win.isDestroyed()) this.chrome.send('savebar', null);
  }

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
  }

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
  }

  // ---------- підтвердження дій гаманця (довіреним вікном, яке сторінка не може підробити) ----------
  requestApproval(spec) {
    return new Promise((resolve) => {
      if (this.approvalQueue.length >= 5) { resolve({ approved: false }); return; }
      this.approvalQueue.push({ id: require('crypto').randomUUID(), spec, resolve, timer: null });
      this.showNextApproval();
    });
  }

  showNextApproval() {
    if (this.approval || !this.approvalQueue.length || this.win.isDestroyed()) return;
    const item = this.approvalQueue.shift();
    this.approval = item;
    item.timer = setTimeout(() => this.finishApproval(false), 120000);
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.openOverlay('approve', this.approvalPayload(item), {});
    this.push();
  }

  approvalPayload(item) {
    const v = this.ctx.vault;
    const st = v.status();
    if (item.spec.agent) return { id: item.id, ...item.spec, needsUnlock: false, needsAuth: false }; // підтвердження сайту для ШІ не потребує майстер-пароля
    return { id: item.id, ...item.spec, needsUnlock: st !== 'unlocked', needsAuth: st === 'unlocked' && !v.recentlyAuthed() };
  }

  finishApproval(approved) {
    const item = this.approval;
    if (!item) return;
    clearTimeout(item.timer);
    this.approval = null;
    if (this.overlayType === 'approve') { this.overlayType = null; try { this.win.contentView.removeChildView(this.overlay); } catch {} }
    item.resolve({ approved });
    this.push();
    this.showNextApproval();
  }

  async decide(id, approve, master) {
    const item = this.approval;
    if (!item || item.id !== id) return { ok: false, error: 'Запит застарів.' };
    if (!approve) { this.finishApproval(false); return { ok: true }; }
    if (item.spec.agent) { this.finishApproval(true); return { ok: true }; }
    const v = this.ctx.vault;
    master = String(master || '').slice(0, 256);
    if (v.status() !== 'unlocked') {
      const r = await v.unlock(master);
      if (!r.ok) return r;
    } else if (!v.recentlyAuthed()) {
      if (!(await v.reauth(master))) return { ok: false, error: 'Хибний майстер-пароль.' };
    }
    this.finishApproval(true);
    return { ok: true };
  }

  // ---------- сплячі вкладки (економія пам'яті) ----------
  sleepTab(tab) {
    if (tab.sleep || tab.id === this.activeId) return false;
    const wc = tab.view.webContents;
    const url = this.tabUrl(tab);
    if (!isWebUrl(url) || wc.isCurrentlyAudible() || wc.isLoading()) return false;
    tab.sleep = {
      url, title: wc.getTitle(), favicon: tab.favicon,
      entries: wc.navigationHistory.getAllEntries(), index: wc.navigationHistory.getActiveIndex(),
    };
    wc.loadURL('about:blank').catch(() => {});
    this.push();
    return true;
  }

  wake(tab) {
    const s = tab.sleep;
    tab.sleep = null;
    tab.favicon = s.favicon;
    const wc = tab.view.webContents;
    const fallback = () => wc.loadURL(s.url).catch(() => {});
    try {
      Promise.resolve(wc.navigationHistory.restore({ index: s.index, entries: s.entries })).catch(fallback);
    } catch { fallback(); }
  }

  sleepIdle() {
    if (!this.ctx.cfg().sleepTabs || this.agent) return;
    const now = Date.now();
    for (const t of this.tabs) {
      if (!t.sleep && t.id !== this.activeId && now - t.lastActive > SLEEP_AFTER) this.sleepTab(t);
    }
  }

  // ---------- режим читання ----------
  async openReader() {
    const t = this.active();
    if (!t || t.sleep) return;
    const url = this.tabUrl(t);
    if (!isWebUrl(url)) return;
    try {
      if (!readabilitySrc) readabilitySrc = fs.readFileSync(path.join(ROOT, 'node_modules', '@mozilla', 'readability', 'Readability.js'), 'utf8');
      const article = await t.view.webContents.executeJavaScript(`(function(){ ${readabilitySrc}
        try { const a = new Readability(document.cloneNode(true)).parse();
          return a && a.content ? { title: a.title, content: a.content, byline: a.byline, siteName: a.siteName, length: a.length } : null;
        } catch (e) { return null; } })()`);
      if (!article || !article.content || article.length < 200) { this.toast('Для цієї сторінки режим читання недоступний'); return; }
      t.reader = { ...article, url };
      t.view.webContents.loadURL('w3ir://reader').catch(() => {});
    } catch { this.toast('Не вдалося увімкнути режим читання'); }
  }

  // ---------- оверлей (меню, підказки, палітра) ----------
  openOverlay(type, payload, bounds) {
    this.overlayType = type;
    this.overlayAnchor = ANCHORED_OVERLAYS.has(type) ? bounds.y : 0;
    this.win.contentView.addChildView(this.overlay);
    if (ANCHORED_OVERLAYS.has(type) || type === 'palette' || type === 'approve') this.layout();
    else this.overlay.setBounds(bounds);
    this.overlay.webContents.send('overlay', { type, ...payload });
    if (type !== 'suggest') this.overlay.webContents.focus();
  }

  closeOverlay() {
    if (!this.overlayType) return;
    // закриття вікна підтвердження = відхилення запиту
    if (this.overlayType === 'approve' && this.approval) { this.finishApproval(false); return; }
    this.overlayType = null;
    try { this.win.contentView.removeChildView(this.overlay); } catch {}
    const wc = this.wc();
    if (wc && !this.chrome.isFocused()) wc.focus();
  }

  closeSuggest() { if (this.overlayType === 'suggest') this.closeOverlay(); }

  // ---------- інформація про сайт ----------
  async sitePanelData() {
    const t = this.active();
    const url = t ? this.tabUrl(t) : '';
    let u = null;
    try { u = new URL(url); } catch { /* немає адреси */ }
    const web = !!u && /^https?:$/.test(u.protocol);
    const kind = !u ? 'none' : u.protocol === 'https:' ? 'https' : u.protocol === 'http:' ? 'http' : u.protocol === 'w3ir:' ? 'internal' : u.protocol === 'file:' ? 'file' : 'other';
    const host = web ? u.hostname : '';
    let cookies = 0;
    if (web) { try { cookies = (await this.ctx.siteCookies(this.ses, host)).length; } catch { /* ignore */ } }
    return {
      kind, host, incognito: this.incognito,
      perms: web ? this.ctx.sitePerms(this.ses, u.origin) : null,
      permLabels: ASK,
      adblock: { enabled: this.ctx.cfg().adblock !== false, allowed: web ? this.ctx.adblockAllowed(host) : false, blocked: t ? t.blocked : 0 },
      cookies,
    };
  }

  async refreshSiteOverlay() {
    if (this.overlayType === 'site' && !this.win.isDestroyed()) this.overlay.webContents.send('overlay', { type: 'site', x: this.siteX || 0, ...(await this.sitePanelData()) });
  }

  siteTarget() {
    const t = this.active();
    try { const u = new URL(this.tabUrl(t)); return /^https?:$/.test(u.protocol) ? u : null; } catch { return null; }
  }

  refreshGithubOverlay() {
    if (this.overlayType === 'github' && !this.win.isDestroyed()) this.overlay.webContents.send('overlay', { type: 'github', ...this.ctx.github.panel() });
  }

  // Команди для сторінок репозиторіїв GitHub (з'являються в палітрі Ctrl+K)
  githubCommands() {
    const t = this.active();
    const url = t ? this.tabUrl(t) : '';
    const gr = githubRepo(url);
    if (!gr) return [];
    const base = `https://github.com/${gr.owner}/${gr.repo}`;
    const name = `${gr.owner}/${gr.repo}`;
    const cmds = [
      { label: `GitHub: копіювати git clone (HTTPS) — ${name}`, cmd: 'copyText', arg: `git clone ${base}.git` },
      { label: `GitHub: копіювати git clone (SSH) — ${name}`, cmd: 'copyText', arg: `git clone git@github.com:${gr.owner}/${gr.repo}.git` },
      { label: `GitHub: завантажити ZIP — ${name}`, cmd: 'downloadUrl', arg: `${base}/archive/HEAD.zip` },
      { label: `GitHub: відкрити в github.dev (редактор) — ${name}`, cmd: 'newTabUrl', arg: `https://github.dev/${gr.owner}/${gr.repo}` },
      { label: `GitHub: Issues — ${name}`, cmd: 'newTabUrl', arg: `${base}/issues` },
      { label: `GitHub: Pull requests — ${name}`, cmd: 'newTabUrl', arg: `${base}/pulls` },
      { label: `GitHub: Actions — ${name}`, cmd: 'newTabUrl', arg: `${base}/actions` },
      { label: `GitHub: Releases — ${name}`, cmd: 'newTabUrl', arg: `${base}/releases` },
      { label: `GitHub: відкрити в GitHub Desktop — ${name}`, cmd: 'externalUrl', arg: `x-github-client://openRepo/${base}` },
      { label: `GitHub: відкрити у VS Code — ${name}`, cmd: 'externalUrl', arg: `vscode://vscode.git/clone?url=${encodeURIComponent(base + '.git')}` },
    ];
    if (gr.kind === 'blob' && gr.rest.length >= 2) {
      const [branch, ...file] = gr.rest;
      cmds.unshift({ label: 'GitHub: відкрити Raw-файл', cmd: 'newTabUrl', arg: `https://raw.githubusercontent.com/${gr.owner}/${gr.repo}/${branch}/${file.join('/')}` });
    }
    return cmds;
  }

  commandList() {
    const vert = this.vertical();
    const ad = this.ctx.cfg().adblock;
    return [
      ...this.githubCommands(),
      { label: 'Нова вкладка', hint: 'Ctrl+T', cmd: 'newTab' },
      { label: 'Нове вікно', hint: 'Ctrl+N', cmd: 'newWindow' },
      { label: 'Нове вікно інкогніто', hint: 'Ctrl+Shift+N', cmd: 'newIncognito' },
      ...this.aiCommands(),
      { label: 'Закрити вкладку', hint: 'Ctrl+W', cmd: 'closeTab', arg: this.activeId },
      { label: 'Відновити закриту вкладку', hint: 'Ctrl+Shift+T', cmd: 'reopenClosed' },
      { label: 'Закріпити / відкріпити вкладку', cmd: 'pinTab', arg: this.activeId },
      { label: 'Дублювати вкладку', cmd: 'duplicateTab', arg: this.activeId },
      { label: 'Нова група з поточної вкладки', cmd: 'groupNew', arg: this.activeId },
      ...this.groupList().map(g => ({ label: `Перейти до групи «${g.name || 'Без назви'}»`, cmd: 'groupFocus', arg: g.id })),
      { label: 'Режим читання', hint: 'Ctrl+Shift+R', cmd: 'reader' },
      { label: vert ? 'Горизонтальні вкладки' : 'Вертикальні вкладки', cmd: 'toggleVertical' },
      { label: ad ? 'Вимкнути блокування реклами' : 'Увімкнути блокування реклами', cmd: 'toggleAdblock' },
      { label: 'Закладка для цієї сторінки', hint: 'Ctrl+D', cmd: 'bookmark' },
      { label: 'Знайти на сторінці', hint: 'Ctrl+F', cmd: 'find' },
      { label: 'Закладки', hint: 'Ctrl+Shift+O', cmd: 'openPage', arg: 'bookmarks' },
      { label: 'Історія', hint: 'Ctrl+H', cmd: 'openPage', arg: 'history' },
      { label: 'Завантаження', hint: 'Ctrl+J', cmd: 'openPage', arg: 'downloads' },
      { label: 'Менеджер паролів', cmd: 'openPage', arg: 'passwords' },
      { label: 'Панель (стан браузера)', cmd: 'openPage', arg: 'dashboard' },
      { label: 'Гаманець (Web3)', cmd: 'openPage', arg: 'wallet' },
      { label: 'Імпорт з Chrome / Firefox', cmd: 'openPage', arg: 'import' },
      { label: 'Керування профілями', cmd: 'openPage', arg: 'profiles' },
      ...(this.ctx.manager ? this.ctx.manager.list().filter(p => p.id !== this.ctx.id).map(p => ({ label: `Перейти до профілю «${p.name}»`, cmd: 'openProfile', arg: p.id })) : []),
      { label: 'Заблокувати сховище паролів', cmd: 'vaultLock' },
      { label: 'Налаштування', cmd: 'openPage', arg: 'settings' },
      { label: 'Збільшити масштаб', hint: 'Ctrl++', cmd: 'zoomIn' },
      { label: 'Зменшити масштаб', hint: 'Ctrl+−', cmd: 'zoomOut' },
      { label: 'Скинути масштаб', hint: 'Ctrl+0', cmd: 'zoomReset' },
      { label: 'Друк…', hint: 'Ctrl+P', cmd: 'print' },
      { label: 'На весь екран', hint: 'F11', cmd: 'fullscreen' },
      { label: 'Інструменти розробника', hint: 'F12', cmd: 'devtools' },
      { label: 'Довідка', hint: 'F1', cmd: 'openPage', arg: 'help' },
      ...(this.agentOn() ? [{ label: 'Зупинити керування браузером ШІ', cmd: 'agentStop' }] : []),
      { label: 'Вийти', cmd: 'quit' },
    ];
  }

  aiMode(tab) { const a = this.ai(); return a && !this.incognito ? a.shareMode(this, tab) : ''; }

  // Агент керування ШІ живе в основному профілі; null, якщо недоступний
  ai() { const m = this.ctx.manager; return (m ? m.ctx('default') : this.ctx).agent || null; }

  // Команди палітри для поточної вкладки
  aiCommands() {
    const a = this.ai(); const t = this.active();
    if (!a || !t || this.incognito || this.agent || !a.state.enabled || !isWebUrl(this.tabUrl(t))) return [];
    const mode = a.shareMode(this, t);
    return mode ? [{ label: 'ШІ: припинити доступ до цієї вкладки', cmd: 'aiUnshare', arg: t.id }] : [
      { label: 'ШІ: дозволити читати цю вкладку', cmd: 'aiShare', arg: { id: t.id, mode: 'read' } },
      { label: 'ШІ: дозволити керувати цією вкладкою', cmd: 'aiShare', arg: { id: t.id, mode: 'control' } },
    ];
  }

  agentOn() { const m = this.ctx.manager; const a = m && m.ctx('default').agent; return !!(a && a.state.enabled); }

  menuItems() {
    const wc = this.wc();
    const zoom = wc ? Math.round(Math.pow(1.2, wc.getZoomLevel()) * 100) : 100;
    const up = this.ctx.manager && this.ctx.manager.updater ? this.ctx.manager.updater.brief() : null;
    return [
      ...(up && up.state === 'ready' ? [{ label: `Оновити браузер до ${up.version} (перезапуск)`, cmd: 'updateInstall' }, { sep: true }] : []),
      { label: 'Нова вкладка', hint: 'Ctrl+T', cmd: 'newTab' },
      { label: 'Нове вікно', hint: 'Ctrl+N', cmd: 'newWindow' },
      { label: 'Нове вікно інкогніто', hint: 'Ctrl+Shift+N', cmd: 'newIncognito' },
      { label: 'Профілі…', cmd: 'openPage', arg: 'profiles' },
      { sep: true },
      { label: 'Пошук по вкладках і командах', hint: 'Ctrl+K', cmd: 'palette' },
      { label: 'Режим читання', hint: 'Ctrl+Shift+R', cmd: 'reader' },
      { label: this.vertical() ? 'Горизонтальні вкладки' : 'Вертикальні вкладки', cmd: 'toggleVertical' },
      { sep: true },
      { label: 'Закладки', hint: 'Ctrl+Shift+O', cmd: 'openPage', arg: 'bookmarks' },
      { label: 'Історія', hint: 'Ctrl+H', cmd: 'openPage', arg: 'history' },
      { label: 'Завантаження', hint: 'Ctrl+J', cmd: 'openPage', arg: 'downloads' },
      { label: 'Менеджер паролів', cmd: 'openPage', arg: 'passwords' },
      { label: 'Панель (стан браузера)', cmd: 'openPage', arg: 'dashboard' },
      { label: 'Гаманець (Web3)', cmd: 'openPage', arg: 'wallet' },
      { sep: true },
      { label: 'Збільшити', hint: 'Ctrl++', cmd: 'zoomIn' },
      { label: 'Зменшити', hint: 'Ctrl+−', cmd: 'zoomOut' },
      { label: `Скинути масштаб (${zoom}%)`, hint: 'Ctrl+0', cmd: 'zoomReset' },
      { label: 'Знайти на сторінці', hint: 'Ctrl+F', cmd: 'find' },
      { label: 'Друк…', hint: 'Ctrl+P', cmd: 'print' },
      { label: 'На весь екран', hint: 'F11', cmd: 'fullscreen' },
      { label: 'Інструменти розробника', hint: 'F12', cmd: 'devtools' },
      { sep: true },
      { label: 'Імпорт з Chrome / Firefox', cmd: 'openPage', arg: 'import' },
      { label: 'Налаштування', cmd: 'openPage', arg: 'settings' },
      { label: 'Довідка', hint: 'F1', cmd: 'openPage', arg: 'help' },
      { label: 'Вийти', cmd: 'quit' },
    ];
  }

  paletteData(mode) {
    const ctx = this.ctx;
    const tabs = this.tabs.map(t => {
      const g = t.group && this.groups.get(t.group);
      const title = t.sleep ? t.sleep.title : t.view.webContents.getTitle();
      return { id: t.id, title: (g && g.name ? `[${g.name}] ` : '') + title, url: this.displayUrl(t) };
    });
    if (mode === 'tabs') return { mode, tabs };
    const seen = new Set();
    const history = [];
    const h = ctx.history();
    for (let i = h.length - 1; i >= 0 && history.length < 300; i--) {
      if (seen.has(h[i].url)) continue;
      seen.add(h[i].url);
      history.push({ title: h[i].title, url: h[i].url });
    }
    return {
      mode, tabs, commands: this.commandList().map(withTip),
      bookmarks: ctx.bookmarks().slice(0, 300).map(b => ({ title: b.title, url: b.url })),
      history,
    };
  }

  // ---------- меню вкладки та контекстне меню ----------
  tabMenu(id) {
    const t = this.tabs.find(t => t.id === id);
    if (!t) return;
    const i = this.tabs.indexOf(t);
    Menu.buildFromTemplate([
      { label: t.pinned ? 'Відкріпити вкладку' : 'Закріпити вкладку', click: () => this.exec('pinTab', id) },
      { label: t.view.webContents.isAudioMuted() ? 'Увімкнути звук' : 'Вимкнути звук', click: () => this.exec('muteTab', id) },
      { label: 'Дублювати', click: () => this.exec('duplicateTab', id) },
      { label: 'Приспати вкладку', enabled: id !== this.activeId && isWebUrl(this.tabUrl(t)) && !t.sleep, click: () => this.sleepTab(t) },
      { type: 'separator' },
      ...(t.pinned ? [] : [...this.tabGroupMenuItems(t), { type: 'separator' }]),
      ...this.aiMenuItems(t),
      { label: 'Закрити', click: () => this.closeTab(id) },
      { label: 'Закрити інші', enabled: this.tabs.length > 1, click: () => this.exec('closeOthers', id) },
      { label: 'Закрити вкладки праворуч', enabled: i < this.tabs.length - 1, click: () => this.exec('closeRight', id) },
    ]).popup({ window: this.win });
  }

  // Пункти «ШІ» у меню вкладки: поділитися (читання/керування) або припинити
  aiMenuItems(t) {
    const a = this.ai();
    if (!a || this.incognito || this.agent || !a.state.enabled || !isWebUrl(this.tabUrl(t))) return [];
    const mode = a.shareMode(this, t);
    return [
      { type: 'separator' },
      ...(mode ? [{ label: 'ШІ: припинити доступ до цієї вкладки', click: () => this.exec('aiUnshare', t.id) }] : []),
      ...(mode !== 'read' ? [{ label: 'ШІ: дозволити читати цю вкладку', click: () => this.exec('aiShare', { id: t.id, mode: 'read' }) }] : []),
      ...(mode !== 'control' ? [{ label: 'ШІ: дозволити керувати цією вкладкою…', click: () => this.exec('aiShare', { id: t.id, mode: 'control' }) }] : []),
      { type: 'separator' },
    ];
  }

  contextMenu(tab, p) {
    const wc = tab.view.webContents;
    const t = [];
    const cfg = this.ctx.cfg();
    const engine = (this.ctx.ENGINES[cfg.searchEngine] || this.ctx.ENGINES.google);
    if (p.misspelledWord) {
      for (const s of p.dictionarySuggestions.slice(0, 5)) t.push({ label: s, click: () => wc.replaceMisspelling(s) });
      if (t.length) t.push({ type: 'separator' });
    }
    if (p.linkURL) {
      t.push({ label: 'Відкрити посилання в новій вкладці', click: () => this.createTab(p.linkURL, { activate: false }) });
      t.push({ label: 'Відкрити посилання в інкогніто', click: () => this.ctx.openWindow({ incognito: true, urls: [p.linkURL] }) });
      t.push({ label: 'Копіювати адресу посилання', click: () => clipboard.writeText(p.linkURL) });
      t.push({ type: 'separator' });
    }
    if (p.mediaType === 'image' && p.srcURL) {
      t.push({ label: 'Відкрити зображення в новій вкладці', click: () => this.createTab(p.srcURL, { activate: false }) });
      t.push({ label: 'Зберегти зображення як…', click: () => wc.downloadURL(p.srcURL) });
      t.push({ label: 'Копіювати зображення', click: () => wc.copyImageAt(p.x, p.y) });
      t.push({ label: 'Копіювати адресу зображення', click: () => clipboard.writeText(p.srcURL) });
      t.push({ type: 'separator' });
    }
    if (p.isEditable) {
      t.push({ role: 'undo', label: 'Скасувати' }, { role: 'redo', label: 'Повторити' }, { type: 'separator' });
      t.push({ role: 'cut', label: 'Вирізати' }, { role: 'copy', label: 'Копіювати' }, { role: 'paste', label: 'Вставити' });
      t.push({ role: 'selectAll', label: 'Виділити все' });
    } else if (p.selectionText) {
      t.push({ role: 'copy', label: 'Копіювати' });
      const sel = p.selectionText.trim();
      const short = sel.length > 30 ? sel.slice(0, 30) + '…' : sel;
      t.push({
        label: `Шукати «${short}» (${engine.name})`,
        click: () => this.createTab(engine.url.replace('%s', encodeURIComponent(sel))),
      });
    } else if (!p.linkURL && p.mediaType !== 'image') {
      t.push({ label: 'Назад', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() });
      t.push({ label: 'Вперед', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() });
      t.push({ label: 'Оновити', click: () => this.exec('reload') });
      t.push({ type: 'separator' });
      t.push({ label: 'Зберегти як закладку', click: () => this.exec('bookmark') });
      t.push({ label: 'Режим читання', enabled: isWebUrl(this.tabUrl(tab)), click: () => this.openReader() });
      t.push({ label: 'Друк…', click: () => wc.print() });
      const url = this.tabUrl(tab);
      if (isWebUrl(url)) t.push({ label: 'Переглянути код сторінки', click: () => this.createTab('view-source:' + url) });
    }
    t.push({ type: 'separator' });
    t.push({ label: 'Дослідити елемент', click: () => wc.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(t).popup({ window: this.win });
  }

  // ---------- гарячі клавіші ----------
  onKey(e, input) {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const key = input.key.toLowerCase();
    const run = (cmd, arg) => { e.preventDefault(); this.exec(cmd, arg); };
    if (ctrl && !input.alt) {
      if (input.shift) {
        if (key === 't') return run('reopenClosed');
        if (key === 'n') return run('newIncognito');
        if (key === 'o') return run('openPage', 'bookmarks');
        if (key === 'a') return run('palette', 'tabs');
        if (key === 'r') return run('reader');
        if (key === 'tab') return run('prevTab');
        if (key === 'delete') return run('openPage', 'settings');
      } else {
        if (key === 't') return run('newTab');
        if (key === 'n') return run('newWindow');
        if (key === 'w' || key === 'f4') return run('closeTab', this.activeId);
        if (key === 'l') return run('focusUrl');
        if (key === 'k') return run('palette', 'all');
        if (key === 'r') return run('reload');
        if (key === 'd') return run('bookmark');
        if (key === 'f') return run('find');
        if (key === 'p') return run('print');
        if (key === 'h') return run('openPage', 'history');
        if (key === 'j') return run('openPage', 'downloads');
        if (key === 'tab') return run('nextTab');
        if (key === '=' || key === '+') return run('zoomIn');
        if (key === '-') return run('zoomOut');
        if (key === '0') return run('zoomReset');
        if (/^[1-9]$/.test(key)) return run('selectTab', Number(key));
      }
      if (key === 'pagedown') return run('nextTab');
      if (key === 'pageup') return run('prevTab');
      if (key === '=' || key === '+') return run('zoomIn');
    }
    if (input.alt && !ctrl) {
      if (key === 'arrowleft') return run('back');
      if (key === 'arrowright') return run('forward');
      if (key === 'home') return run('home');
    }
    if (key === 'f1') return run('openPage', 'help');
    if (key === 'f5') return run('reload');
    if (key === 'f11') return run('fullscreen');
    if (key === 'f12') return run('devtools');
    if (key === 'escape' && this.overlayType) return run('closeOverlay');
  }

  // ---------- команди ----------
  exec(cmd, arg) {
    const ctx = this.ctx;
    const t = this.active();
    const wc = this.wc();
    switch (cmd) {
      case 'newTab': this.createTab(NEWTAB); this.focusUrlBar(); break;
      case 'closeTab': this.closeTab(arg); break;
      case 'switchTab': this.switchTab(arg); break;
      case 'moveTab': this.moveTab(arg); break;
      case 'tabMenu': this.tabMenu(arg); break;
      case 'duplicateTab': this.duplicateTab(arg); break;
      case 'pinTab': {
        const x = this.tabs.find(x => x.id === arg);
        if (x) { x.pinned = !x.pinned; this.sortPinned(); this.push(); }
        break;
      }
      case 'closeOthers': this.tabs.filter(x => x.id !== arg && !x.pinned).forEach(x => this.closeTab(x.id)); this.switchTab(arg); break;
      case 'closeRight': {
        const i = this.tabs.findIndex(x => x.id === arg);
        this.tabs.slice(i + 1).forEach(x => this.closeTab(x.id));
        break;
      }
      case 'selectTab': {
        const vis = this.visibleTabs();
        const i = arg === 9 ? vis.length - 1 : arg - 1;
        if (vis[i]) this.switchTab(vis[i].id);
        break;
      }
      case 'nextTab': case 'prevTab': {
        const vis = this.visibleTabs();
        const i = vis.findIndex(x => x.id === this.activeId);
        const n = vis.length;
        this.switchTab(vis[(i + (cmd === 'nextTab' ? 1 : n - 1) + n) % n].id);
        break;
      }
      case 'groupNew': { const id = this.newGroup([arg]); if (id) this.chrome.send('group-edit', { id }); break; }
      case 'groupAdd': if (arg) this.addToGroup(arg.tabId, arg.groupId); break;
      case 'groupRemoveTab': this.removeFromGroup(arg); break;
      case 'groupMenu': this.groupMenu(arg); break;
      case 'groupToggle': { const g = this.group(arg); if (g) this.setGroupCollapsed(arg, !g.collapsed); break; }
      case 'groupRename': if (arg) this.setGroupName(arg.id, arg.name); break;
      case 'groupColor': if (arg) this.setGroupColor(arg.id, arg.color); break;
      case 'groupUngroup': this.ungroup(arg); break;
      case 'groupClose': this.closeGroup(arg); break;
      case 'moveGroup': if (arg) this.moveGroup(arg.id, arg.index); break;
      case 'groupFocus': { const first = this.groupTabs(arg)[0]; if (first) this.switchTab(first.id); break; }
      case 'groupNewTab': {
        const g = this.group(arg);
        if (!g) break;
        const nt = this.createTab(NEWTAB, { activate: false });
        this.addToGroup(nt.id, arg);
        this.switchTab(nt.id);
        this.focusUrlBar();
        break;
      }
      case 'reopenClosed': { const u = this.closedStack.pop(); if (u) this.createTab(u); break; }
      case 'go': if (t) { this.navigate(t, arg); } break;
      case 'back':
        if (t && t.sleep) this.switchTab(t.id);
        if (wc && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
        break;
      case 'forward': if (wc && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break;
      case 'reload':
        if (!t) break;
        if (t.view.webContents.isLoading()) t.view.webContents.stop();
        else if (t.view.webContents.getURL().startsWith('w3ir://error') && t.errorUrl) this.navigate(t, t.errorUrl);
        else t.view.webContents.reload();
        break;
      case 'home': if (t) this.navigate(t, ctx.cfg().homepage || NEWTAB); break;
      case 'focusUrl': this.focusUrlBar(); break;
      case 'bookmark': this.toggleBookmark(); break;
      case 'removeBookmark': {
        ctx.bookmarkDelete(arg);
        break;
      }
      case 'muteTab': {
        const x = this.tabs.find(x => x.id === arg);
        if (x) { x.view.webContents.setAudioMuted(!x.view.webContents.isAudioMuted()); this.push(); }
        break;
      }
      case 'toggleAdblock':
        ctx.cfg().adblock = !ctx.cfg().adblock;
        ctx.settingsStore.save();
        if (wc) wc.reload();
        ctx.pushAll();
        break;
      case 'toggleVertical':
        ctx.cfg().verticalTabs = !ctx.cfg().verticalTabs;
        ctx.settingsStore.save();
        ctx.relayoutAll();
        break;
      case 'reader': this.openReader(); break;
      case 'updateInstall': {
        const up = ctx.manager && ctx.manager.updater;
        if (!up || up.state.state !== 'ready') break;
        dialog.showMessageBox(this.win, {
          type: 'question', buttons: ['Оновити та перезапустити', 'Пізніше'], defaultId: 0, cancelId: 1,
          message: `Встановити оновлення ${up.state.version}?`,
          detail: 'Браузер закриється, і приблизно за 30 секунд нова версія встановиться та запуститься сама (під час встановлення вікон не буде — не відкривайте браузер вручну). Вкладки можна відновити через «При запуску → Відновити попередню сесію». Оновлення перевірено підписом випускача.',
        }).then(r => { if (r.response === 0) up.install(); }).catch(() => {});
        break;
      }
      case 'walletDecision': return this.decide(arg && arg.id, !!(arg && arg.approve), arg && arg.master);
      case 'githubMenu':
        if (this.overlayType === 'github') this.closeOverlay();
        else {
          const [w, h] = this.win.getContentSize();
          const y = Math.round(arg);
          this.openOverlay('github', ctx.github.panel(), { x: 0, y, width: w, height: h - y });
          ctx.github.refresh();
        }
        break;
      case 'githubRefresh': ctx.github.refresh(); break;
      case 'githubReadAll': ctx.github.markAllRead(); break;
      case 'githubOpen': {
        const url = arg && String(arg.url);
        if (!HTML_URL.test(url || '')) break;
        this.closeOverlay();
        this.createTab(url);
        if (arg.id) ctx.github.markRead(arg.id);
        break;
      }
      case 'newTabUrl': if (/^https:\/\//.test(String(arg))) this.createTab(String(arg)); break;
      case 'copyText': clipboard.writeText(String(arg).slice(0, 2000)); this.toast('Скопійовано'); break;
      case 'downloadUrl': if (wc && /^https:\/\//.test(String(arg))) wc.downloadURL(String(arg)); break;
      case 'externalUrl': if (EXTERNAL_SCHEME.test(String(arg))) this.openExternal(String(arg)); break;
      case 'vaultMenu':
        if (this.overlayType === 'vault') this.closeOverlay();
        else {
          const [w, h] = this.win.getContentSize();
          const y = Math.round(arg);
          this.openOverlay('vault', this.vaultPanel(), { x: 0, y, width: w, height: h - y });
          this.push();
        }
        break;
      case 'vaultUnlock': return this.vaultUnlock(arg);
      case 'vaultLock': ctx.vault.lock(); this.refreshVaultOverlay(); break;
      case 'vaultFill': this.vaultFill(arg); break;
      case 'vaultSaveAnswer': this.saveAnswer(arg); break;
      case 'openPage': {
        const url = 'w3ir://' + String(arg).replace(/[^a-z]/g, '');
        const existing = this.tabs.find(x => !x.sleep && x.view.webContents.getURL().startsWith(url));
        if (existing) this.switchTab(existing.id); else this.createTab(url);
        break;
      }
      case 'newWindow': ctx.openWindow({}); break;
      case 'openProfile': if (ctx.manager && ctx.manager.has(arg)) ctx.manager.open(arg); break;
      case 'newIncognito': ctx.openWindow({ incognito: true }); break;
      case 'aiShare': {
        const a = this.ai(); const tb = this.tabs.find(x => x.id === (arg && arg.id));
        if (!a || !tb) break;
        a.share(this, tb, arg.mode === 'control' ? 'control' : 'read')
          .then(() => this.toast(arg.mode === 'control' ? 'ШІ може керувати цією вкладкою' : 'ШІ може читати цю вкладку'))
          .catch((e) => this.toast(e && e.message ? e.message : 'Не вдалося поділитися вкладкою'));
        break;
      }
      case 'aiUnshare': { const a = this.ai(); const tb = this.tabs.find(x => x.id === arg); if (a && tb) a.unshareTab(this, tb); break; }
      case 'agentStop': { const a = ctx.manager && ctx.manager.ctx('default').agent; if (a) { a.disable(); this.toast('Керування браузером ШІ вимкнено'); } break; }
      case 'uiHeight': this.chromeHeight = Math.max(40, Math.min(400, Math.round(arg))); this.layout(); break;
      case 'zoomIn': if (wc) wc.setZoomLevel(Math.min(5, wc.getZoomLevel() + 0.5)); break;
      case 'zoomOut': if (wc) wc.setZoomLevel(Math.max(-4, wc.getZoomLevel() - 0.5)); break;
      case 'zoomReset': if (wc) wc.setZoomLevel(0); break;
      case 'print': if (wc) wc.print(); break;
      case 'devtools': if (wc) wc.toggleDevTools(); break;
      case 'fullscreen': this.win.setFullScreen(!this.win.isFullScreen()); break;
      case 'quit': app.quit(); break;
      case 'find': this.chrome.focus(); this.chrome.send('find-open'); break;
      case 'findText':
        if (!wc) break;
        if (!arg.text) wc.stopFindInPage('clearSelection');
        else wc.findInPage(arg.text, { forward: arg.forward !== false, findNext: !!arg.next, matchCase: !!arg.matchCase });
        break;
      case 'findStop': if (wc) { wc.stopFindInPage('clearSelection'); wc.focus(); } break;

      case 'siteInfo': {
        if (this.overlayType === 'site') { this.closeOverlay(); break; }
        const [w, h] = this.win.getContentSize();
        const y = Math.round(arg && arg.bottom || this.chromeHeight);
        this.siteX = Math.max(0, Math.round(arg && arg.left || 0));
        return this.sitePanelData().then((d) => this.openOverlay('site', { x: this.siteX, ...d }, { x: 0, y, width: w, height: h - y }));
      }
      case 'sitePerm': {
        const u = this.siteTarget();
        if (u && arg && (arg.value === true || arg.value === false || arg.value === null)) this.ctx.setSitePerm(this.ses, u.origin, arg.perm, arg.value);
        return this.refreshSiteOverlay();
      }
      case 'siteAdblock': {
        const u = this.siteTarget();
        if (u) { this.ctx.setAdblockAllowed(u.hostname, !!(arg && arg.allowed)); const wc2 = this.wc(); if (wc2) wc2.reload(); }
        this.ctx.pushAll();
        return this.refreshSiteOverlay();
      }
      case 'siteClear': {
        const u = this.siteTarget();
        if (!u) break;
        return this.ctx.clearSiteData(this.ses, u.hostname).then((n) => { this.toast(n ? `Дані сайту очищено (cookie: ${n})` : 'Дані сайту очищено'); return this.refreshSiteOverlay(); });
      }
      case 'menu':
        if (this.overlayType === 'menu') this.closeOverlay();
        else {
          const [w, h] = this.win.getContentSize();
          const y = Math.round(arg);
          this.openOverlay('menu', { items: this.menuItems().map(withTip) }, { x: 0, y, width: w, height: h - y });
        }
        break;
      case 'menuRun': this.closeOverlay(); this.exec(arg.cmd, arg.arg); break;
      case 'palette':
        if (this.overlayType === 'palette') { this.closeOverlay(); break; }
        this.openOverlay('palette', this.paletteData(arg === 'tabs' ? 'tabs' : 'all'), {});
        break;
      case 'paletteRun': {
        this.closeOverlay();
        if (arg.kind === 'tab') this.switchTab(arg.id);
        else if (arg.kind === 'cmd') this.exec(arg.cmd, arg.arg);
        else if (arg.kind === 'url') {
          if (arg.newTab || !t) this.createTab(arg.url); else this.navigate(t, arg.url);
        }
        break;
      }
      case 'showSuggest': {
        if (!arg.items.length) { this.closeSuggest(); break; }
        const rowH = 36;
        const bounds = {
          x: Math.round(arg.rect.left), y: Math.round(arg.rect.bottom) + 2,
          width: Math.round(arg.rect.width), height: arg.items.length * rowH + 10,
        };
        this.openOverlay('suggest', { items: arg.items, selected: arg.selected }, bounds);
        break;
      }
      case 'closeSuggest': this.closeSuggest(); break;
      case 'pickSuggest':
        this.closeOverlay();
        this.chrome.send('url-blur');
        if (t) { this.navigate(t, arg); t.view.webContents.focus(); }
        break;
      case 'closeOverlay': this.closeOverlay(); break;
    }
  }

  toggleBookmark() {
    const t = this.active();
    if (!t) return;
    const url = this.tabUrl(t);
    if (!/^(https?|file):/.test(url)) return;
    if (this.ctx.bookmarks().some(b => b.url === url)) this.ctx.bookmarkDelete(url);
    else this.ctx.bookmarkSet(url, (t.sleep ? t.sleep.title : t.view.webContents.getTitle()) || url);
  }

  // ---------- закриття ----------
  onClose() {
    if (this.closing) return;
    this.closing = true;
    if (!this.incognito && !this.ctx.quitting) {
      const first = [...this.ctx.windows].filter(w => !w.incognito)[0];
      if (first === this && !this.win.isMinimized() && !this.win.isFullScreen()) {
        this.ctx.windowStore.data = { ...this.win.getNormalBounds(), maximized: this.win.isMaximized() };
        this.ctx.windowStore.save();
      }
    }
  }

  onClosed() {
    try { const a = this.ai(); if (a) a.onWindowClosed(this); } catch { /* ignore */ }
    clearTimeout(this.pushTimer);
    clearInterval(this.sleepTimer);
    this.ctx.windows.delete(this);
    this.ctx.unregister(this.chrome);
    for (const t of this.tabs) {
      this.ctx.unregister(t.view.webContents);
      try { t.view.webContents.close(); } catch {}
    }
    this.ctx.unregister(this.overlay.webContents);
    try { this.overlay.webContents.close(); } catch {}
    this.tabs = [];
    if (this.incognito) {
      this.ses.clearStorageData().catch(() => {});
      this.ses.clearCache().catch(() => {});
      this.ctx.incognitoSessions.delete(this.id);
    } else {
      this.ctx.saveSession();
    }
  }
}

Object.assign(AppWindow.prototype, tabGroups.methods);

module.exports = { AppWindow, SIDEBAR_W };
