'use strict';
const $ = (id) => document.getElementById(id);
const url = $('url');
let state = { tabs: [], activeId: null };
let sugg = { items: [], sel: 0, open: false };
let blurTimer = null;
let suggestSeq = 0;
let suggestTimer = null;

// ---------- відображення ----------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ---------- групи вкладок ----------
let editing = null; // { id, value } — група, яку зараз перейменовують у рядку вкладок

function startEditGroup(id) {
  const g = (state.groups || []).find(x => x.id === id);
  editing = { id, value: g ? g.name : '' };
  render(state);
}

function commitEdit(save) {
  if (!editing) return;
  const e = editing;
  editing = null;
  if (save) api.cmd('groupRename', { id: e.id, name: e.value });
  render(state);
}

function makeChip(g, index) {
  const chip = el('div', 'gchip' + (g.collapsed ? ' collapsed' : '') + (g.name ? '' : ' noname'));
  chip.style.setProperty('--gc', g.hex);
  chip.dataset.group = String(g.id);
  chip.title = `Група${g.name ? ' «' + g.name + '»' : ''} · вкладок: ${g.count}\nКлік — ${g.collapsed ? 'розгорнути' : 'згорнути'} · Подвійний клік — перейменувати · Правий клік — меню групи\nПеретягніть вкладку сюди, щоб додати її до групи`;
  if (editing && editing.id === g.id) {
    const input = el('input', 'gedit');
    input.value = editing.value;
    input.maxLength = 40;
    input.placeholder = 'Назва групи';
    input.oninput = () => { editing.value = input.value; };
    input.onkeydown = (e) => { if (e.key === 'Enter') commitEdit(true); else if (e.key === 'Escape') commitEdit(false); e.stopPropagation(); };
    input.onblur = () => commitEdit(true);
    chip.append(input);
    setTimeout(() => { input.focus(); input.select(); }, 0);
    return chip;
  }
  chip.append(el('span', 'gname', g.name));
  if (g.collapsed) chip.append(el('span', 'gcount', String(g.count)));
  let timer = null;
  chip.onclick = () => { clearTimeout(timer); timer = setTimeout(() => api.cmd('groupToggle', g.id), 220); };
  chip.ondblclick = (e) => { e.preventDefault(); clearTimeout(timer); startEditGroup(g.id); };
  chip.oncontextmenu = (e) => { e.preventDefault(); api.cmd('groupMenu', g.id); };
  chip.draggable = true;
  chip.ondragstart = (e) => { e.dataTransfer.setData('text/plain', 'g' + g.id); e.dataTransfer.effectAllowed = 'move'; };
  chip.ondragover = (e) => { e.preventDefault(); chip.classList.add('dragover'); };
  chip.ondragleave = () => chip.classList.remove('dragover');
  chip.ondrop = (e) => {
    e.preventDefault();
    chip.classList.remove('dragover');
    const data = e.dataTransfer.getData('text/plain');
    if (data.startsWith('g')) { const id = Number(data.slice(1)); if (id && id !== g.id) api.cmd('moveGroup', { id, index }); }
    else { const tabId = Number(data); if (tabId) api.cmd('groupAdd', { tabId, groupId: g.id }); }
  };
  return chip;
}

function render(s) {
  state = s;
  window.__updState = s.update && s.update.state;
  document.body.classList.toggle('incog', s.incognito);
  document.body.classList.toggle('vertical', !!s.vertical);
  $('incog').hidden = !s.incognito;
  $('incog').textContent = s.agent ? 'Керує ШІ' : 'Інкогніто';
  $('incog').title = s.agent ? 'Це вікно під керуванням ШІ: тимчасове, без ваших входів. Зупинити: Налаштування → Керування браузером ШІ' : 'Приватне вікно: історія, cookie та паролі не зберігаються і стираються після закриття';
  const pr = $('profile');
  const prof = s.profile || { id: 'default' };
  pr.hidden = prof.id === 'default';
  document.body.classList.toggle('profiled', prof.id !== 'default');
  if (prof.id !== 'default') {
    pr.textContent = '● ' + prof.name;
    pr.title = 'Профіль «' + prof.name + '»: окремі закладки, історія, паролі та cookie. Клік — керування профілями';
    document.body.style.setProperty('--pcolor', prof.color);
  }

  const tabsEl = $('tabs');
  tabsEl.textContent = '';
  const groupsById = new Map((s.groups || []).map(g => [g.id, g]));
  const chipShown = new Set();
  s.tabs.forEach((t, index) => {
    const grp = t.group ? groupsById.get(t.group) : null;
    if (grp && !chipShown.has(grp.id)) { chipShown.add(grp.id); tabsEl.append(makeChip(grp, index)); }
    if (grp && grp.collapsed) return; // вкладки згорнутої групи не показуємо
    const tab = el('div', 'tab' + (t.id === s.activeId ? ' active' : '') + (t.pinned ? ' pinned' : '') + (t.sleeping ? ' sleeping' : ''));
    tab.title = t.title + (t.url ? '\n' + t.url : '') + (t.pinned ? '\n📌 Закріплена вкладка' : '') + (t.sleeping ? '\n💤 Спляча вкладка: оживе при відкритті' : '') +
      '\n\nПравий клік — меню вкладки (групи, закріплення…) · Середня кнопка — закрити · Перетягніть — змінити порядок або додати до групи';
    tab.oncontextmenu = (e) => { e.preventDefault(); api.cmd('tabMenu', t.id); };
    tab.draggable = true;
    if (grp) { tab.classList.add('ingroup'); tab.style.setProperty('--gc', grp.hex); tab.title = `Група${grp.name ? ' «' + grp.name + '»' : ''}\n` + tab.title; }
    if (t.loading) tab.append(el('span', 'spin'));
    else if (t.favicon) {
      const img = el('img', 'fav');
      img.src = t.favicon;
      img.onerror = () => img.remove();
      tab.append(img);
    }
    if (t.pinned && !t.favicon && !t.loading) tab.append(el('span', null, '📌'));
    if (t.ai) {
      const b = el('span', 'ai' + (t.ai === 'control' ? ' ctl' : ''), t.ai === 'control' ? 'ШІ ✎' : 'ШІ');
      b.title = t.ai === 'control' ? 'ШІ може керувати цією вкладкою (меню вкладки → припинити)' : 'ШІ може читати цю вкладку (меню вкладки → припинити)';
      tab.append(b);
    }
    tab.append(el('span', 'title', t.title));
    if (t.audible || t.muted) {
      const b = el('button', 'ico', t.muted ? '🔇' : '🔊');
      b.title = t.muted ? 'Вкладку приглушено. Клік — увімкнути звук' : 'Вкладка відтворює звук. Клік — вимкнути';
      b.onclick = (e) => { e.stopPropagation(); api.cmd('muteTab', t.id); };
      tab.append(b);
    }
    const close = el('button', 'close', '✕');
    close.title = 'Закрити вкладку (Ctrl+W)';
    close.onclick = (e) => { e.stopPropagation(); api.cmd('closeTab', t.id); };
    tab.append(close);
    tab.onmousedown = (e) => { if (e.button === 0) api.cmd('switchTab', t.id); };
    tab.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); api.cmd('closeTab', t.id); } };
    tab.ondragstart = (e) => { e.dataTransfer.setData('text/plain', String(t.id)); e.dataTransfer.effectAllowed = 'move'; };
    tab.ondragover = (e) => { e.preventDefault(); tab.classList.add('dragover'); };
    tab.ondragleave = () => tab.classList.remove('dragover');
    tab.ondrop = (e) => {
      e.preventDefault();
      tab.classList.remove('dragover');
      const data = e.dataTransfer.getData('text/plain');
      if (data.startsWith('g')) { const gid = Number(data.slice(1)); if (gid && gid !== t.group) api.cmd('moveGroup', { id: gid, index }); return; }
      const id = Number(data);
      if (id && id !== t.id) api.cmd('moveTab', { id, index });
    };
    tabsEl.append(tab);
  });

  const a = s.tabs.find(t => t.id === s.activeId);
  if (a) {
    $('back').disabled = !a.canBack;
    $('forward').disabled = !a.canForward;
    $('reload').textContent = a.loading ? '✕' : '⟳';
    $('reload').title = a.loading ? 'Зупинити' : 'Оновити (Ctrl+R)';
    if (document.activeElement !== url) url.value = a.url;
    const sec = $('sec');
    sec.className = '';
    if (a.secure) sec.textContent = '🔒';
    else if (/^http:/.test(a.url)) { sec.textContent = '⚠ Не захищено'; sec.className = 'warn'; }
    else sec.textContent = 'ⓘ';
    renderShield(a.blocked);
  }
  $('reader').hidden = !s.readable;
  $('star').textContent = s.bookmarked ? '★' : '☆';
  $('star').classList.toggle('on', !!s.bookmarked);
  $('star').disabled = !a || !/^(https?|file):/.test(a.url);

  const upd = $('upd');
  const us = s.update || { state: 'idle' };
  upd.hidden = !['ready', 'downloading', 'available'].includes(us.state);
  upd.classList.toggle('ready', us.state === 'ready');
  upd.title = us.state === 'ready' ? `Оновлення ${us.version} готове й перевірене. Клік — встановити та перезапустити`
    : us.state === 'downloading' ? `Завантаження оновлення${us.percent ? ' (' + us.percent + ' %)' : ''}…`
    : `Доступне оновлення ${us.version}. Клік — відкрити налаштування оновлень`;
  const gh = $('gh');
  gh.hidden = !s.github.connected;
  gh.textContent = '🐙';
  if (s.github.count > 0) gh.append(el('span', 'badge', s.github.count > 99 ? '99+' : String(s.github.count)));
  renderDownloads(s.downloads);
  renderVault(s.vault);

  const bm = $('bookmarks');
  bm.textContent = '';
  for (const b of s.bookmarks) {
    const item = el('span', 'bm', b.title || b.url);
    item.title = (b.title || b.url) + '\n' + b.url + '\n\nКлік — відкрити · Правий клік — видалити закладку';
    item.onclick = () => api.cmd('go', b.url);
    item.onauxclick = (e) => { if (e.button === 1) api.cmd('newTab'), setTimeout(() => api.cmd('go', b.url), 50); };
    item.oncontextmenu = (e) => { e.preventDefault(); api.cmd('removeBookmark', b.url); };
    bm.append(item);
  }
  bm.hidden = s.bookmarks.length === 0;
}

function renderShield(count) {
  const sh = $('shield');
  sh.textContent = '🛡';
  sh.classList.toggle('off', !state.adblock);
  sh.title = state.adblock
    ? `Блокування реклами: увімкнено${state.engine ? ' (EasyList)' : ''}. Заблоковано на сторінці: ${count}. Клік — вимкнути`
    : 'Блокування реклами вимкнено. Клік — увімкнути';
  if (state.adblock && count > 0) sh.append(el('span', 'badge', count > 99 ? '99+' : String(count)));
}

function renderVault(v) {
  const b = $('vault');
  b.textContent = v.status === 'unlocked' ? '🔑' : '🔒';
  b.title = { none: 'Менеджер паролів: сховища ще немає — клік, щоб створити', locked: 'Менеджер паролів заблоковано — клік, щоб розблокувати', unlocked: 'Менеджер паролів розблоковано' + (v.count ? `. Для цього сайту збережено облікових записів: ${v.count} — клік, щоб заповнити` : '. Клік — заповнити пароль на цій сторінці') }[v.status];
  if (v.count > 0) b.append(el('span', 'badge', String(v.count)));
}

function renderDownloads(d) {
  const b = $('dl');
  b.textContent = '⬇';
  b.title = d && d.active > 0 ? `Завантажується файлів: ${d.active}${d.percent >= 0 ? ' (' + d.percent + ' %)' : ''}. Клік — відкрити список` : 'Завантаження (Ctrl+J): прогрес, пауза, відкриття файлів';
  if (d && d.active > 0) b.append(el('span', 'badge', d.percent >= 0 ? d.percent + '%' : '…'));
}

// ---------- підказки ----------
function sendSuggest() {
  const r = $('omni').getBoundingClientRect();
  api.cmd('showSuggest', {
    items: sugg.items, selected: sugg.sel,
    rect: { left: r.left, bottom: r.bottom, width: r.width },
  });
  sugg.open = sugg.items.length > 0;
}

function closeSuggest() {
  suggestSeq++;
  if (sugg.open) api.cmd('closeSuggest');
  sugg = { items: [], sel: 0, open: false };
}

function restoreUrl() {
  const a = state.tabs.find(t => t.id === state.activeId);
  url.value = a ? a.url : '';
}

url.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(async () => {
    const seq = ++suggestSeq;
    const text = url.value;
    const items = await api.suggest(text);
    if (seq !== suggestSeq || document.activeElement !== url) return;
    sugg = { items, sel: 0, open: false };
    sendSuggest();
  }, 60);
});

url.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const text = url.value;
    closeSuggest();
    api.cmd('go', text);
    url.blur();
  } else if (e.key === 'Escape') {
    closeSuggest();
    restoreUrl();
    url.blur();
  } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && sugg.items.length) {
    e.preventDefault();
    const n = sugg.items.length;
    sugg.sel = (sugg.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    url.value = sugg.items[sugg.sel].url;
    sendSuggest();
  }
});
url.addEventListener('focus', () => { clearTimeout(blurTimer); setTimeout(() => url.select(), 0); });
url.addEventListener('blur', () => {
  clearTimeout(blurTimer);
  blurTimer = setTimeout(() => { closeSuggest(); restoreUrl(); }, 150);
});

// ---------- кнопки ----------
$('newtab').onclick = () => api.cmd('newTab');
$('profile').onclick = () => api.cmd('openPage', 'profiles');
$('back').onclick = () => api.cmd('back');
$('forward').onclick = () => api.cmd('forward');
$('reload').onclick = () => api.cmd('reload');
$('home').onclick = () => api.cmd('home');
$('sec').onclick = () => { const r = $('omni').getBoundingClientRect(); api.cmd('siteInfo', { bottom: Math.round(r.bottom + 2), left: Math.round(r.left) }); };
$('star').onclick = () => api.cmd('bookmark');
$('reader').onclick = () => api.cmd('reader');
$('upd').onclick = () => api.cmd((window.__updState === 'ready') ? 'updateInstall' : 'openPage', (window.__updState === 'ready') ? undefined : 'settings');
$('gh').onclick = () => api.cmd('githubMenu', Math.round($('toolbar').getBoundingClientRect().bottom));
$('vault').onclick = () => api.cmd('vaultMenu', Math.round($('toolbar').getBoundingClientRect().bottom));
$('shield').onclick = () => api.cmd('toggleAdblock');
$('dl').onclick = () => api.cmd('openPage', 'downloads');
$('menu').onclick = () => api.cmd('menu', Math.round($('toolbar').getBoundingClientRect().bottom));
$('tabbar').addEventListener('dblclick', (e) => { if (e.target === $('tabbar')) api.cmd('newTab'); });

// ---------- пошук на сторінці ----------
const findInput = $('find');
function doFind(forward, next) {
  api.cmd('findText', { text: findInput.value, forward, next });
  if (!findInput.value) $('findcount').textContent = '';
}
function openFind() {
  $('findbar').hidden = false;
  findInput.focus();
  findInput.select();
}
function closeFind() {
  $('findbar').hidden = true;
  $('findcount').textContent = '';
  api.cmd('findStop');
}
findInput.addEventListener('input', () => doFind(true, false));
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doFind(!e.shiftKey, true);
  else if (e.key === 'Escape') closeFind();
});
$('findnext').onclick = () => doFind(true, true);
$('findprev').onclick = () => doFind(false, true);
$('findclose').onclick = closeFind;

// ---------- події від головного процесу ----------
api.on('state', render);
api.on('focus-url', () => { url.focus(); url.select(); });
api.on('savebar', (d) => {
  const bar = $('savebar');
  if (!d) { bar.hidden = true; return; }
  const who = d.username ? ` (${d.username})` : '';
  $('savetext').textContent = d.kind === 'update' ? `Оновити пароль для ${d.host}${who}?` : `Зберегти пароль для ${d.host}${who}?`;
  $('savego').textContent = d.needs === 'create' ? 'Створити сховище' : d.needs === 'unlock' ? 'Розблокувати і зберегти' : d.kind === 'update' ? 'Оновити' : 'Зберегти';
  $('savenever').hidden = d.needs === 'create';
  bar.hidden = false;
});
$('savego').onclick = () => { $('savebar').hidden = true; api.cmd('vaultSaveAnswer', 'save'); };
$('savenever').onclick = () => { $('savebar').hidden = true; api.cmd('vaultSaveAnswer', 'never'); };
$('savex').onclick = () => { $('savebar').hidden = true; api.cmd('vaultSaveAnswer', 'dismiss'); };
api.on('url-blur', () => url.blur());
api.on('group-edit', (d) => startEditGroup(d.id));
let toastTimer;
api.on('toast', (text) => {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
});
api.on('find-open', openFind);
api.on('find-close', () => { $('findbar').hidden = true; $('findcount').textContent = ''; });
api.on('find-result', (r) => { $('findcount').textContent = r.total ? `${r.active} / ${r.total}` : 'Нічого не знайдено'; });

// Висота панелі змінюється (закладки, пошук) — повідомляємо головний процес.
let lastH = 0;
new ResizeObserver(() => {
  const h = Math.ceil($('root').getBoundingClientRect().height);
  if (h !== lastH) { lastH = h; api.cmd('uiHeight', h); }
}).observe($('root'));
