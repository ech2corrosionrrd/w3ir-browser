'use strict';
const { BrowserWindow, WebContentsView, shell, dialog, app } = require('electron');
const { t: tr } = require('./i18n');
const tabGroups = require('./tab-groups');
const splitView = require('./split-view');
const aiTabs = require('./ai-tabs');
const tabSleep = require('./tab-sleep');
const appCommands = require('./app-commands');
const appVaultUi = require('./app-vault-ui');
const appMenus = require('./app-menus');
const appExec = require('./app-exec');
const glance = require('./glance');
const { chromeIdentity } = require('./chrome-identity');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ICON = path.join(ROOT, 'build', 'icon.png');
const SIDEBAR_W = 240;
const VERTICAL_MIN_W = 720; // вужче — бічна панель забирає в адресного рядка майже всю ширину
const { SLEEP_ENV } = tabSleep;
let counter = 0;
let readabilitySrc = null;

const isBlankUrl = (u) => !u || u === 'about:blank' || /^w3ir:\/\/newtab\/?$/.test(u);
// Лише безпечні символи URL: без лапок, пробілів, <>, `, ^, |, \ та ' — щоб не «вийти» за межі аргументу зовнішньої програми
const SAFE_EXTERNAL = /^[A-Za-z0-9\-._~:\/?#\[\]@!$&()*+,;=%]+$/;
// web content must not navigate to internal w3ir:// pages (except the error/warning pages); internal -> internal is allowed
const INTERNAL_PUBLIC = /^w3ir:\/\/(error|warning)(\/|\?|#|$)/i;
const webToInternal = (from, to) => {
  const f = String(from || '');
  const t = String(to || '');
  if (/^w3ir:/i.test(t) && !/^w3ir:/i.test(f) && !INTERNAL_PUBLIC.test(t)) return true;
  if (/^file:/i.test(t) && /^https?:/i.test(f)) return true;
  return false;
};
const GESTURE_MS = 2000; // external schemes only open shortly after a real click/key in that tab
const INPUT_GESTURE = /^(mouseDown|mouseUp|rawKeyDown|keyDown|touchStart|touchEnd|gestureTap)$/;
const ANCHORED_OVERLAYS = new Set(['menu', 'vault', 'github', 'site', 'shield']); // панелі під панеллю інструментів
const { isWebUrl, NEWTAB, EXTERNAL_SCHEME } = require('./util');
const docview = require('./docview');
const containers = require('./containers');

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
    this.splitGeom = null; // геометрія розділеного екрана для інтерфейсу (межа, яку можна перетягнути)
    this.splitDrag = null;
    this.userFs = false; // користувач сам ввімкнув повний екран вікна (F11 / меню); сайт на весь екран цього не змінює
    this.split = null; // розділений екран: { a, b, ratio } — id двох вкладок поруч
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
      backgroundColor: this.incognito ? '#120a24' : (require('electron').nativeTheme.shouldUseDarkColors ? '#14122f' : '#f1f0fb'),
      webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    this.chrome = this.win.webContents;
    this.chrome.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.chrome.on('will-navigate', (e) => e.preventDefault());
    this.chrome.on('before-input-event', (e, input) => this.onKey(e, input));
    this.chrome.on('render-process-gone', (e, d) => this.recoverUi(this.chrome, d, 'chrome'));
    ctx.register(this.chrome, this);

    this.overlay = new WebContentsView({
      webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    this.overlay.setBackgroundColor('#00000000');
    this.overlay.webContents.on('before-input-event', (e, input) => this.onKey(e, input));
    this.overlay.webContents.on('will-navigate', (e) => e.preventDefault());
    this.overlay.webContents.on('render-process-gone', (e, d) => this.recoverUi(this.overlay.webContents, d, 'overlay'));
    ctx.register(this.overlay.webContents, this);
    this.overlay.webContents.loadURL('w3ir://ui/overlay.html');

    this.win.on('resize', () => {
      this.layout();
      if (this.glanceView) this.closeGlance();
      const v = this.vertical();
      if (v !== this._lastVertical) { this._lastVertical = v; this.push(); }
    });
    this.win.on('enter-full-screen', () => this.layout());
    this.win.on('leave-full-screen', () => { this.userFs = false; if (this.htmlFullscreen) this.exitHtmlFullscreen(false); else this.layout(); });
    this.win.on('close', () => this.onClose());
    this.win.on('closed', () => this.onClosed());
    this.win.once('ready-to-show', () => {
      this.win.show();
      if (opts.maximized) this.win.maximize();
    });

    this.sleepTimer = setInterval(() => this.sleepIdle(), Math.min(60000, SLEEP_ENV || 60000));
    ctx.windows.add(this);
    this.chrome.once('did-finish-load', () => {
      const urls = (opts.urls && opts.urls.length) ? opts.urls : [NEWTAB];
      const gids = this.restoreGroups(opts.groups);
      urls.forEach((u, i) => this.createTab(u, { activate: i === (opts.activeIndex || 0), pinned: !!(opts.pinned && opts.pinned[i]), container: (opts.containers && opts.containers[i]) || null, group: opts.groupOf && gids[opts.groupOf[i]] ? gids[opts.groupOf[i]] : null }));
      // пара розділеного екрана з попереднього сеансу (індекси перевіряються: сеанс міг бути пошкоджений)
      const sp = opts.split;
      if (sp && Number.isInteger(sp.a) && Number.isInteger(sp.b) && sp.a !== sp.b && this.tabs[sp.a] && this.tabs[sp.b]) {
        const keep = this.activeId;
        this.switchTab(this.tabs[sp.a].id);
        if (this.startSplit(this.tabs[sp.b].id)) this.split.ratio = Math.max(0.25, Math.min(0.75, Number(sp.ratio) || 0.5));
        if (keep != null) this.switchTab(keep);
      }
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
  verticalPref() { return !!this.ctx.cfg().verticalTabs; }
  contentWidth() { try { return this.win.getContentSize()[0]; } catch { return Infinity; } }
  // Дійсний режим: налаштування діє, лише якщо вікно достатньо широке
  vertical() { return this.verticalPref() && this.contentWidth() >= VERTICAL_MIN_W; }
  tabSes(tab) { return (tab && tab.ses) || this.ses; }
  snapshot() {
    const urls = [], pinned = [], containersOf = [], included = [];
    let active = 0;
    this.tabs.forEach(t => {
      const u = this.tabUrl(t);
      if (!u || u === 'about:blank') return;
      if (t.id === this.activeId) active = urls.length;
      urls.push(u);
      pinned.push(!!t.pinned);
      containersOf.push(t.container || null);
      included.push(t);
    });
    let split = null;
    if (this.split) {
      const ia = included.findIndex(t => t.id === this.split.a), ib = included.findIndex(t => t.id === this.split.b);
      if (ia >= 0 && ib >= 0) split = { a: ia, b: ib, ratio: this.split.ratio };
    }
    return { urls, activeIndex: active, pinned, containers: containersOf, ...this.snapshotGroups(included), split };
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
    const area = { x: left, y: top, width: Math.max(0, w - left), height: Math.max(0, h - top) };
    const pair = this.htmlFullscreen ? null : this.splitPair();
    if (pair) {
      const gap = 6;
      const lw = Math.round((area.width - gap) * this.split.ratio);
      pair.left.view.setBounds({ x: area.x, y: area.y, width: lw, height: area.height });
      pair.right.view.setBounds({ x: area.x + lw + gap, y: area.y, width: Math.max(0, area.width - lw - gap), height: area.height });
      this.splitGeom = { left: area.x, top: area.y, width: area.width, height: area.height, gap, ratio: this.split.ratio };
    } else {
      this.splitGeom = null;
      if (t) t.view.setBounds(area);
    }
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
          title: (sl ? sl.title : wc.getTitle()) || (isBlankUrl(this.tabUrl(t)) ? tr('Нова вкладка') : url || tr('Завантаження…')),
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
          container: t.container ? { id: t.container, label: tr('Контейнер «{0}»', tr(containers.info(t.container).name)), color: containers.info(t.container).color } : null,
          ai: this.aiMode(t),
          split: this.split ? (t.id === this.split.a ? 'L' : t.id === this.split.b ? 'R' : '') : '',
        };
      }),
      splitGeom: this.htmlFullscreen ? null : this.splitGeom || null,
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
  // Контейнер вкладки (cookie й сховище окремо): явний параметр, інакше успадковується від відкривача; у приватних вікнах не діє
  createTab(input, { activate = true, pinned = false, group = null, opener = null, container } = {}) {
    let cont = container !== undefined ? container : (opener && opener.container) || null;
    if (this.incognito || !containers.valid(cont)) cont = null;
    const ses = cont ? this.ctx.getContainerSession(cont) : this.ses;
    const view = new WebContentsView({
      webPreferences: {
        session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false,
        preload: path.join(ROOT, 'page-preload.js'), spellcheck: true,
      },
    });
    const tab = { id: this.nextTabId++, view, ses, container: cont, favicon: '', blocked: 0, errorUrl: '', pinned, sleep: null, lastActive: Date.now(), reader: null, doc: null, group: pinned ? null : group };
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
    const md = docview.docPathFromUrl(url);
    if (md) { this.openDoc(tab, md); return; }
    tab.view.webContents.loadURL(url).catch(() => { /* помилки показує did-fail-load */ });
  }

  // UI renderers (browser chrome, overlay): reload after a crash, at most 3 times a minute
  recoverUi(wc, d, which) {
    try { require('./crash-log'); } catch { /* ignore */ }
    if (this.closing || this.win.isDestroyed() || wc.isDestroyed() || !d || d.reason === 'clean-exit') return;
    const now = Date.now();
    const arr = (this['_uiCrash_' + which] = (this['_uiCrash_' + which] || []).filter(t => now - t < 60000));
    arr.push(now);
    if (arr.length > 3) return;
    setTimeout(() => { try { if (!wc.isDestroyed() && !this.closing) { wc.reload(); setTimeout(() => this.push(), 500); } } catch { /* ignore */ } }, 300);
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
    // відео чи звук у вкладці (навіть без звуку) не дають їй заснути
    wc.on('media-started-playing', () => { tab.playing = true; });
    wc.on('media-paused', () => { tab.playing = false; });

    wc.on('page-title-updated', (e, title) => {
      if (!this.incognito && !tab.sleep) this.ctx.historyTitle(wc.getURL(), title);
      push();
    });
    wc.on('page-favicon-updated', (e, favicons) => { if (!tab.sleep) { tab.favicon = favicons[0] || ''; push(); } });
    wc.on('did-start-navigation', (d) => {
      if (d.isMainFrame && !d.isSameDocument) { tab.blocked = 0; tab.darkKey = null; }
    });
    wc.on('dom-ready', () => { if (!tab.sleep) this.applyDark(tab); });
    chromeIdentity(wc);
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
    tab.lastInput = 0;
    wc.on('input-event', (e, ev) => { if (ev && INPUT_GESTURE.test(ev.type)) tab.lastInput = Date.now(); });
    wc.on('render-process-gone', (e, details) => {
      if (details.reason === 'clean-exit') return;
      const url = this.tabUrl(tab);
      const now = Date.now();
      tab.crashes = (tab.crashes || []).filter(t => now - t < 60000);
      tab.crashes.push(now);
      // the first crash within a minute: reload the page automatically; repeated crashes: show the error page (no reload loop)
      if (tab.crashes.length === 1 && /^(https?|file|ar):/i.test(url) && !tab.sleep) {
        setTimeout(() => { try { if (!wc.isDestroyed() && this.tabs.includes(tab)) wc.reload(); } catch { /* ignore */ } }, 300);
        return;
      }
      this.showError(tab, -1, 'RENDERER_CRASHED (' + details.reason + ')', url);
    });
    wc.on('unresponsive', () => this.onUnresponsive(tab));
    wc.on('responsive', () => { clearTimeout(tab.hangTimer); tab.hangTimer = null; });
    wc.once('destroyed', () => { clearTimeout(tab.hangTimer); tab.hangTimer = null; });
    wc.on('before-input-event', (e, input) => this.onKey(e, input));
    wc.on('focus', () => { if (this.split && this.activeId !== tab.id && (tab.id === this.split.a || tab.id === this.split.b)) this.switchTab(tab.id); });

    if (this.agent) {
      // у вікні ШІ кожен перехід, ініційований сторінкою, перевіряється: лише http(s) і лише підтверджені сайти
      const gate = (e, url) => { if (!this.ctx.agent.pageNavigation(this, tab, url, 'nav')) e.preventDefault(); };
      wc.on('will-navigate', gate);
      wc.on('will-redirect', gate);
    }
    wc.on('will-navigate', (e, url) => {
      const md = docview.docPathFromUrl(url);
      if (md && !/^https?:/i.test(wc.getURL())) { e.preventDefault(); this.openDoc(tab, md); return; }
      if (EXTERNAL_SCHEME.test(url)) { e.preventDefault(); this.openExternal(url, { tab }); }
      else if (!/^(https?|w3ir|file|about|blob|data|view-source|ar|ipfs|ipns):/i.test(url)) e.preventDefault();
      else if (webToInternal(wc.getURL(), url)) e.preventDefault();
    });
    wc.on('will-redirect', (e, url) => { if (webToInternal(wc.getURL(), url)) e.preventDefault(); });
    wc.setWindowOpenHandler((d) => {
      if (this.agent) { this.ctx.agent.pageNavigation(this, tab, d.url, 'popup'); return { action: 'deny' }; }
      if (EXTERNAL_SCHEME.test(d.url)) { this.openExternal(d.url, { tab }); return { action: 'deny' }; }
      if (webToInternal(wc.getURL(), d.url)) return { action: 'deny' };
      if (d.disposition === 'new-window') {
        return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: ICON, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } } };
      }
      if (/^(https?|w3ir|file|about|ar):/i.test(d.url)) this.createTab(d.url, { activate: d.disposition !== 'background-tab', opener: tab });
      return { action: 'deny' };
    });
    wc.on('did-create-window', (w) => {
      w.setMenuBarVisibility(false);
      // Спливаюче вікно (window.open з параметрами) не має адресного рядка, тож у заголовок завжди виводимо справжнє
      // походження сторінки (сайт не може його підробити), а навігацію обмежуємо http(s): захист від фішингу у «безадресному» вікні.
      const pc = w.webContents;
      const retitle = (title) => {
        if (w.isDestroyed()) return;
        let origin = '';
        try { origin = new URL(pc.getURL()).host; } catch { /* about:blank */ }
        w.setTitle((origin ? origin + ' — ' : '') + String(title || '').slice(0, 100));
      };
      pc.on('page-title-updated', (e, title) => { e.preventDefault(); retitle(title); });
      pc.on('did-navigate', () => retitle(pc.getTitle()));
      pc.on('will-navigate', (e, u) => { if (!/^https?:/i.test(u)) e.preventDefault(); });
      pc.setWindowOpenHandler((d) => { if (/^https?:/i.test(d.url)) this.createTab(d.url, { activate: true, opener: tab }); return { action: 'deny' }; });
    });

    wc.on('enter-html-full-screen', () => { this.htmlFullscreen = true; if (!this.win.isFullScreen()) this.win.setFullScreen(true); this.layout(); });
    wc.on('leave-html-full-screen', () => { if (!this.htmlFullscreen) return; this.htmlFullscreen = false; if (!this.userFs) this.win.setFullScreen(false); this.layout(); });
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
        type: 'info', buttons: ['OK'], message: tr('Торент-клієнт не знайдено'),
        detail: tr('Встановіть торент-клієнт (наприклад, qBittorrent або Transmission) — і magnet-посилання відкриватимуться в ньому.'),
      }).catch(() => {});
      return;
    }
    const cfg = this.ctx.cfg();
    let name = '';
    try { name = new URL(url).searchParams.get('dn') || ''; } catch {}
    if (cfg.torrentConfirm) {
      const r = await dialog.showMessageBox(this.win, {
        type: 'question', buttons: [tr('Відкрити в {0}', client), tr('Скасувати')], defaultId: 1, cancelId: 1,
        message: tr('Відкрити magnet-посилання у торент-клієнті?'),
        detail: tr('{0}Під час роздачі та завантаження торентів ваша IP-адреса видима іншим учасникам. Завантажуйте лише те, на що маєте право.', name ? name.slice(0, 200) + '\n\n' : ''),
        checkboxLabel: tr('Більше не питати'),
      });
      if (r.response !== 0) return;
      if (r.checkboxChecked) { cfg.torrentConfirm = false; this.ctx.settingsStore.save(); }
    }
    shell.openExternal(url).catch(() => this.toast('Не вдалося відкрити торент-клієнт'));
  }

  // opts.tab: the request comes from page content - then a recent real user gesture in that tab is required, and declined
  // prompts pause further prompts for a while (a page cannot spam dialogs)
  openExternal(url, opts) {
    if (opts && opts.tab && Date.now() - (opts.tab.lastInput || 0) > GESTURE_MS) return;
    if (opts && opts.tab && Date.now() < (this._extCool || 0)) return;
    if (/^magnet:/i.test(url)) { this.openMagnet(url); return; }
    if (!SAFE_EXTERNAL.test(url)) return; // символи на кшталт " або пробілів можуть зламати командний рядок обробника
    if (this._extAsk) return; // одне вікно підтвердження за раз: сторінка не може засипати діалогами
    this._extAsk = true;
    dialog.showMessageBox(this.win, {
      type: 'question', buttons: [tr('Відкрити'), tr('Скасувати')], defaultId: 1, cancelId: 1,
      message: tr('Відкрити зовнішню програму?'), detail: url.slice(0, 200),
    }).then(r => { if (r.response === 0) shell.openExternal(url); else this._extCool = Date.now() + 5000; }).catch(() => {}).finally(() => { this._extAsk = false; });
  }

  // a page that stopped responding: after 15 s offer to wait, reload or close (one dialog at a time)
  onUnresponsive(tab) {
    if (tab.hangTimer || this.closing) return;
    tab.hangTimer = setTimeout(() => {
      tab.hangTimer = null;
      const wc = tab.view.webContents;
      if (wc.isDestroyed() || !this.tabs.includes(tab) || this._hangAsk || this.win.isDestroyed()) return;
      this._hangAsk = true;
      let host = '';
      try { host = new URL(wc.getURL()).host; } catch { /* ignore */ }
      dialog.showMessageBox(this.win, {
        type: 'warning', buttons: [tr('Чекати'), tr('Перезавантажити сторінку'), tr('Закрити вкладку')], defaultId: 0, cancelId: 0,
        message: tr('Сторінка не відповідає'), detail: host.slice(0, 120),
      }).then((r) => {
        if (wc.isDestroyed() || !this.tabs.includes(tab)) return;
        if (r.response === 1) { try { wc.forcefullyCrashRenderer(); } catch { /* ignore */ } }
        else if (r.response === 2) this.closeTab(tab.id);
      }).catch(() => {}).finally(() => { this._hangAsk = false; });
    }, this.hangMs || 15000);
  }

  switchTab(id) {
    const t = this.tabs.find(t => t.id === id);
    if (!t) return;
    this.closeOverlay();
    if (this.htmlFullscreen && t.id !== this.activeId) this.exitHtmlFullscreen();
    const prev = this.active();
    const inPair = (x) => !!(this.split && x && (x.id === this.split.a || x.id === this.split.b));
    if (prev && prev !== t) {
      prev.lastActive = Date.now();
      try { prev.view.webContents.stopFindInPage('clearSelection'); } catch {}
      if (!(inPair(prev) && inPair(t))) {
        this.win.contentView.removeChildView(prev.view); // обидві вкладки пари лишаються на екрані
        if (inPair(prev)) { const mate = this.tabs.find(x => x.id === (prev.id === this.split.a ? this.split.b : this.split.a)); if (mate) this.win.contentView.removeChildView(mate.view); }
      }
      this.chrome.send('find-close');
    }
    const tg = t.group && this.groups.get(t.group);
    if (tg && tg.collapsed) tg.collapsed = false; // перехід на вкладку розгортає її групу
    this.activeId = id;
    t.lastActive = Date.now();
    if (t.sleep) this.wake(t);
    this.win.contentView.addChildView(t.view);
    if (inPair(t)) {
      const mate = this.tabs.find(x => x.id === (t.id === this.split.a ? this.split.b : this.split.a));
      if (mate) { if (mate.sleep) this.wake(mate); this.win.contentView.addChildView(mate.view); }
    }
    this.layout();
    if (!isBlankUrl(this.tabUrl(t))) t.view.webContents.focus();
    this.push();
  }

  closeTab(id) {
    const i = this.tabs.findIndex(t => t.id === id);
    if (i < 0) return;
    const tab = this.tabs[i];
    const url = this.tabUrl(tab);
    if (url && !/^w3ir:\/\/(newtab|error|reader|doc)/.test(url) && url !== 'about:blank') {
      this.closedStack.push({ url, container: tab.container });
      if (this.closedStack.length > 25) this.closedStack.shift();
    }
    if (this.tabs.length === 1) { this.win.close(); return; }
    if (this.split && (id === this.split.a || id === this.split.b)) this.endSplit();
    if (this.htmlFullscreen && id === this.activeId) this.exitHtmlFullscreen();
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
    const nt = this.createTab(this.tabUrl(t) || NEWTAB, { activate: true, container: t.container });
    const i = this.tabs.indexOf(t), j = this.tabs.indexOf(nt);
    this.tabs.splice(j, 1);
    this.tabs.splice(i + 1, 0, nt);
    nt.group = t.group || null;
    this.sortPinned();
    this.push();
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

  // ---------- перегляд документів (Markdown) ----------
  openDoc(tab, file) {
    const d = docview.loadDoc(file);
    if (!d.ok) {
      this.toast(d.error === 'size' ? 'Файл завеликий для перегляду (понад 5 МБ)' : d.error === 'binary' ? 'Це не текстовий файл' : 'Не вдалося відкрити документ');
      return;
    }
    if (tab.sleep) tab.sleep = null;
    tab.doc = { name: d.name, file: d.file, kind: d.kind, size: d.size, text: d.text };
    tab.view.webContents.loadURL('w3ir://doc').catch(() => {});
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

  // ---------- гарячі клавіші ----------
  onKey(e, input) {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const key = input.key.toLowerCase();
    if (ctrl && !input.alt && !input.shift && (key === 'c' || key === 'x' || key === 'insert')) this.ctx.clipGuard.noteSoon(); // запам'ятати скопійовану адресу (захист від підміни в буфері)
    const run = (cmd, arg) => { e.preventDefault(); this.exec(cmd, arg); };
    if (ctrl && !input.alt) {
      if (input.shift) {
        if (key === 't') return run('reopenClosed');
        if (key === 's') return run('stashTabs');
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
    if (key === 'escape' && this.htmlFullscreen) return run('fullscreen');
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
      const idx = this.ctx.sessions.indexOf(this.ses);
      if (idx >= 0) this.ctx.sessions.splice(idx, 1);
    } else {
      this.ctx.saveSession();
    }
  }
}

Object.assign(AppWindow.prototype, tabGroups.methods, splitView.methods, aiTabs.methods, tabSleep.methods, appCommands.methods, appVaultUi.methods, appMenus.methods, appExec.methods, glance.methods);

module.exports = { AppWindow, SIDEBAR_W };
