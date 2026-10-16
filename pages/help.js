'use strict';
// Проста розмітка: **жирний**, `код`, [текст](w3ir://сторінка)
function rich(text) {
  const frag = document.createDocumentFragment();
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\((w3ir:\/\/[a-z]+)\)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    if (m[1]) frag.append(h('b', null, m[1]));
    else if (m[2]) frag.append(h('code', null, m[2]));
    else frag.append(h('a', { href: m[4] }, m[3]));
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

const flat = (it) => [it.t, ...(it.d || []), ...(it.list || []), it.tip || '', it.warn || '', it.keys || ''].join(' ').toLowerCase();

function entry(it) {
  const head = h('h3', null, it.t, it.keys ? h('span', { class: 'kbd' }, it.keys) : '');
  const box = h('div', { class: 'entry' }, head, ...(it.d || []).map(p => h('p', null, rich(p))));
  if (it.list) box.append(h('ul', null, it.list.map(li => h('li', null, rich(li)))));
  if (it.tip) box.append(h('div', { class: 'tip' }, '💡 ', rich(it.tip)));
  if (it.warn) box.append(h('div', { class: 'tip warn' }, '⚠ ', rich(it.warn)));
  return box;
}

function shortcutsTable() {
  const rows = [];
  for (const [k, v] of SHORTCUTS_T) {
    if (v === null) rows.push(h('tr', null, h('td', { colSpan: 2, style: 'font-weight:600;background:var(--bg)' }, k)));
    else rows.push(h('tr', null, h('td', null, ...k.split(' / ').flatMap((x, i) => [i ? ' / ' : '', h('span', { class: 'kbd' }, x)])), h('td', null, v)));
  }
  return h('table', { class: 'keys' }, ...rows);
}

// Довідка перекладається на рівні даних (розмітка **…**, `…`, [..](..) не розбивається на вузли DOM)
const trAll = (v) => typeof v === 'string' ? t(v) : Array.isArray(v) ? v.map(trAll) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'id' || k === 'icon' ? x : trAll(x)])) : v;
const HELP_T = trAll(HELP), SHORTCUTS_T = trAll(SHORTCUTS), FAQ_T = trAll(FAQ);

const SECTIONS = [
  ...HELP_T,
  { id: 'keys', icon: '⌨', title: t('Гарячі клавіші'), custom: () => shortcutsTable(), text: SHORTCUTS_T.map(x => x.join(' ')).join(' ').toLowerCase() },
  { id: 'faq', icon: '❓', title: t('Часті запитання та проблеми'), items: FAQ_T.map(([q, a]) => ({ t: q, d: [a] })) },
  { id: 'about', icon: 'ℹ', title: t('Про програму'), about: true, text: 'про програму версія chromium electron' },
];

const toc = document.getElementById('toc');
const search = h('input', { type: 'text', placeholder: 'Пошук у довідці…', spellcheck: false, title: 'Шукає в усіх розділах довідки (Ctrl+F також працює)' });
toc.append(search);
const links = {};
for (const s of SECTIONS) {
  const a = h('a', { href: '#' + s.id, title: `Перейти до розділу «${s.title}»` }, h('span', { class: 'ic' }, s.icon), s.title);
  links[s.id] = a;
  toc.append(a);
}

const hero = h('div', { class: 'hero' }, h('h1', null, 'Довідка W3IR Browser'),
  h('p', null, 'Тут описано всі функції браузера. Використовуйте пошук ліворуч або натискайте розділи. Наведіть курсор на кнопки в інтерфейсі — підказки з’являться одразу. ', h('span', { class: 'kbd' }, 'F1'), ' відкриває довідку будь-коли.'));
const content = h('div');
app.append(hero, content);

const sectionEls = {};
async function build() {
  let version = '';
  try { version = (await w3ir.invoke('settings:get')).version; } catch { /* ignore */ }
  for (const s of SECTIONS) {
    const sec = h('section', { class: 'sec', id: s.id }, h('h2', null, s.icon, ' ', s.title));
    if (s.custom) sec.append(s.custom());
    else if (s.about) {
      sec.append(entry({ t: 'W3IR Browser ' + version, d: [t('Браузер на основі Chromium (Electron). Тема, вкладки, приватність, паролі, Web3 та GitHub — в одному місці.')] }));
      sec.append(entry({ t: t('Де зберігаються дані'), d: [t('`%APPDATA%\\W3IR Browser` — налаштування, закладки, історія, профілі (`profiles`), зашифроване сховище (`vault.bin`).')] }));
      sec.append(entry({ t: t('Повернутися до роботи'), d: [t('Закрийте вкладку (Ctrl+W) або відкрийте [налаштування](w3ir://settings).')] }));
    } else for (const it of s.items) { const e = entry(it); e.dataset.text = flat(it); sec.append(e); }
    sectionEls[s.id] = sec;
    content.append(sec);
  }
}

function filter() {
  const q = search.value.trim().toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  let any = false;
  for (const s of SECTIONS) {
    const sec = sectionEls[s.id];
    let shown = 0;
    if (s.custom || s.about) {
      shown = !tokens.length || tokens.every(t => (s.text + ' ' + s.title.toLowerCase()).includes(t)) ? 1 : 0;
    } else {
      for (const e of sec.querySelectorAll('.entry')) {
        const ok = !tokens.length || tokens.every(t => e.dataset.text.includes(t) || s.title.toLowerCase().includes(t));
        e.hidden = !ok;
        if (ok) shown++;
      }
    }
    sec.hidden = shown === 0;
    links[s.id].hidden = shown === 0;
    if (shown) any = true;
  }
  empty.hidden = any;
}

const empty = h('div', { class: 'empty', hidden: true }, 'Нічого не знайдено. Спробуйте інші слова, наприклад: «пароль», «вкладки», «гаманець», «GitHub».');
content.after(empty);
search.addEventListener('input', filter);

// Підсвічування розділу, який зараз видно
const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) {
    Object.values(links).forEach(a => a.classList.remove('active'));
    links[e.target.id].classList.add('active');
  }
}, { rootMargin: '-10% 0px -80% 0px' });

build().then(() => { Object.values(sectionEls).forEach(el => io.observe(el)); });
