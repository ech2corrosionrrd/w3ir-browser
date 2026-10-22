'use strict';
// Виконання команд браузера (exec) і закладка поточної сторінки (методи змішуються в прототип AppWindow).
const { clipboard, dialog, app } = require('electron');
const { t: tr } = require('./i18n');
const { HTML_URL } = require('./github');
const { withTip } = require('./tips');
const { NEWTAB, EXTERNAL_SCHEME } = require('./util');
const pdf = require('./pdf');
const containers = require('./containers');

const methods = {
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
      case 'reopenClosed': { const c = this.closedStack.pop(); if (c) this.createTab(c.url, { container: c.container }); break; }
      case 'newContainerTab': if (!this.incognito && containers.valid(arg)) { const nt = this.createTab(NEWTAB, { container: arg }); if (nt) this.focusUrlBar(); } break;
      case 'openInContainer': {
        // той самий адрес у новій вкладці вибраного контейнера (arg.container === null — поза контейнером)
        const tb = this.tabs.find(x => x.id === (arg && arg.id));
        const u = tb ? this.tabUrl(tb) : '';
        if (!u || this.incognito || (arg.container !== null && !containers.valid(arg.container))) break;
        this.createTab(u, { container: arg.container });
        break;
      }
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
        this.refreshSiteOverlay();
        this.refreshShieldOverlay();
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
          type: 'question', buttons: [tr('Оновити та перезапустити'), tr('Пізніше')], defaultId: 0, cancelId: 1,
          message: tr('Встановити оновлення {0}?', up.state.version),
          detail: tr('Браузер закриється, і приблизно за 30 секунд нова версія встановиться та запуститься сама (під час встановлення вікон не буде — не відкривайте браузер вручну). Вкладки можна відновити через «При запуску → Відновити попередню сесію». Оновлення перевірено підписом випускача.'),
        }).then(r => { if (r.response === 0) up.install(); }).catch(() => {});
        break;
      }
      case 'walletDecision': return this.decide(arg && arg.id, !!(arg && arg.approve), arg && arg.master, arg && typeof arg.choice === 'string' ? arg.choice : undefined, arg && typeof arg.choice2 === 'string' ? arg.choice2 : undefined);
      case 'explainTx': return this.explainTx(arg);
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
        if (arg === 'assistant') this.assistantFrom = this.active(); // вкладка, яку помічник зможе прочитати за згодою
        if (arg === 'pdftools' && !String(this.tabUrl(this.active()) || '').startsWith('w3ir://')) this.pdfFrom = this.active(); // вкладка, яку можна зберегти в PDF із діапазоном
        const existing = this.tabs.find(x => !x.sleep && x.view.webContents.getURL().startsWith(url));
        if (existing) this.switchTab(existing.id); else this.createTab(url);
        break;
      }
      case 'sleepInactive': this.sleepNow().then((n) => this.toast(n ? tr('Приспано вкладок: {0}', n) : 'Немає неактивних вкладок, які можна приспати')); break;
      case 'newWindow': ctx.openWindow({}); break;
      case 'openProfile': if (ctx.manager && ctx.manager.has(arg)) ctx.manager.open(arg); break;
      case 'newIncognito': ctx.openWindow({ incognito: true }); break;
      case 'tabToWindow': {
        // Вкладку можна витягнути в нове вікно (меню, палітра, перетягування за межі панелі). Перезавантажується за адресою;
        // у приватних вікнах вимкнено: нове приватне вікно мало б інший тимчасовий сеанс (входи б зникли).
        if (this.agent || this.incognito || this.tabs.length < 2) break;
        const tb = this.tabs.find(x => x.id === (arg && arg.id));
        if (!tb) break;
        const u = this.tabUrl(tb);
        if (!u || u === 'about:blank') break;
        const b = this.win.getBounds();
        let pos = { x: b.x + 40, y: b.y + 40 };
        if (arg.drag) { const p = require('electron').screen.getCursorScreenPoint(); pos = { x: p.x - 120, y: p.y - 20 }; }
        ctx.openWindow({ urls: [u], containers: [tb.container || null], bounds: { x: Math.round(pos.x), y: Math.round(pos.y), width: b.width, height: b.height } });
        this.closeTab(tb.id);
        break;
      }
      case 'closeOthersInGroup': {
        const tb = this.tabs.find(x => x.id === arg);
        if (!tb || !tb.group) break;
        for (const x of this.groupTabs(tb.group)) if (x.id !== tb.id) this.closeTab(x.id);
        this.switchTab(tb.id);
        break;
      }
      case 'splitWith': this.startSplit(arg); break;
      case 'splitNew': {
        if (this.agent) break;
        const cur = this.active();
        const nt = this.createTab('w3ir://newtab', { activate: false });
        if (cur && this.startSplit(nt.id)) { this.switchTab(nt.id); this.focusUrlBar(); }
        break;
      }
      case 'splitEnd': this.endSplit(); break;
      case 'splitSwap': if (this.split) { const s = this.split; this.split = { ...s, a: s.b, b: s.a, ratio: 1 - s.ratio }; this.layout(); this.push(); } break;
      case 'splitRatio': if (this.split) { this.split.ratio = Math.max(0.25, Math.min(0.75, Number(arg) || 0.5)); this.layout(); this.push(); } break;
      case 'splitDragStart': {
        const pair = this.splitPair();
        if (!pair || this.splitDrag) break;
        pair.left.view.setVisible(false); pair.right.view.setVisible(false);
        this.splitDrag = { pair, timer: setTimeout(() => this.exec('splitDragEnd'), 15000) }; // запобіжник: сторінки не лишаться схованими
        break;
      }
      case 'splitDragEnd': {
        const d = this.splitDrag;
        if (!d) break;
        clearTimeout(d.timer);
        this.splitDrag = null;
        if (arg != null && this.split) this.split.ratio = Math.max(0.25, Math.min(0.75, Number(arg) || this.split.ratio));
        for (const t of [d.pair.left, d.pair.right]) { try { t.view.setVisible(true); } catch { /* ignore */ } }
        this.layout(); this.push();
        break;
      }
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
      case 'savePdf': {
        if (!wc) break;
        pdf.savePageAsPdf(this, wc, { pageRanges: arg && arg.pageRanges }).then((r) => {
          if (r.ok) this.toast('Сторінку збережено в PDF');
          else if (r.error === 'already-pdf') this.toast('Це вже PDF: збережіть або надрукуйте його кнопками переглядача вгорі');
          else if (r.error === 'ranges') this.toast('Некоректний діапазон сторінок');
          else if (r.error !== 'canceled') this.toast('Не вдалося зберегти сторінку в PDF');
        }).catch(() => this.toast('Не вдалося зберегти сторінку в PDF'));
        break;
      }
      case 'devtools':
        if (wc) {
          if (wc.debugger && wc.debugger.isAttached()) { try { wc.debugger.detach(); } catch { /* ignore */ } }
          wc.toggleDevTools();
        }
        break;
      case 'fullscreen': if (this.htmlFullscreen) this.exitHtmlFullscreen(); else { this.userFs = !this.win.isFullScreen(); this.win.setFullScreen(this.userFs); } break;
      case 'quit': app.quit(); break;
      case 'find': this.chrome.focus(); this.chrome.send('find-open'); break;
      case 'findText':
        if (!wc) break;
        if (!arg.text) wc.stopFindInPage('clearSelection');
        else wc.findInPage(arg.text, { forward: arg.forward !== false, findNext: !!arg.next, matchCase: !!arg.matchCase });
        break;
      case 'findStop': if (wc) { wc.stopFindInPage('clearSelection'); wc.focus(); } break;

      case 'shieldInfo': {
        if (this.overlayType === 'shield') { this.closeOverlay(); break; }
        const [w, h] = this.win.getContentSize();
        const y = Math.round(arg && arg.bottom || this.chromeHeight);
        this.shieldRight = Math.max(8, Math.round(arg && arg.right || 48));
        return this.shieldPanelData().then((d) => this.openOverlay('shield', { right: this.shieldRight, ...d }, { x: 0, y, width: w, height: h - y }));
      }
      case 'siteInfo': {
        if (this.overlayType === 'site') { this.closeOverlay(); break; }
        const [w, h] = this.win.getContentSize();
        const y = Math.round(arg && arg.bottom || this.chromeHeight);
        this.siteX = Math.max(0, Math.round(arg && arg.left || 0));
        return this.sitePanelData().then((d) => this.openOverlay('site', { x: this.siteX, ...d }, { x: 0, y, width: w, height: h - y }));
      }
      case 'sitePerm': {
        const u = this.siteTarget();
        if (u && arg && (arg.value === true || arg.value === false || arg.value === null)) this.ctx.setSitePerm(this.tabSes(this.active()), u.origin, arg.perm, arg.value);
        return this.refreshSiteOverlay();
      }
      case 'siteAdblock': {
        const u = this.siteTarget();
        if (u) { this.ctx.setAdblockAllowed(u.hostname, !!(arg && arg.allowed)); const wc2 = this.wc(); if (wc2) wc2.reload(); }
        this.ctx.pushAll();
        this.refreshSiteOverlay();
        return this.refreshShieldOverlay();
      }
      case 'siteClear': {
        const u = this.siteTarget();
        if (!u) break;
        return this.ctx.clearSiteData(this.tabSes(this.active()), u.hostname).then((n) => {
          this.toast(n ? `Дані сайту очищено (cookie: ${n})` : 'Дані сайту очищено');
          this.refreshSiteOverlay();
          return this.refreshShieldOverlay();
        });
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
  },

  toggleBookmark() {
    const t = this.active();
    if (!t) return;
    const url = this.tabUrl(t);
    if (!/^(https?|file):/.test(url)) return;
    if (this.ctx.bookmarks().some(b => b.url === url)) this.ctx.bookmarkDelete(url);
    else this.ctx.bookmarkSet(url, (t.sleep ? t.sleep.title : t.view.webContents.getTitle()) || url);
  },
};

module.exports = { methods };
