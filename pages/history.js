'use strict';
const search = h('input', { type: 'search', class: 'wfilter-input', placeholder: 'Пошук в історії', spellcheck: false });
const clearBtn = h('button', { class: 'danger', onclick: async () => {
  if (confirm('Видалити всю історію?')) { await w3ir.invoke('history:clear'); load(); }
} }, 'Очистити історію');
const listEl = h('div');
app.append(h('h1', null, 'Історія'), h('div', { class: 'bar', style: 'margin-bottom:12px' }, search, clearBtn), listEl);

async function load() {
  const items = await w3ir.invoke('history:get', { query: search.value });
  listEl.textContent = '';
  if (!items.length) { listEl.append(h('div', { class: 'empty' }, 'Нічого не знайдено')); return; }
  let day = '', box = null;
  for (const it of items) {
    const d = fmtDay(it.time);
    if (d !== day) {
      day = d;
      listEl.append(h('div', { class: 'day' }, d));
      box = h('div', { class: 'list' });
      listEl.append(box);
    }
    const host = (it.url || '').replace(/^https?:\/\//, '').replace(/^www\./, '');
    const initial = (host[0] || '🌐').toUpperCase();
    box.append(h('div', { class: 'item' },
      h('span', { class: 'time' }, fmtTime(it.time)),
      h('div', { class: 'item-avatar', style: 'width:28px;height:28px;font-size:12px', title: host }, initial),
      h('div', { class: 'main' },
        h('div', { class: 't' }, h('a', { href: it.url }, it.title || it.url)),
        h('div', { class: 's' }, it.url)),
      h('button', { class: 'link', title: 'Видалити', onclick: async () => { await w3ir.invoke('history:remove', { id: it.id }); load(); } }, '✕')));
  }
}
search.addEventListener('input', debounce(load, 150));
load();
