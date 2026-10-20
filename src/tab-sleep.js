'use strict';
// Керування сплячими вкладками для економії пам'яті:
// автоматичний перехід у сон після періоду неактивності та відновлення стану.
const { isWebUrl } = require('./util');

const SLEEP_ENV = Number(process.env.W3IR_SLEEP_MS) || 0; // перекриває налаштування (для тестів)
const SLEEP_MINUTES = [5, 15, 30, 60, 120];

const methods = {
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
  },

  wake(tab) {
    const s = tab.sleep;
    tab.sleep = null;
    tab.favicon = s.favicon;
    const wc = tab.view.webContents;
    const fallback = () => wc.loadURL(s.url).catch(() => {});
    try {
      Promise.resolve(wc.navigationHistory.restore({ index: s.index, entries: s.entries })).catch(fallback);
    } catch { fallback(); }
  },

  // через скільки неактивна вкладка засинає: налаштування «sleepMinutes» (5–120 хв), типово 15
  sleepDelay() {
    if (SLEEP_ENV) return SLEEP_ENV;
    const m = Number(this.ctx.cfg().sleepMinutes);
    return (SLEEP_MINUTES.includes(m) ? m : 15) * 60 * 1000;
  },

  // Чи є на сторінці незбережене введення (текст у полях, змінені прапорці/списки): сон знищив би його
  async hasUnsavedInput(tab) {
    const wc = tab.view.webContents;
    const probe = wc.executeJavaScript(`(() => { try { return [...document.querySelectorAll('input,textarea,select')].some(e => {
      if (e.tagName === 'SELECT') return [...e.options].some(o => o.selected !== o.defaultSelected);
      if (e.type === 'checkbox' || e.type === 'radio') return e.checked !== e.defaultChecked;
      if (['hidden', 'button', 'submit', 'reset', 'image', 'file'].includes(e.type)) return false;
      return e.value !== e.defaultValue && e.value !== '';
    }) || [...document.querySelectorAll('[contenteditable=""],[contenteditable="true"]')].some(e => (e.textContent || '').trim().length > 0); } catch { return false; } })()`).catch(() => false);
    return Promise.race([probe, new Promise(r => setTimeout(() => r(false), 1500))]);
  },

  async sleepIdle() {
    if (!this.ctx.cfg().sleepTabs || this.agent || this.sleepBusy) return;
    this.sleepBusy = true;
    try {
      const now = Date.now();
      const after = this.sleepDelay();
      for (const t of this.tabs.slice()) {
        if (this.split && (t.id === this.split.a || t.id === this.split.b)) continue;
        if (t.sleep || t.pinned || t.playing || t.id === this.activeId || now - t.lastActive <= after) continue;
        if (await this.hasUnsavedInput(t)) continue;
        if (this.tabs.includes(t) && t.id !== this.activeId) this.sleepTab(t);
      }
    } finally { this.sleepBusy = false; }
  },

  // Приспати всі неактивні вкладки одразу (кнопка на панелі вкладок): ті самі запобіжники, що й в автоматичного сну, але без очікування
  async sleepNow() {
    if (this.agent || this.sleepBusy) return 0;
    this.sleepBusy = true;
    let n = 0;
    try {
      for (const t of this.tabs.slice()) {
        if (this.split && (t.id === this.split.a || t.id === this.split.b)) continue;
        if (t.sleep || t.pinned || t.playing || t.id === this.activeId) continue;
        if (await this.hasUnsavedInput(t)) continue;
        if (this.tabs.includes(t) && t.id !== this.activeId && this.sleepTab(t)) n++;
      }
    } finally { this.sleepBusy = false; }
    return n;
  },
};

module.exports = { methods, SLEEP_ENV, SLEEP_MINUTES };
