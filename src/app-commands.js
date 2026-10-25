'use strict';
// Команди браузера, списки палітри швидкого пошуку (Ctrl+K) та головного меню.
const { t: tr } = require('./i18n');
const { withTip } = require('./tips');
const containers = require('./containers');

const methods = {
  commandList() {
    const vert = this.verticalPref();
    const ad = this.ctx.cfg().adblock;
    return [
      ...this.githubCommands(),
      { label: tr('Нова вкладка'), hint: 'Ctrl+T', cmd: 'newTab' },
      ...(this.incognito || this.agent ? [] : containers.CONTAINERS.map(c => ({ label: tr('Нова вкладка в контейнері «{0}»', tr(c.name)), cmd: 'newContainerTab', arg: c.id }))),
      { label: tr('Нове вікно'), hint: 'Ctrl+N', cmd: 'newWindow' },
      { label: tr('Нове вікно інкогніто'), hint: 'Ctrl+Shift+N', cmd: 'newIncognito' },
      ...this.splitCommands(),
      ...this.aiCommands(),
      { label: tr('Закрити вкладку'), hint: 'Ctrl+W', cmd: 'closeTab', arg: this.activeId },
      { label: tr('Відновити закриту вкладку'), hint: 'Ctrl+Shift+T', cmd: 'reopenClosed' },
      { label: tr('Відкласти вкладки (Tab Stash)'), hint: 'Ctrl+Shift+S', cmd: 'stashTabs' },
      { label: tr('Відновити останній набір вкладок'), cmd: 'restoreStash' },
      { label: tr('Закріпити / відкріпити вкладку'), cmd: 'pinTab', arg: this.activeId },
      { label: tr('Дублювати вкладку'), cmd: 'duplicateTab', arg: this.activeId },
      ...(this.tabs.length > 1 && !this.incognito && !this.agent ? [{ label: tr('Перемістити вкладку в нове вікно'), cmd: 'tabToWindow', arg: { id: this.activeId } }] : []),
      ...(this.active() && this.active().group && this.groupTabs(this.active().group).length > 1 ? [{ label: tr('Закрити інші вкладки групи'), cmd: 'closeOthersInGroup', arg: this.activeId }] : []),
      { label: tr('Нова група з поточної вкладки'), cmd: 'groupNew', arg: this.activeId },
      ...this.groupList().map(g => ({ label: tr('Перейти до групи «{0}»', g.name || 'Без назви'), cmd: 'groupFocus', arg: g.id })),
      { label: tr('Режим читання'), hint: 'Ctrl+Shift+R', cmd: 'reader' },
      { label: vert ? tr('Горизонтальні вкладки') : tr('Вертикальні вкладки'), cmd: 'toggleVertical' },
      { label: ad ? tr('Вимкнути блокування реклами') : tr('Увімкнути блокування реклами'), cmd: 'toggleAdblock' },
      { label: tr('Закладка для цієї сторінки'), hint: 'Ctrl+D', cmd: 'bookmark' },
      { label: tr('Знайти на сторінці'), hint: 'Ctrl+F', cmd: 'find' },
      { label: tr('Закладки'), hint: 'Ctrl+Shift+O', cmd: 'openPage', arg: 'bookmarks' },
      { label: tr('Історія'), hint: 'Ctrl+H', cmd: 'openPage', arg: 'history' },
      { label: tr('Завантаження'), hint: 'Ctrl+J', cmd: 'openPage', arg: 'downloads' },
      { label: tr('PDF-інструменти'), cmd: 'openPage', arg: 'pdftools' },
      { label: tr('Менеджер паролів'), cmd: 'openPage', arg: 'passwords' },
      { label: tr('Панель (стан браузера)'), cmd: 'openPage', arg: 'dashboard' },
      { label: tr('ШІ-помічник (локальна модель)'), cmd: 'openPage', arg: 'assistant' },
      ...(this.ctx.cfg().walletHidden ? [] : [{ label: tr('Гаманець (Web3)'), cmd: 'openPage', arg: 'wallet' }]),
      { label: tr('Імпорт з Chrome / Firefox'), cmd: 'openPage', arg: 'import' },
      { label: tr('Керування профілями'), cmd: 'openPage', arg: 'profiles' },
      ...(this.ctx.manager ? this.ctx.manager.list().filter(p => p.id !== this.ctx.id).map(p => ({ label: tr('Перейти до профілю «{0}»', p.name), cmd: 'openProfile', arg: p.id })) : []),
      { label: tr('Заблокувати сховище паролів'), cmd: 'vaultLock' },
      { label: tr('Налаштування'), cmd: 'openPage', arg: 'settings' },
      { label: tr('Збільшити масштаб'), hint: 'Ctrl++', cmd: 'zoomIn' },
      { label: tr('Зменшити масштаб'), hint: 'Ctrl+−', cmd: 'zoomOut' },
      { label: tr('Скинути масштаб'), hint: 'Ctrl+0', cmd: 'zoomReset' },
      { label: tr('Друк…'), hint: 'Ctrl+P', cmd: 'print' },
      { label: tr('Зберегти сторінку як PDF…'), cmd: 'savePdf' },
      { label: tr('На весь екран'), hint: 'F11', cmd: 'fullscreen' },
      { label: tr('Інструменти розробника'), hint: 'F12', cmd: 'devtools' },
      { label: tr('Довідка'), hint: 'F1', cmd: 'openPage', arg: 'help' },
      ...(this.agentOn() ? [{ label: tr('Зупинити керування браузером ШІ'), cmd: 'agentStop' }] : []),
      { label: tr('Вийти'), cmd: 'quit' },
    ];
  },

  menuItems() {
    const wc = this.wc();
    const zoom = wc ? Math.round(Math.pow(1.2, wc.getZoomLevel()) * 100) : 100;
    const up = this.ctx.manager && this.ctx.manager.updater ? this.ctx.manager.updater.brief() : null;
    return [
      ...(up && up.state === 'ready' ? [{ label: tr('Оновити браузер до {0} (перезапуск)', up.version), cmd: 'updateInstall' }, { sep: true }] : []),
      { label: tr('Нова вкладка'), hint: 'Ctrl+T', cmd: 'newTab' },
      { label: tr('Відкласти вкладки (Tab Stash)'), hint: 'Ctrl+Shift+S', cmd: 'stashTabs' },
      { label: tr('Нове вікно'), hint: 'Ctrl+N', cmd: 'newWindow' },
      { label: tr('Нове вікно інкогніто'), hint: 'Ctrl+Shift+N', cmd: 'newIncognito' },
      { label: tr('Профілі…'), cmd: 'openPage', arg: 'profiles' },
      { sep: true },
      { label: tr('Пошук по вкладках і командах'), hint: 'Ctrl+K', cmd: 'palette' },
      { label: tr('Режим читання'), hint: 'Ctrl+Shift+R', cmd: 'reader' },
      { label: this.vertical() ? tr('Горизонтальні вкладки') : tr('Вертикальні вкладки'), cmd: 'toggleVertical' },
      { sep: true },
      { label: tr('Закладки'), hint: 'Ctrl+Shift+O', cmd: 'openPage', arg: 'bookmarks' },
      { label: tr('Історія'), hint: 'Ctrl+H', cmd: 'openPage', arg: 'history' },
      { label: tr('Завантаження'), hint: 'Ctrl+J', cmd: 'openPage', arg: 'downloads' },
      { label: tr('PDF-інструменти'), cmd: 'openPage', arg: 'pdftools' },
      { label: tr('Менеджер паролів'), cmd: 'openPage', arg: 'passwords' },
      { label: tr('Панель (стан браузера)'), cmd: 'openPage', arg: 'dashboard' },
      ...(this.ctx.cfg().walletHidden ? [] : [{ label: tr('Гаманець (Web3)'), cmd: 'openPage', arg: 'wallet' }]),
      { sep: true },
      { label: tr('Збільшити'), hint: 'Ctrl++', cmd: 'zoomIn' },
      { label: tr('Зменшити'), hint: 'Ctrl+−', cmd: 'zoomOut' },
      { label: tr('Скинути масштаб ({0}%)', zoom), hint: 'Ctrl+0', cmd: 'zoomReset' },
      { label: tr('Знайти на сторінці'), hint: 'Ctrl+F', cmd: 'find' },
      { label: tr('Друк…'), hint: 'Ctrl+P', cmd: 'print' },
      { label: tr('Зберегти сторінку як PDF…'), cmd: 'savePdf' },
      { label: tr('На весь екран'), hint: 'F11', cmd: 'fullscreen' },
      { label: tr('Інструменти розробника'), hint: 'F12', cmd: 'devtools' },
      { sep: true },
      { label: tr('Імпорт з Chrome / Firefox'), cmd: 'openPage', arg: 'import' },
      { label: tr('Налаштування'), cmd: 'openPage', arg: 'settings' },
      { label: tr('Довідка'), hint: 'F1', cmd: 'openPage', arg: 'help' },
      { label: tr('Вийти'), cmd: 'quit' },
    ];
  },

  paletteData(mode) {
    const ctx = this.ctx;
    const tabs = this.tabs.map(t => {
      const g = t.group && this.groups.get(t.group);
      const title = t.sleep ? t.sleep.title : t.view.webContents.getTitle();
      return { id: t.id, title: (g && g.name ? `[${g.name}] ` : '') + title, url: this.displayUrl(t) };
    });
    if (mode === 'tabs') return { mode, tabs };
    const history = ctx.places.recentDistinct(300);
    return {
      mode, tabs, commands: this.commandList().map(withTip),
      bookmarks: ctx.bookmarks().slice(0, 300).map(b => ({ title: b.title, url: b.url })),
      history,
    };
  },
};

module.exports = { methods };
