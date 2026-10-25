'use strict';
// Стартова сторінка (w3ir://newtab): пошук, стан браузера, швидкий доступ до всіх розділів, мої сайти, закладки, поради.
// Нова можливість браузера = один запис у LAUNCHERS (група, значок, назва, опис, адреса).
const COLORS = ['#5a8dee', '#e5675f', '#4caf8a', '#d8963a', '#a078f0', '#3aa7c9', '#c8639b', '#7a8a99'];
const SVGNS = 'http://www.w3.org/2000/svg';

// Значки 24×24 (контур, currentColor): прості власні форми, без зовнішніх залежностей
const ICONS = {
  bookmark: ['M6 3h12v18l-6-4-6 4z'],
  history: ['M12 7v5l3 2', 'circle:12,12,9'],
  download: ['M12 4v11', 'M7 11l5 5 5-5', 'M5 20h14'],
  import: ['M12 20V9', 'M7 14l5-5 5 5', 'M5 4h14'],
  key: ['circle:8,12,3.5', 'M11.5 12H21', 'M18 12v3', 'M21 12v2'],
  wallet: ['M3 8a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M3 8l11-4v2', 'circle:16,13,1.2'],
  pulse: ['M3 12h4l3-7 4 14 3-7h4'],
  users: ['circle:9,8,3', 'M3 20c0-3 3-5 6-5s6 2 6 5', 'circle:17,9,2.3', 'M17 14c2.5 0 4 1.7 4 4'],
  spark: ['M12 3l2.2 5.4L20 10l-5.8 1.6L12 17l-2.2-5.4L4 10l5.8-1.6z', 'M19 17v4', 'M17 19h4'],
  pdf: ['M7 3h7l5 5v13H7z', 'M14 3v5h5', 'M10 14h6', 'M10 17h4'],
  help: ['circle:12,12,9', 'M9.6 9.3a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.2 1-1.2 1.8', 'M12 17h.01'],
  gear: ['M4 7h9', 'M17 7h3', 'circle:15,7,2', 'M4 17h3', 'M11 17h9', 'circle:9,17,2'],
  shield: ['M12 3l8 3v6c0 5-3.6 8-8 9-4.4-1-8-4-8-9V6z'],
  update: ['M12 20V6', 'M6 11l6-6 6 6', 'M5 20h14'],
  tabs: ['M3 8a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  search: ['circle:11,11,6.5', 'M16 16l5 5'],
};
function icon(name, size = 20) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name] || []) {
    if (d.startsWith('circle:')) {
      const [cx, cy, r] = d.slice(7).split(',');
      const c = document.createElementNS(SVGNS, 'circle'); c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', r); s.append(c);
    } else { const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', d); s.append(p); }
  }
  return s;
}

// група → [значок, назва, опис, адреса, гаряча клавіша]
const LAUNCHERS = [
  ['Перегляд', [
    ['bookmark', 'Закладки', 'Збережені сторінки з пошуком', 'w3ir://bookmarks', 'Ctrl+Shift+O'],
    ['history', 'Історія', 'Відвідані сторінки за днями', 'w3ir://history', 'Ctrl+H'],
    ['download', 'Завантаження', 'Прогрес, пауза, відкриття файлів', 'w3ir://downloads', 'Ctrl+J'],
    ['import', 'Імпорт даних', 'Закладки й паролі з іншого браузера', 'w3ir://import', ''],
  ]],
  ['Безпека та Web3', [
    ['key', 'Паролі', 'Зашифроване сховище й автозаповнення', 'w3ir://passwords', ''],
    ['wallet', 'Гаманець', 'EVM і Solana, токени, NFT', 'w3ir://wallet', ''],
    ['pulse', 'Панель', 'Пам’ять, вкладки й захист наживо', 'w3ir://dashboard', ''],
    ['users', 'Профілі', 'Окремі cookie, закладки й паролі', 'w3ir://profiles', ''],
  ]],
  ['Інструменти', [
    ['spark', 'ШІ-помічник', 'Локальна модель Ollama', 'w3ir://assistant', ''],
    ['pdf', 'PDF-інструменти', 'Злиття, розділення, підпис', 'w3ir://pdftools', ''],
    ['help', 'Довідка', 'Функції та гарячі клавіші', 'w3ir://help', 'F1'],
    ['gear', 'Налаштування', 'Тема, пошук, приватність, оновлення', 'w3ir://settings', ''],
  ]],
];

const TIPS = [
  'Ctrl+K відкриває палітру команд: єдиний пошук по вкладках, закладках, історії та всіх діях браузера.',
  'Закріпіть улюблену вкладку: вона стане вужчою, лишиться зліва й повернеться після перезапуску.',
  'Режим «Суворий» у налаштуваннях приватності блокує сторонні cookie й приховує локальні адреси в WebRTC.',
  'Ctrl+Shift+T повертає востаннє закриту вкладку.',
  'Групи вкладок із кольорами допомагають тримати пов’язані сторінки разом і згортати їх одним кліком.',
  'Режим читання (Ctrl+Shift+R) показує лише текст статті без реклами й відволікань.',
  'Неактивні вкладки засинають і звільняють пам’ять; час сну змінюється в налаштуваннях.',
  'Напишіть «gh власник/репозиторій» в адресному рядку, щоб одразу відкрити репозиторій на GitHub.',
  'На сторінці «Панель» видно, які вкладки найбільше навантажують пам’ять.',
  'Ctrl+D додає сторінку в закладки, а Ctrl+F шукає текст на сторінці.',
];
const KEYS = [['Ctrl+T', 'Нова вкладка'], ['Ctrl+K', 'Палітра команд'], ['Ctrl+L', 'Перейти до адресного рядка'], ['Ctrl+D', 'Закладка'], ['Ctrl+F', 'Пошук на сторінці'], ['F1', 'Довідка']];
const MODES = { standard: 'Стандартний', strict: 'Суворий', maximum: 'Максимальний' };

const num = (n) => Number(n || 0).toLocaleString(LOCALE);
function greeting(d) {
  const hr = d.getHours();
  return hr < 5 ? t('Доброї ночі') : hr < 12 ? t('Доброго ранку') : hr < 18 ? t('Доброго дня') : t('Доброго вечора');
}

function pill(ic, label, value, href, cls = '') {
  return h('a', { class: 'pill ' + cls, href, title: label + ': ' + value },
    h('span', { class: 'pi' }, icon(ic, 17)), h('span', { class: 'pt' }, h('span', { class: 'pl' }, label), h('span', { class: 'pv' }, value)));
}

function statusRow(i) {
  const up = i.update && i.update.state === 'ready';
  const wallet = { none: t('Не створено'), locked: t('Заблоковано'), ready: t('Готовий') }[i.wallet] || '—';
  const dl = i.downloads.active ? (i.downloads.percent >= 0 ? t('{0} активних · {1} %', i.downloads.active, i.downloads.percent) : t('{0} активних', i.downloads.active)) : t('Немає активних');
  return h('div', { class: 'status' },
    pill('shield', t('Захист'), t('{0} заблоковано · {1}', num(i.protection.blocked), t(MODES[i.protection.mode] || MODES.standard)), 'w3ir://dashboard'),
    pill('update', t('Оновлення'), up ? t('Доступне {0}: натисніть ⬆', i.update.version) : t('Актуальна версія {0}', i.version), 'w3ir://settings', up ? 'hot' : ''),
    pill('tabs', t('Вкладки'), i.tabs.sleeping ? t('{0} · сплять: {1}', i.tabs.total, i.tabs.sleeping) : String(i.tabs.total), 'w3ir://dashboard'),
    i.wallet === 'hidden' ? null : pill('wallet', t('Гаманець'), wallet, 'w3ir://wallet'),
    i.wallet === 'hidden' ? null : pill('spark', 'Arweave', '⚡ Irys Web3', 'w3ir://wallet#sec-arweave'),
    pill('download', t('Завантаження'), dl, 'w3ir://downloads'));
}

function launchers(hideWallet) {
  return h('div', { class: 'groups' }, LAUNCHERS.map(([group, all], gi) => [group, hideWallet ? all.filter(x => x[3] !== 'w3ir://wallet') : all, gi]).map(([group, items, gi]) => h('section', { class: 'group g' + gi },
    h('h3', null, group),
    h('div', { class: 'lcs' }, items.map(([ic, name, desc, href, key]) => h('a', { class: 'lc', href, title: t(name) + ' — ' + t(desc) + (key ? ' (' + key + ')' : '') },
      h('span', { class: 'lic' }, icon(ic, 21)),
      h('span', { class: 'ltx' }, h('span', { class: 'ln' }, name), h('span', { class: 'ld' }, desc)),
      key ? h('kbd', null, key) : null))))));
}

function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } }

async function main() {
  document.documentElement.classList.add('newtab');
  const now = new Date();
  const info = await w3ir.invoke('startinfo').catch(() => null);
  const input = h('input', { type: 'text', placeholder: 'Пошук або адреса', autofocus: true, spellcheck: false, 'aria-label': t('Пошук або адреса') });
  const form = h('form', { class: 'search big', onsubmit: async (e) => {
    e.preventDefault();
    const url = await w3ir.invoke('resolve', { text: input.value });
    if (url) location.href = url;
  } }, h('span', { class: 'sic' }, icon('search', 20)), input);

  const clock = h('div', { class: 'clock' });
  const date = h('div', { class: 'date' });
  const tick = () => {
    const d = new Date();
    clock.textContent = d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
    const ds = d.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });
    date.textContent = ds.charAt(0).toUpperCase() + ds.slice(1);
  };
  tick(); setInterval(tick, 20000);

  const top = h('header', { class: 'top' },
    h('div', { class: 'brand-s' },
      h('img', { class: 'mark', src: 'brand-mark.png', alt: '', draggable: false }),
      h('img', { class: 'wordmark', src: 'brand-wordmark.png', alt: 'W3IR Browser', draggable: false })),
    h('div', { class: 'when' }, clock, date));

  const hero = h('section', { class: 'hero-s' },
    h('div', { class: 'hello' }, greeting(now)),
    form,
    h('div', { class: 'hints' },
      info ? h('span', null, t('Пошук: {0}', info.engine)) : null,
      h('span', null, t('Ctrl+K — палітра команд')),
      h('span', null, t('gh власник/репозиторій — GitHub'))));

  const sites = await w3ir.invoke('topsites').catch(() => []);
  const tiles = h('div', { class: 'tiles' }, sites.length ? sites.map((s, i) => {
    const host = hostOf(s.url);
    return h('a', { class: 'tile', href: s.url, title: s.title + '\n' + s.url },
      h('div', { class: 'ic', style: 'background:' + COLORS[i % COLORS.length] }, (host[0] || '?').toUpperCase()),
      h('div', { class: 'n' }, s.title.length > 24 ? host : s.title));
  }) : h('div', { class: 'empty-s' }, 'Тут з’являться сайти, які ви відвідуєте найчастіше.'));

  // Відкладені набори вкладок (Ctrl+Shift+S): відновити весь набір, відкрити окрему вкладку або видалити набір
  const stashes = await w3ir.invoke('stash:list', { limit: 8 }).catch(() => []);
  const stashBox = Array.isArray(stashes) && stashes.length ? h('div', { class: 'stashes' }, stashes.map((st) => {
    const row = h('div', { class: 'stash' });
    const msg = h('span', { class: 'sm' });
    const restoreNow = async (andDelete) => {
      const ok = await w3ir.invoke('stash:restore', { id: st.id }).catch(() => false);
      if (ok && andDelete) { await w3ir.invoke('stash:delete', { id: st.id }).catch(() => null); row.remove(); return; }
      msg.textContent = ok ? t('Відновлено у фонових вкладках') : t('Не вдалося відновити');
    };
    const restore = h('button', { class: 'link', type: 'button', onclick: async () => { restore.disabled = true; await restoreNow(false); restore.disabled = false; } }, t('Відновити всі'));
    const pop = h('button', { class: 'link', type: 'button', title: t('Відкрити вкладки набору й видалити сам набір'), onclick: async () => { pop.disabled = true; await restoreNow(true); pop.disabled = false; } }, t('Відновити й видалити'));
    const del = h('button', { class: 'link', type: 'button', onclick: async () => { await w3ir.invoke('stash:delete', { id: st.id }).catch(() => null); row.remove(); } }, t('Видалити'));
    row.append(
      h('div', { class: 'sh' }, h('span', { class: 'st', title: st.title }, st.title), h('span', { class: 'sa' }, restore, pop, del)),
      h('details', null, h('summary', null, t('Вкладок: {0}', st.tabs.length)),
        st.tabs.slice(0, 50).map(tab => h('a', { href: tab.url, title: tab.url }, tab.title || hostOf(tab.url)))),
      msg);
    return row;
  })) : null;

  const main = h('div', { class: 'col-main' },
    h('h2', null, 'Швидкий доступ'), launchers(info && info.wallet === 'hidden'),
    ...(stashBox ? [h('h2', null, 'Відкладені вкладки'), stashBox] : []),
    h('h2', null, 'Мої сайти'), tiles);

  // бокова колонка: закладки, порада, гарячі клавіші
  const bms = info && info.bookmarks.length
    ? h('div', { class: 'bmlist' }, info.bookmarks.map(b => h('a', { class: 'bm', href: b.url, title: b.title + '\n' + b.url },
      h('span', { class: 'bmi' }, (hostOf(b.url)[0] || '?').toUpperCase()), h('span', { class: 'bmt' }, h('span', { class: 'bn' }, b.title), h('span', { class: 'bh' }, hostOf(b.url))))))
    : h('div', { class: 'empty-s' }, 'Закладок поки немає: натисніть Ctrl+D на потрібній сторінці або імпортуйте їх з іншого браузера.');
  let tipIndex = Math.floor(now.getTime() / 864e5) % TIPS.length;
  const tipText = h('p', { class: 'tip-t' }, t(TIPS[tipIndex]));
  const tipCard = h('div', { class: 'tip' }, tipText,
    h('button', { class: 'link', type: 'button', onclick: () => { tipIndex = (tipIndex + 1) % TIPS.length; tipText.textContent = t(TIPS[tipIndex]); } }, t('Ще порада')));
  const keys = h('div', { class: 'keys' }, KEYS.map(([k, d]) => h('div', { class: 'key' }, h('kbd', null, k), h('span', null, d))));
  const side = h('aside', { class: 'col-side' },
    h('h2', null, 'Закладки'), bms,
    info && info.bookmarkCount > info.bookmarks.length ? h('a', { class: 'more', href: 'w3ir://bookmarks' }, t('Усі закладки ({0})', info.bookmarkCount)) : h('a', { class: 'more', href: 'w3ir://bookmarks' }, 'Відкрити закладки'),
    h('h2', null, 'Порада'), tipCard,
    h('h2', null, 'Гарячі клавіші'), keys);

  const foot = h('footer', { class: 'foot-s' },
    info ? 'W3IR Browser ' + info.version + ' · ' : '', 'усе працює локально, без телеметрії', ' · ',
    h('a', { href: 'w3ir://help' }, 'Довідка'), ' · ', h('a', { href: 'w3ir://settings' }, 'Налаштування'));

  app.append(top, hero, info ? statusRow(info) : '', h('div', { class: 'cols' }, main, side), foot);
  input.focus();
}
main();
