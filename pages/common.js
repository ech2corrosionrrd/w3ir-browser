'use strict';
const app = document.getElementById('app');

function h(tag, props, ...children) {
  const e = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if ((k === 'role' || k.includes('-')) && v !== false && v != null) e.setAttribute(k, String(v));
      else if (v !== false && v != null) e[k] = v;
    }
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}

function fmtBytes(n) {
  if (!(n > 0)) return '0 ' + t('Б');
  const u = [t('Б'), t('КБ'), t('МБ'), t('ГБ'), t('ТБ')];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
}

function fmtDay(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return t('Сьогодні');
  if (d.toDateString() === yest.toDateString()) return t('Вчора');
  return d.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------- модальне вікно з формою ----------
function ask(title, fields, { okText = 'OK', note = '' } = {}) {
  return new Promise((resolve) => {
    const inputs = {};
    const err = h('div', { class: 'merr' });
    const rows = fields.map(f => {
      const inp = f.type === 'textarea'
        ? h('textarea', { rows: 3, value: f.value || '' })
        : h('input', { type: f.type || 'text', value: f.value || '', autocomplete: 'off', spellcheck: false, placeholder: f.placeholder || '' });
      inputs[f.name] = inp;
      return h('label', { class: 'mfield' }, h('span', null, f.label), inp, f.extra || '');
    });
    const close = (v) => { overlay.remove(); resolve(v); };
    const submit = () => {
      const out = {};
      for (const f of fields) out[f.name] = inputs[f.name].value;
      close(out);
    };
    const overlay = h('div', { class: 'modal', onmousedown: (e) => { if (e.target === overlay) close(null); } },
      h('div', { class: 'mbox' },
        h('h2', { class: 'mtitle' }, title),
        note ? h('p', { class: 'note' }, note) : '',
        ...rows, err,
        h('div', { class: 'mbtns' },
          h('button', { onclick: () => close(null) }, 'Скасувати'),
          h('button', { class: 'primary', onclick: submit }, okText))));
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') submit(); });
    document.body.append(overlay);
    const first = Object.values(inputs)[0];
    if (first) first.focus();
  });
}


// ---------- бічна навігація за заголовками h2 розділів (як у налаштуваннях) ----------
function railNav(label) {
  document.querySelectorAll('nav.rail').forEach(n => n.remove());
  if (window._railMark) {
    window.removeEventListener('scroll', window._railMark);
    window._railMark = null;
  }
  const heads = [...document.querySelectorAll('main > h2')];
  if (heads.length < 4) return;
  const links = heads.map((hd, i) => {
    hd.id = hd.id || 'sec' + i;
    return h('a', { href: '#' + hd.id, onclick: (e) => { e.preventDefault(); hd.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, hd.textContent);
  });
  document.body.append(h('nav', { class: 'rail', 'aria-label': label }, links));
  const mark = () => {
    let cur = 0;
    heads.forEach((hd, i) => { if (hd.getBoundingClientRect().top < 140) cur = i; });
    links.forEach((a, i) => a.classList.toggle('on', i === cur));
    if (window.syncActiveTab && heads[cur] && heads[cur].id) window.syncActiveTab(heads[cur].id);
  };
  window._railMark = mark;
  window.addEventListener('scroll', mark, { passive: true });
  mark();
}
