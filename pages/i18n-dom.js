'use strict';
// Переклад інтерфейсу в браузері: підміняє українські рядки на мову каталогу window.__I18N (його задає протокол w3ir:
// перед цим скриптом). Для української нічого не робить. Текст вставляється лише через nodeValue/setAttribute.
(function () {
  const I = window.__I18N || { lang: 'uk', locale: 'uk-UA', map: null };
  const map = I.map;
  const fmt = (s, a) => String(s).replace(/\{(\d+)\}/g, (m, i) => (a[i] !== undefined ? String(a[i]) : m));
  window.t = (s, ...a) => fmt((map && map[s]) || s, a);
  window.LOCALE = I.locale || 'uk-UA';
  document.documentElement.lang = I.lang || 'uk';
  if (!map) return;

  // шаблони з {0}: «Знайдено {0} сайтів» → регулярний вираз
  const templates = [];
  for (const k of Object.keys(map)) {
    if (!/\{\d+\}/.test(k)) continue;
    const idx = [];
    const re = new RegExp('^' + k.split(/(\{\d+\})/).map(p => {
      const m = /^\{(\d+)\}$/.exec(p);
      if (m) { idx.push(Number(m[1])); return '([\s\S]*?)'; }
      return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('') + '$');
    templates.push({ re, idx, to: map[k] });
  }
  const lookup = (s) => {
    if (map[s]) return map[s];
    for (const t of templates) {
      const m = t.re.exec(s);
      if (m) return t.to.replace(/\{(\d+)\}/g, (x, i) => { const p = t.idx.indexOf(Number(i)); return p >= 0 ? m[p + 1] : x; });
    }
    return null;
  };
  const tr = (s) => {
    const core = s.trim();
    if (!core || !/[\u0400-\u04FF]/.test(core)) return null;
    const r = lookup(core);
    if (r == null) return null;
    return s.slice(0, s.indexOf(core)) + r + s.slice(s.indexOf(core) + core.length);
  };

  const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE']);
  const skipped = (el) => !!(el && el.closest && el.closest('[data-notr]'));
  function node(n) {
    if (n.nodeType === 3) {
      if (SKIP.has(n.parentNode && n.parentNode.nodeName) || skipped(n.parentNode)) return;
      const r = tr(n.nodeValue);
      if (r != null && r !== n.nodeValue) n.nodeValue = r;
    } else if (n.nodeType === 1) {
      if (SKIP.has(n.nodeName) || skipped(n)) return;
      attrs(n);
      for (let c = n.firstChild; c; c = c.nextSibling) node(c);
    }
  }
  function attrs(el) {
    for (const a of ATTRS) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v) { const r = tr(v); if (r != null && r !== v) el.setAttribute(a, r); }
    }
    if (el.nodeName === 'INPUT' && (el.type === 'button' || el.type === 'submit') && el.value) {
      const r = tr(el.value); if (r != null && r !== el.value) el.value = r;
    }
  }
  function title() { const r = tr(document.title); if (r != null && r !== document.title) document.title = r; }

  const obs = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'childList') m.addedNodes.forEach(node);
      else if (m.type === 'characterData') node(m.target);
      else if (m.type === 'attributes') attrs(m.target);
    }
    title();
  });
  function start() {
    node(document.documentElement);
    title();
    obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
