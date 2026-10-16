'use strict';
// Розділений екран (дві вкладки поруч) і вихід із повноекранного режиму сайту.

// Методи змішуються в прототип AppWindow
const methods = {
  // Вихід із повноекранного режиму сайту (відео тощо): скидає прапорець, закриває його в усіх вкладках і повертає інтерфейс
  exitHtmlFullscreen(leaveWindow = true) {
    const was = this.htmlFullscreen;
    this.htmlFullscreen = false;
    for (const t of this.tabs) {
      try { if (!t.view.webContents.isDestroyed()) t.view.webContents.executeJavaScript('document.fullscreenElement && document.exitFullscreen && document.exitFullscreen()', true).catch(() => {}); } catch { /* ignore */ }
    }
    if (was && leaveWindow && !this.userFs && this.win.isFullScreen()) this.win.setFullScreen(false);
    this.layout();
    this.push();
  },

  // ---------- розділений екран ----------
  splitPair() {
    const s = this.split;
    if (!s) return null;
    const a = this.tabs.find(t => t.id === s.a), b = this.tabs.find(t => t.id === s.b);
    if (!a || !b) { this.split = null; return null; }
    if (this.activeId !== a.id && this.activeId !== b.id) return null;
    return { left: a, right: b };
  },

  // Показує активну вкладку й вкладку partnerId поруч
  startSplit(partnerId) {
    const act = this.active();
    const p = this.tabs.find(t => t.id === partnerId);
    if (!act || !p || act === p || this.agent) return false;
    if (this.split) this.endSplit();
    this.split = { a: act.id, b: p.id, ratio: 0.5 };
    if (p.sleep) this.wake(p);
    this.win.contentView.addChildView(act.view);
    this.win.contentView.addChildView(p.view);
    this.layout();
    this.push();
    return true;
  },

  endSplit() {
    const s = this.split;
    if (!s) return;
    if (this.splitDrag) this.exec('splitDragEnd');
    this.split = null;
    for (const t of this.tabs) if ((t.id === s.a || t.id === s.b) && t.id !== this.activeId) { try { this.win.contentView.removeChildView(t.view); } catch { /* ignore */ } }
    this.layout();
    this.push();
  },

  splitMenuItems(t) {
    if (this.agent) return [];
    if (this.split) return (t.id === this.split.a || t.id === this.split.b) ? [{ label: 'Закрити розділений екран', click: () => this.exec('splitEnd') }] : [];
    return t.id !== this.activeId ? [{ label: 'Показати поруч з активною вкладкою', click: () => this.exec('splitWith', t.id) }] : [];
  },

  splitCommands() {
    if (this.agent) return [];
    if (!this.split) return [{ label: 'Розділений екран: нова вкладка поруч', cmd: 'splitNew' }];
    return [
      { label: 'Закрити розділений екран', cmd: 'splitEnd' },
      { label: 'Розділений екран: поміняти панелі місцями', cmd: 'splitSwap' },
      { label: 'Розділений екран: пропорція 50 / 50', cmd: 'splitRatio', arg: 0.5 },
      { label: 'Розділений екран: ширша ліва панель (60 / 40)', cmd: 'splitRatio', arg: 0.6 },
      { label: 'Розділений екран: ширша права панель (40 / 60)', cmd: 'splitRatio', arg: 0.4 },
    ];
  },
};

module.exports = { methods };
