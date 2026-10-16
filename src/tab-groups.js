'use strict';
// Групи вкладок із кольорами. Вкладки групи завжди йдуть підряд; закріплені вкладки в групи не входять.
const { Menu } = require('electron');

const GROUP_COLORS = [
  { key: 'blue', name: 'синій', hex: '#5a8dee', dot: '🔵' },
  { key: 'red', name: 'червоний', hex: '#e5675f', dot: '🔴' },
  { key: 'green', name: 'зелений', hex: '#4caf8a', dot: '🟢' },
  { key: 'yellow', name: 'жовтий', hex: '#e6c84a', dot: '🟡' },
  { key: 'purple', name: 'фіолетовий', hex: '#a078f0', dot: '🟣' },
  { key: 'orange', name: 'помаранчевий', hex: '#e8923a', dot: '🟠' },
  { key: 'cyan', name: 'бірюзовий', hex: '#3aa7c9', dot: '🔹' },
  { key: 'pink', name: 'рожевий', hex: '#d96aa7', dot: '🌸' },
  { key: 'grey', name: 'сірий', hex: '#9aa0a6', dot: '⚪' },
];
const COLOR_KEYS = new Set(GROUP_COLORS.map(c => c.key));
const cleanName = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 40);
const MAX_GROUPS = 50;

// Методи змішуються в прототип AppWindow
const methods = {
  initGroups() {
    this.groups = new Map();
    this.nextGroupId = 1;
  },

  group(id) { return this.groups.get(id) || null; },
  groupTabs(id) { return this.tabs.filter(t => t.group === id); },

  // Вкладки, які видно на панелі (без згорнутих груп)
  visibleTabs() {
    return this.tabs.filter(t => !(t.group && this.groups.get(t.group) && this.groups.get(t.group).collapsed));
  },

  // Гарантує: вкладки кожної групи йдуть підряд (на місці першої вкладки групи); закріплені — без груп
  enforceGroups() {
    for (const t of this.tabs) if (t.pinned) t.group = null;
    const seen = new Set();
    const out = [];
    for (const t of this.tabs) {
      if (!t.group || !this.groups.has(t.group)) { t.group = null; out.push(t); continue; }
      if (seen.has(t.group)) continue;
      seen.add(t.group);
      for (const x of this.tabs) if (x.group === t.group) out.push(x);
    }
    this.tabs = out;
    for (const id of [...this.groups.keys()]) if (!seen.has(id)) this.groups.delete(id);
  },

  nextFreeColor() {
    const used = new Set([...this.groups.values()].map(g => g.color));
    return (GROUP_COLORS.find(c => !used.has(c.key)) || GROUP_COLORS[this.groups.size % GROUP_COLORS.length]).key;
  },

  newGroup(tabIds, { name = '', color } = {}) {
    if (this.groups.size >= MAX_GROUPS) return null;
    const tabs = tabIds.map(id => this.tabs.find(t => t.id === id)).filter(t => t && !t.pinned);
    if (!tabs.length) return null;
    const id = this.nextGroupId++;
    this.groups.set(id, { id, name: cleanName(name), color: COLOR_KEYS.has(color) ? color : this.nextFreeColor(), collapsed: false });
    // групу ставимо на місце першої з вибраних вкладок
    const orig = this.tabs.slice();
    const sel = tabs.slice().sort((x, y) => orig.indexOf(x) - orig.indexOf(y));
    const firstIdx = orig.indexOf(sel[0]);
    const at = orig.slice(0, firstIdx).filter(t => !sel.includes(t)).length;
    for (const t of sel) t.group = id;
    const rest = orig.filter(t => !sel.includes(t));
    rest.splice(at, 0, ...sel);
    this.tabs = rest;
    this.enforceGroups();
    this.push();
    return id;
  },

  addToGroup(tabId, groupId) {
    const t = this.tabs.find(x => x.id === tabId);
    const g = this.groups.get(groupId);
    if (!t || !g || t.pinned) return false;
    this.tabs = this.tabs.filter(x => x !== t);
    t.group = groupId;
    let last = -1;
    this.tabs.forEach((x, i) => { if (x.group === groupId) last = i; });
    this.tabs.splice(last + 1, 0, t);
    this.enforceGroups();
    this.push();
    return true;
  },

  removeFromGroup(tabId) {
    const t = this.tabs.find(x => x.id === tabId);
    if (!t || !t.group) return false;
    const gid = t.group;
    this.tabs = this.tabs.filter(x => x !== t);
    t.group = null;
    let last = -1;
    this.tabs.forEach((x, i) => { if (x.group === gid) last = i; });
    this.tabs.splice(last < 0 ? this.tabs.length : last + 1, 0, t); // вкладка стає одразу після групи
    this.enforceGroups();
    this.push();
    return true;
  },

  ungroup(groupId) {
    for (const t of this.groupTabs(groupId)) t.group = null;
    this.groups.delete(groupId);
    this.push();
  },

  closeGroup(groupId) {
    for (const t of this.groupTabs(groupId)) this.closeTab(t.id);
    this.enforceGroups();
    this.push();
  },

  setGroupName(groupId, name) {
    const g = this.groups.get(groupId);
    if (!g) return false;
    g.name = cleanName(name);
    this.push();
    return true;
  },

  setGroupColor(groupId, color) {
    const g = this.groups.get(groupId);
    if (!g || !COLOR_KEYS.has(color)) return false;
    g.color = color;
    this.push();
    return true;
  },

  // Згортання: якщо активна вкладка належить групі — переходимо на сусідню поза групою (або не згортаємо)
  setGroupCollapsed(groupId, collapsed) {
    const g = this.groups.get(groupId);
    if (!g) return false;
    if (collapsed && this.activeId != null) {
      const act = this.tabs.find(t => t.id === this.activeId);
      if (act && act.group === groupId) {
        const outside = this.tabs.filter(t => t.group !== groupId && !(t.group && this.groups.get(t.group).collapsed));
        if (!outside.length) { this.toast('Не можна згорнути єдину групу з активною вкладкою'); return false; }
        const idx = this.tabs.indexOf(act);
        const after = this.tabs.slice(idx).find(t => outside.includes(t));
        const before = [...this.tabs.slice(0, idx)].reverse().find(t => outside.includes(t));
        g.collapsed = true;
        this.switchTab((after || before).id);
        return true;
      }
    }
    g.collapsed = !!collapsed;
    this.push();
    return true;
  },

  moveGroup(groupId, index) {
    if (!this.groups.has(groupId)) return false;
    const members = this.groupTabs(groupId);
    const target = this.tabs[Math.max(0, Math.min(index, this.tabs.length - 1))];
    const rest = this.tabs.filter(t => t.group !== groupId);
    let at = target && target.group !== groupId ? rest.indexOf(target) : rest.length;
    if (target && target.group && target.group !== groupId) at = rest.findIndex(t => t.group === target.group); // перед усією цільовою групою
    at = Math.max(rest.filter(t => t.pinned).length, at < 0 ? rest.length : at);
    rest.splice(at, 0, ...members);
    this.tabs = rest;
    this.enforceGroups();
    this.push();
    return true;
  },

  // Після переміщення вкладки: між двома вкладками однієї групи — приєднується, поза групою — виходить із неї
  adjustGroupAfterMove(t) {
    const i = this.tabs.indexOf(t);
    const left = this.tabs[i - 1], right = this.tabs[i + 1];
    if (t.pinned) { t.group = null; return; }
    if (left && right && left.group && left.group === right.group) t.group = left.group;
    else if (t.group && !((left && left.group === t.group) || (right && right.group === t.group))) t.group = null;
  },

  groupList() {
    const seen = [];
    for (const t of this.tabs) if (t.group && !seen.includes(t.group)) seen.push(t.group);
    return seen.map(id => {
      const g = this.groups.get(id);
      const c = GROUP_COLORS.find(x => x.key === g.color) || GROUP_COLORS[0];
      return { id, name: g.name, color: g.color, hex: c.hex, collapsed: g.collapsed, count: this.groupTabs(id).length };
    });
  },

  // Для збереження сесії (порядок груп = порядок появи)
  snapshotGroups(includedTabs) {
    const order = [];
    const groupOf = includedTabs.map(t => {
      if (!t.group || !this.groups.has(t.group)) return -1;
      let i = order.indexOf(t.group);
      if (i < 0) { order.push(t.group); i = order.length - 1; }
      return i;
    });
    return { groups: order.map(id => { const g = this.groups.get(id); return { name: g.name, color: g.color, collapsed: g.collapsed }; }), groupOf };
  },

  restoreGroups(defs) {
    const ids = [];
    for (const d of (Array.isArray(defs) ? defs : []).slice(0, MAX_GROUPS)) {
      const id = this.nextGroupId++;
      this.groups.set(id, { id, name: cleanName(d && d.name), color: d && COLOR_KEYS.has(d.color) ? d.color : this.nextFreeColor(), collapsed: !!(d && d.collapsed) });
      ids.push(id);
    }
    return ids;
  },

  // ---------- меню ----------
  groupMenu(groupId) {
    const g = this.groups.get(groupId);
    if (!g) return;
    Menu.buildFromTemplate([
      { label: 'Перейменувати групу', click: () => this.chrome.send('group-edit', { id: groupId }) },
      { label: 'Колір групи', submenu: GROUP_COLORS.map(c => ({ label: `${c.dot} ${c.name}`, type: 'radio', checked: c.key === g.color, click: () => this.setGroupColor(groupId, c.key) })) },
      { label: g.collapsed ? 'Розгорнути групу' : 'Згорнути групу', click: () => this.setGroupCollapsed(groupId, !g.collapsed) },
      { label: 'Нова вкладка в групі', click: () => this.exec('groupNewTab', groupId) },
      { type: 'separator' },
      { label: 'Розгрупувати', click: () => this.ungroup(groupId) },
      { label: 'Закрити групу', click: () => this.closeGroup(groupId) },
    ]).popup({ window: this.win });
  },

  // пункти групової частини меню вкладки
  tabGroupMenuItems(tab) {
    if (tab.pinned) return [];
    const items = [{ label: 'Додати до нової групи', click: () => { const id = this.newGroup([tab.id]); if (id) this.chrome.send('group-edit', { id }); } }];
    const others = this.groupList().filter(g => g.id !== tab.group);
    if (others.length) {
      items.push({
        label: 'Додати до групи',
        submenu: others.map(g => {
          const c = GROUP_COLORS.find(x => x.key === g.color) || GROUP_COLORS[0];
          return { label: `${c.dot} ${g.name || 'Без назви'} (${g.count})`, click: () => this.addToGroup(tab.id, g.id) };
        }),
      });
    }
    if (tab.group) {
      items.push({ label: 'Видалити з групи', click: () => this.removeFromGroup(tab.id) });
      items.push({ label: 'Закрити інші вкладки групи', enabled: this.groupTabs(tab.group).length > 1, click: () => this.exec('closeOthersInGroup', tab.id) });
    }
    return items;
  },
};

module.exports = { methods, GROUP_COLORS, COLOR_KEYS, cleanName };
