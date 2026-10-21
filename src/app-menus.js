'use strict';
// Панель «Інформація про сайт», меню вкладки й контекстне меню (методи змішуються в прототип AppWindow).
const { Menu, clipboard } = require('electron');
const { t: tr } = require('./i18n');
const { githubRepo } = require('./github');
const { ASK } = require('./context');
const { isWebUrl } = require('./util');
const containers = require('./containers');

const methods = {
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
    if (web) { try { cookies = (await this.ctx.siteCookies(this.tabSes(t), host)).length; } catch { /* ignore */ } }
    return {
      kind, host, incognito: this.incognito,
      container: t && t.container ? tr('Контейнер «{0}»: cookie й сховище цього сайту окремі від інших вкладок.', tr(containers.info(t.container).name)) : null,
      perms: web ? this.ctx.sitePerms(this.tabSes(t), u.origin) : null,
      permLabels: ASK,
      adblock: { enabled: this.ctx.cfg().adblock !== false, allowed: web ? this.ctx.adblockAllowed(host) : false, blocked: t ? t.blocked : 0 },
      cookies,
    };
  },

  async refreshSiteOverlay() {
    if (this.overlayType === 'site' && !this.win.isDestroyed()) this.overlay.webContents.send('overlay', { type: 'site', x: this.siteX || 0, ...(await this.sitePanelData()) });
  },

  siteTarget() {
    const t = this.active();
    try { const u = new URL(this.tabUrl(t)); return /^https?:$/.test(u.protocol) ? u : null; } catch { return null; }
  },

  refreshGithubOverlay() {
    if (this.overlayType === 'github' && !this.win.isDestroyed()) this.overlay.webContents.send('overlay', { type: 'github', ...this.ctx.github.panel() });
  },

  // Команди для сторінок репозиторіїв GitHub (з'являються в палітрі Ctrl+K)
  githubCommands() {
    const t = this.active();
    const url = t ? this.tabUrl(t) : '';
    const gr = githubRepo(url);
    if (!gr) return [];
    const base = `https://github.com/${gr.owner}/${gr.repo}`;
    const name = `${gr.owner}/${gr.repo}`;
    const cmds = [
      { label: tr('GitHub: копіювати git clone (HTTPS) — {0}', name), cmd: 'copyText', arg: `git clone ${base}.git` },
      { label: tr('GitHub: копіювати git clone (SSH) — {0}', name), cmd: 'copyText', arg: `git clone git@github.com:${gr.owner}/${gr.repo}.git` },
      { label: tr('GitHub: завантажити ZIP — {0}', name), cmd: 'downloadUrl', arg: `${base}/archive/HEAD.zip` },
      { label: tr('GitHub: відкрити в github.dev (редактор) — {0}', name), cmd: 'newTabUrl', arg: `https://github.dev/${gr.owner}/${gr.repo}` },
      { label: `GitHub: Issues — ${name}`, cmd: 'newTabUrl', arg: `${base}/issues` },
      { label: `GitHub: Pull requests — ${name}`, cmd: 'newTabUrl', arg: `${base}/pulls` },
      { label: `GitHub: Actions — ${name}`, cmd: 'newTabUrl', arg: `${base}/actions` },
      { label: `GitHub: Releases — ${name}`, cmd: 'newTabUrl', arg: `${base}/releases` },
      { label: tr('GitHub: відкрити в GitHub Desktop — {0}', name), cmd: 'externalUrl', arg: `x-github-client://openRepo/${base}` },
      { label: tr('GitHub: відкрити у VS Code — {0}', name), cmd: 'externalUrl', arg: `vscode://vscode.git/clone?url=${encodeURIComponent(base + '.git')}` },
    ];
    if (gr.kind === 'blob' && gr.rest.length >= 2) {
      const [branch, ...file] = gr.rest;
      cmds.unshift({ label: tr('GitHub: відкрити Raw-файл'), cmd: 'newTabUrl', arg: `https://raw.githubusercontent.com/${gr.owner}/${gr.repo}/${branch}/${file.join('/')}` });
    }
    return cmds;
  },

  // ---------- меню вкладки та контекстне меню ----------
  // Пункти «Відкрити в контейнері»: нова вкладка з тією самою адресою в іншому сховищі cookie (не для приватних вікон)
  containerMenuItems(t) {
    if (this.incognito || this.agent || !isWebUrl(this.tabUrl(t))) return [];
    const items = containers.CONTAINERS.filter(c => c.id !== t.container).map(c => ({ label: tr(c.name), click: () => this.exec('openInContainer', { id: t.id, container: c.id }) }));
    if (t.container) items.unshift({ label: tr('Без контейнера'), click: () => this.exec('openInContainer', { id: t.id, container: null }) });
    return [{ label: tr('Відкрити в контейнері'), submenu: items }, { type: 'separator' }];
  },

  tabMenu(id) {
    const t = this.tabs.find(t => t.id === id);
    if (!t) return;
    const i = this.tabs.indexOf(t);
    Menu.buildFromTemplate([
      { label: t.pinned ? tr('Відкріпити вкладку') : tr('Закріпити вкладку'), click: () => this.exec('pinTab', id) },
      { label: t.view.webContents.isAudioMuted() ? tr('Увімкнути звук') : tr('Вимкнути звук'), click: () => this.exec('muteTab', id) },
      { label: tr('Дублювати'), click: () => this.exec('duplicateTab', id) },
      { label: tr('Перемістити в нове вікно'), enabled: this.tabs.length > 1 && !this.incognito && !this.agent, click: () => this.exec('tabToWindow', { id }) },
      { label: tr('Приспати вкладку'), enabled: id !== this.activeId && isWebUrl(this.tabUrl(t)) && !t.sleep, click: () => this.sleepTab(t) },
      { type: 'separator' },
      ...(t.pinned ? [] : [...this.tabGroupMenuItems(t), { type: 'separator' }]),
      ...this.containerMenuItems(t),
      ...this.splitMenuItems(t),
      ...this.aiMenuItems(t),
      { label: tr('Закрити'), click: () => this.closeTab(id) },
      { label: tr('Закрити інші'), enabled: this.tabs.length > 1, click: () => this.exec('closeOthers', id) },
      { label: tr('Закрити вкладки праворуч'), enabled: i < this.tabs.length - 1, click: () => this.exec('closeRight', id) },
    ]).popup({ window: this.win });
  },

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
      t.push({ label: tr('Відкрити посилання в новій вкладці'), click: () => this.createTab(p.linkURL, { activate: false }) });
      if (!this.incognito && !this.agent && isWebUrl(p.linkURL)) t.push({ label: tr('Відкрити посилання в контейнері'), submenu: containers.CONTAINERS.map(c => ({ label: tr(c.name), click: () => this.createTab(p.linkURL, { container: c.id }) })) });
      t.push({ label: tr('Відкрити посилання в інкогніто'), click: () => this.ctx.openWindow({ incognito: true, urls: [p.linkURL] }) });
      t.push({ label: tr('Копіювати адресу посилання'), click: () => clipboard.writeText(p.linkURL) });
      t.push({ type: 'separator' });
    }
    if (p.mediaType === 'image' && p.srcURL) {
      t.push({ label: tr('Відкрити зображення в новій вкладці'), click: () => this.createTab(p.srcURL, { activate: false }) });
      t.push({ label: tr('Зберегти зображення як…'), click: () => wc.downloadURL(p.srcURL) });
      t.push({ label: tr('Копіювати зображення'), click: () => wc.copyImageAt(p.x, p.y) });
      t.push({ label: tr('Копіювати адресу зображення'), click: () => clipboard.writeText(p.srcURL) });
      t.push({ type: 'separator' });
    }
    if (p.isEditable) {
      t.push({ role: 'undo', label: tr('Скасувати') }, { role: 'redo', label: tr('Повторити') }, { type: 'separator' });
      t.push({ role: 'cut', label: tr('Вирізати'), click: () => { wc.cut(); this.ctx.clipGuard.noteSoon(); } }, { role: 'copy', label: tr('Копіювати'), click: () => { wc.copy(); this.ctx.clipGuard.noteSoon(); } }, { role: 'paste', label: tr('Вставити') });
      t.push({ role: 'selectAll', label: tr('Виділити все') });
    } else if (p.selectionText) {
      t.push({ role: 'copy', label: tr('Копіювати'), click: () => { wc.copy(); this.ctx.clipGuard.noteSoon(); } });
      const sel = p.selectionText.trim();
      const short = sel.length > 30 ? sel.slice(0, 30) + '…' : sel;
      t.push({
        label: tr('Шукати «{0}» ({1})', short, engine.name),
        click: () => this.createTab(engine.url.replace('%s', encodeURIComponent(sel))),
      });
    } else if (!p.linkURL && p.mediaType !== 'image') {
      t.push({ label: tr('Назад'), enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() });
      t.push({ label: tr('Вперед'), enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() });
      t.push({ label: tr('Оновити'), click: () => this.exec('reload') });
      t.push({ type: 'separator' });
      t.push({ label: tr('Зберегти як закладку'), click: () => this.exec('bookmark') });
      t.push({ label: tr('Режим читання'), enabled: isWebUrl(this.tabUrl(tab)), click: () => this.openReader() });
      t.push({ label: tr('Друк…'), click: () => wc.print() });
      t.push({ label: tr('Зберегти сторінку як PDF…'), click: () => this.exec('savePdf') });
      const url = this.tabUrl(tab);
      if (isWebUrl(url)) t.push({ label: tr('Переглянути код сторінки'), click: () => this.createTab('view-source:' + url) });
    }
    t.push({ type: 'separator' });
    t.push({ label: tr('Дослідити елемент'), click: () => wc.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(t).popup({ window: this.win });
  },
};

module.exports = { methods };
