'use strict';
const search = h('input', { type: 'search', class: 'wfilter-input', placeholder: 'Пошук у закладках', spellcheck: false });
const listEl = h('div');
app.append(h('h1', null, 'Закладки'), h('div', { class: 'bar', style: 'margin-bottom:12px' }, search), listEl);

let all = [];
function render() {
  const q = search.value.toLowerCase().trim();
  const items = all.filter(b => !q || (b.title || '').toLowerCase().includes(q) || b.url.toLowerCase().includes(q));
  listEl.textContent = '';
  if (!items.length) { listEl.append(h('div', { class: 'empty' }, all.length ? 'Нічого не знайдено' : 'Закладок поки немає. Натисніть ☆ в адресному рядку.')); return; }
  listEl.append(h('div', { class: 'list' }, items.map(b => {
    const host = (b.url || '').replace(/^[a-z]+:\/\//i, '').replace(/^www\./, '');
    const initial = (host[0] || '★').toUpperCase();
    return h('div', { class: 'item' },
      h('div', { class: 'item-avatar', title: host }, initial),
      h('div', { class: 'main' },
        h('div', { class: 't' }, h('a', { href: b.url }, b.title || b.url)),
        h('div', { class: 's' }, b.url)),
      h('button', { class: 'link', title: 'Видалити', onclick: async () => { await w3ir.invoke('bookmarks:remove', { url: b.url }); load(); } }, '✕'));
  })));
}
async function load() { all = await w3ir.invoke('bookmarks:get'); render(); }
search.addEventListener('input', render);
load();
