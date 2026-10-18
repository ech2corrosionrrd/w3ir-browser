'use strict';
// Перегляд локальних документів: Markdown, CSV/TSV, JSON, текст і код. Спільні дії — розмір шрифту, тема, друк і збереження в PDF.
// Markdown будується з екранованого HTML (pages/markdown.js) і ще раз проходить білий список тегів; решта типів — лише textContent.
const ALLOWED = new Set('a,blockquote,br,code,del,em,h1,h2,h3,h4,h5,h6,hr,img,input,li,ol,p,pre,strong,table,tbody,td,th,thead,tr,ul'.split(','));
const ATTRS = { a: ['href', 'title', 'rel'], img: ['src', 'alt', 'title'], ol: ['start'], td: ['style'], th: ['style'], code: ['class'], input: ['type', 'disabled', 'checked'] };
const ALIGN = /^text-align:(left|center|right)$/;

function clean(parent) {
  for (const n of [...parent.childNodes]) {
    if (n.nodeType === 3) continue;
    if (n.nodeType !== 1) { n.remove(); continue; }
    const tag = n.tagName.toLowerCase();
    if (!ALLOWED.has(tag)) { n.remove(); continue; }
    clean(n);
    for (const a of [...n.attributes]) {
      const name = a.name.toLowerCase(), v = a.value;
      const ok = (ATTRS[tag] || []).includes(name)
        && !(name === 'href' && !/^(https?:|mailto:|#)/i.test(v))
        && !(name === 'src' && !/^https?:/i.test(v))
        && !(name === 'style' && !ALIGN.test(v))
        && !(name === 'type' && v !== 'checkbox')
        && !(name === 'class' && !/^lang-[\w+#.-]*$/.test(v));
      if (!ok) n.removeAttribute(a.name);
    }
    if (tag === 'a') n.setAttribute('target', '_blank');
  }
}

function load(key, def) { try { return localStorage.getItem('doc.' + key) || def; } catch { return def; } }
function save(key, v) { try { localStorage.setItem('doc.' + key, v); } catch { /* ignore */ } }

const MAX_ROWS = 5000, MAX_LINES = 20000, MAX_NODES = 5000;

// CSV/TSV: таблиця з фільтром і сортуванням за клацанням на заголовку
function drawCsv(box, doc) {
  const delim = Csv.detectDelimiter(doc.text, doc.name);
  const { rows, truncated } = Csv.parse(doc.text, delim, 100000);
  if (!rows.length) { box.append(h('div', { class: 'empty' }, 'Файл порожній.')); return; }
  const head = rows[0], data = rows.slice(1);
  let sortCol = -1, dir = 1, query = '';
  const info = h('div', { class: 'info' });
  const table = h('table', { class: 'grid' });
  const filter = h('input', { type: 'text', placeholder: 'Фільтр рядків', oninput: () => { query = filter.value.toLowerCase(); body(); } });
  const body = () => {
    const list = query ? data.filter(r => r.some(c => c.toLowerCase().includes(query))) : data.slice();
    if (sortCol >= 0) list.sort((a, b) => dir * Csv.compare(a[sortCol] || '', b[sortCol] || ''));
    const shown = list.slice(0, MAX_ROWS);
    const sortMark = (k) => (sortCol === k ? (dir > 0 ? ' ▲' : ' ▼') : '');
    table.replaceChildren(
      h('thead', null, h('tr', null, h('th', { class: 'n' }, '#'),
        head.map((c, k) => h('th', { class: 'sort', onclick: () => { dir = sortCol === k ? -dir : 1; sortCol = k; body(); } }, c + sortMark(k))))),
      h('tbody', null, shown.map((r, i) => h('tr', null, h('td', { class: 'n' }, String(i + 1)), head.map((_, k) => h('td', null, r[k] || ''))))));
    info.textContent = t('Рядків: {0}', list.length)
      + (list.length > shown.length ? ' · ' + t('показано перші {0}', shown.length) : '')
      + (truncated ? ' · ' + t('файл прочитано не повністю') : '');
  };
  box.append(h('div', { class: 'bar' }, filter, info), h('div', { class: 'scroll' }, table));
  body();
}

// JSON: дерево зі згортанням (<details>); дочірні вузли створюються при розгортанні, їх кількість обмежена
function jsonNode(key, val, budget, open) {
  const label = key === null ? [] : [h('span', { class: 'k' }, JSON.stringify(key) + ': ')];
  if (val === null || typeof val !== 'object') {
    const cls = val === null ? 'nul' : typeof val === 'string' ? 'str' : typeof val === 'number' ? 'num' : 'bool';
    return h('div', { class: 'leaf' }, label, h('span', { class: cls }, JSON.stringify(val)));
  }
  const arr = Array.isArray(val), entries = Object.entries(val);
  const det = h('details', { open: !!open }, h('summary', null, label, h('span', { class: 'dim' }, arr ? `[${entries.length}]` : `{${entries.length}}`)));
  let filled = false;
  const fill = () => {
    if (filled) return;
    filled = true;
    for (const [k, v] of entries) {
      if (budget.n++ > MAX_NODES) { det.append(h('div', { class: 'dim' }, '…')); break; }
      det.append(jsonNode(arr ? null : k, v, budget, false));
    }
  };
  if (open) fill(); else det.addEventListener('toggle', fill);
  return det;
}

function drawJson(box, doc, state) {
  let data;
  try { data = JSON.parse(doc.text); } catch (e) {
    box.append(h('div', { class: 'warn' }, t('Це не коректний JSON: {0}', String(e.message).slice(0, 200))), h('pre', { class: 'src' }, doc.text));
    return;
  }
  if (state.source) box.append(h('pre', { class: 'src' }, JSON.stringify(data, null, 2)));
  else box.append(h('div', { class: 'tree' }, jsonNode(null, data, { n: 0 }, true)));
}

// Текст і код: номери рядків, за потреби перенос
function drawText(box, doc, state) {
  const lines = doc.text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const shown = lines.slice(0, MAX_LINES);
  box.append(h('pre', { class: 'code' + (state.wrap ? ' wrap' : '') }, shown.map((l, i) => {
    const row = h('span', { class: 'ln' }, l + '\n');
    row.dataset.n = String(i + 1);
    return row;
  })));
  if (lines.length > shown.length) box.append(h('div', { class: 'dim' }, t('Показано перші {0} рядків із {1}.', shown.length, lines.length)));
}

async function main() {
  const doc = await w3ir.invoke('doc:get');
  const tools = document.getElementById('tools');
  if (!doc) { app.append(h('div', { class: 'empty' }, 'Немає документа для перегляду.')); return; }
  const kind = doc.kind || 'md';
  document.title = (kind === 'md' && Markdown.titleOf(doc.text)) || doc.name;
  document.body.classList.add('kind-' + kind);

  let size = Number(load('size', 17));
  const state = { source: false, wrap: load('wrap', '1') === '1' };
  const view = h('article', { class: 'md' });
  const draw = () => {
    document.body.style.setProperty('--size', size + 'px');
    document.body.classList.toggle('light', load('theme', matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') === 'light');
    view.replaceChildren();
    if (kind === 'csv') drawCsv(view, doc);
    else if (kind === 'json') drawJson(view, doc, state);
    else if (kind === 'text') drawText(view, doc, state);
    else if (state.source) view.append(h('pre', { class: 'src' }, doc.text));
    else {
      const body = new DOMParser().parseFromString(Markdown.render(doc.text), 'text/html').body;
      clean(body);
      view.append(...body.childNodes);
    }
  };
  const extra = [];
  if (kind === 'md' || kind === 'json') {
    const toggle = h('button', { onclick: () => { state.source = !state.source; toggle.textContent = state.source ? 'Вигляд' : 'Текст'; draw(); }, title: 'Перемкнути між відрисованим виглядом і вихідним текстом' }, 'Текст');
    extra.push(toggle);
  }
  if (kind === 'text') extra.push(h('button', { onclick: () => { state.wrap = !state.wrap; save('wrap', state.wrap ? '1' : '0'); draw(); }, title: 'Перенос довгих рядків' }, 'Перенос'));
  tools.append(
    h('span', { class: 'name', title: doc.file }, doc.name),
    h('button', { onclick: () => { size = Math.max(12, size - 1); save('size', size); draw(); }, title: 'Менший шрифт' }, 'A−'),
    h('button', { onclick: () => { size = Math.min(30, size + 1); save('size', size); draw(); }, title: 'Більший шрифт' }, 'A+'),
    h('button', { onclick: () => { save('theme', load('theme', 'dark') === 'light' ? 'dark' : 'light'); draw(); }, title: 'Тема' }, '◐'),
    ...extra,
    h('button', { onclick: () => w3ir.invoke('doc:print'), title: 'Друк (Ctrl+P)' }, 'Друк'),
    h('button', { onclick: () => w3ir.invoke('doc:savePdf'), title: 'Зберегти документ як PDF' }, 'У PDF'));
  app.append(view);
  draw();
}
main();
