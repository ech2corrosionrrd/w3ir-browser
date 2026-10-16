'use strict';
// Доступ ШІ (Claude Code через MCP) до вкладок користувача: меню вкладки, команди палітри, значок.
const { isWebUrl } = require('./util');
const { t: tr } = require('./i18n');

// Методи змішуються в прототип AppWindow
const methods = {
  aiMode(tab) { const a = this.ai(); return a && !this.incognito ? a.shareMode(this, tab) : ''; },

  // Агент керування ШІ живе в основному профілі; null, якщо недоступний
  ai() { const m = this.ctx.manager; return (m ? m.ctx('default') : this.ctx).agent || null; },

  // Команди палітри для поточної вкладки
  aiCommands() {
    const a = this.ai(); const t = this.active();
    if (!a || !t || this.incognito || this.agent || !a.state.enabled || !isWebUrl(this.tabUrl(t))) return [];
    const mode = a.shareMode(this, t);
    return mode ? [{ label: tr('ШІ: припинити доступ до цієї вкладки'), cmd: 'aiUnshare', arg: t.id }] : [
      { label: tr('ШІ: дозволити читати цю вкладку'), cmd: 'aiShare', arg: { id: t.id, mode: 'read' } },
      { label: tr('ШІ: дозволити керувати цією вкладкою'), cmd: 'aiShare', arg: { id: t.id, mode: 'control' } },
    ];
  },

  agentOn() { const m = this.ctx.manager; const a = m && m.ctx('default').agent; return !!(a && a.state.enabled); },

  // Пункти «ШІ» у меню вкладки: поділитися (читання/керування) або припинити
  aiMenuItems(t) {
    const a = this.ai();
    if (!a || this.incognito || this.agent || !a.state.enabled || !isWebUrl(this.tabUrl(t))) return [];
    const mode = a.shareMode(this, t);
    return [
      { type: 'separator' },
      ...(mode ? [{ label: tr('ШІ: припинити доступ до цієї вкладки'), click: () => this.exec('aiUnshare', t.id) }] : []),
      ...(mode !== 'read' ? [{ label: tr('ШІ: дозволити читати цю вкладку'), click: () => this.exec('aiShare', { id: t.id, mode: 'read' }) }] : []),
      ...(mode !== 'control' ? [{ label: tr('ШІ: дозволити керувати цією вкладкою…'), click: () => this.exec('aiShare', { id: t.id, mode: 'control' }) }] : []),
      { type: 'separator' },
    ];
  },
};

module.exports = { methods };
