'use strict';
const COLORS = ['#5a8dee', '#e5675f', '#4caf8a', '#d8963a', '#a078f0', '#3aa7c9', '#c8639b', '#7a8a99'];

async function main() {
  document.documentElement.classList.add('newtab');
  const input = h('input', { type: 'text', placeholder: 'Пошук або адреса', autofocus: true, spellcheck: false });
  const form = h('form', { class: 'search', onsubmit: async (e) => {
    e.preventDefault();
    const url = await w3ir.invoke('resolve', { text: input.value });
    if (url) location.href = url;
  } }, input);

  const sites = await w3ir.invoke('topsites');
  const tiles = h('div', { class: 'tiles' }, sites.map((s, i) => {
    let host = s.title;
    try { host = new URL(s.url).hostname.replace(/^www\./, ''); } catch {}
    return h('a', { class: 'tile', href: s.url, title: s.title + '\n' + s.url },
      h('div', { class: 'ic', style: 'background:' + COLORS[i % COLORS.length] }, host[0].toUpperCase()),
      h('div', { class: 'n' }, s.title.length > 24 ? host : s.title));
  }));

  const foot = h('div', { class: 'note', style: 'margin-top:36px' },
    h('a', { href: 'w3ir://help', title: 'Опис усіх функцій і гарячих клавіш (F1)' }, 'Довідка'), ' · ',
    h('a', { href: 'w3ir://settings', title: 'Тема, пошук, приватність, синхронізація' }, 'Налаштування'), ' · ',
    h('a', { href: 'w3ir://import', title: 'Перенесіть закладки, історію й паролі з Chrome чи Firefox' }, 'Імпорт даних'), ' · Ctrl+K — палітра команд');
  const brand = h('div', { class: 'brand' },
    h('img', { class: 'mark', src: 'brand-mark.png', alt: '', draggable: false }),
    h('img', { class: 'wordmark', src: 'brand-wordmark.png', alt: 'W3IR Browser', draggable: false }));
  app.append(brand, form, tiles, foot);
  input.focus();
}
main();
