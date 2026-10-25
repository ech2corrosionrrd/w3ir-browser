'use strict';
const root = document.getElementById('root');

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderMenu(items) {
  root.textContent = '';
  // Клік поза меню закриває його.
  root.onmousedown = (e) => { if (e.target === root) api.cmd('closeOverlay'); };
  const menu = el('div', 'menu');
  for (const it of items) {
    if (it.sep) { menu.append(el('hr')); continue; }
    const b = el('button');
    b.append(el('span', null, it.label), el('span', 'hint', it.hint || ''));
    b.title = it.tip ? it.label + ' — ' + it.tip : it.label;
    b.onclick = () => api.cmd('menuRun', { cmd: it.cmd, arg: it.arg });
    menu.append(b);
  }
  root.append(menu);
}

const ICONS = { search: '🔍', url: '🌐', bookmark: '★', history: '🕘' };

function renderSuggest(items, selected) {
  root.textContent = '';
  root.onmousedown = null;
  const box = el('div', 'sg');
  items.forEach((it, i) => {
    const row = el('div', 'row' + (i === selected ? ' sel' : ''));
    row.append(el('span', 'ic', ICONS[it.type] || '🌐'));
    if (it.type === 'search' || it.type === 'url') {
      row.append(el('span', 't', it.title));
      row.append(el('span', 'u', it.type === 'search' ? '— пошук' : '— перейти'));
    } else {
      row.append(el('span', 't', it.title || it.url));
      row.append(el('span', 'u', it.url));
    }
    row.title = it.type === 'search' || it.type === 'url' ? (it.type === 'search' ? 'Шукати: ' : 'Перейти: ') + it.title : (it.title || '') + '\n' + it.url;
    // mousedown, а не click: поле адреси втрачає фокус ще до відпускання кнопки миші
    row.onmousedown = (e) => { e.preventDefault(); api.cmd('pickSuggest', it.url); };
    box.append(row);
  });
  root.append(box);
}

// ---------- інформація про сайт ----------
function renderSite(p) {
  root.textContent = '';
  root.onmousedown = (e) => { if (e.target === root) api.cmd('closeOverlay'); };
  const box = el('div', 'site');
  box.style.left = Math.max(8, p.x || 8) + 'px';
  box.append(el('div', 'vh', p.host || (p.kind === 'internal' ? 'Сторінка W3IR Browser' : p.kind === 'file' ? 'Локальний файл' : 'Сторінка')));
  const conn = {
    https: ['🔒', 'З’єднання захищене (https)'], http: ['⚠', 'З’єднання не захищене (http): не вводьте паролі та платіжні дані'],
    internal: ['ⓘ', 'Внутрішня сторінка браузера'], file: ['ⓘ', 'Файл на вашому комп’ютері'], none: ['ⓘ', 'Немає адреси'], other: ['ⓘ', 'Особлива сторінка'],
  }[p.kind] || ['ⓘ', ''];
  box.append(el('div', 'sconn' + (p.kind === 'http' ? ' warn' : ''), conn[0] + ' ' + conn[1]));
  if (p.container) box.append(el('div', 'vtxt', p.container));
  if (p.incognito) box.append(el('div', 'vtxt', 'Приватне вікно: дозволи діють лише до його закриття.'));

  if (p.perms) {
    box.append(el('div', 'gsec', 'Дозволи для сайту'));
    const NAMES = { media: 'Камера та мікрофон', geolocation: 'Місцезнаходження', notifications: 'Сповіщення', 'clipboard-read': 'Читання буфера обміну' };
    for (const perm of Object.keys(p.permLabels)) {
      const row = el('div', 'srow');
      row.append(el('span', null, NAMES[perm] || perm));
      const sel = el('select');
      for (const [val, text] of [['null', 'Запитувати'], ['true', 'Дозволити'], ['false', 'Заблокувати']]) {
        const o = el('option', null, text);
        o.value = val;
        if (String(p.perms[perm]) === val) o.selected = true;
        sel.append(o);
      }
      sel.title = 'Запитувати — браузер спитає, коли сайт попросить доступ';
      sel.onchange = () => api.cmd('sitePerm', { perm, value: sel.value === 'null' ? null : sel.value === 'true' });
      row.append(sel);
      box.append(row);
    }
    box.append(el('div', 'vtxt', 'Зміни діють після перезавантаження сторінки.'));

    box.append(el('div', 'gsec', 'Приватність'));
    const ab = el('label', 'srow');
    ab.append(el('span', null, p.adblock.enabled ? `Блокування реклами (заблоковано: ${p.adblock.blocked})` : 'Блокування реклами вимкнене глобально'));
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = p.adblock.enabled && !p.adblock.allowed; cb.disabled = !p.adblock.enabled;
    cb.title = 'Вимкніть, якщо сайт працює неправильно: виняток діє лише для цього сайту, сторінка перезавантажиться';
    cb.onchange = () => api.cmd('siteAdblock', { allowed: !cb.checked });
    ab.append(cb);
    box.append(ab);

    if (p.dark !== null && p.dark !== undefined) {
      box.append(el('div', 'gsec', 'Вигляд'));
      const dk = el('label', 'srow');
      dk.append(el('span', null, 'Темний вигляд сайту'));
      const dcb = el('input'); dcb.type = 'checkbox'; dcb.checked = !!p.dark;
      dcb.title = 'Інвертує кольори сторінки лише для цього сайту; зображення й відео лишаються звичайними. Не потребує перезавантаження';
      dcb.onchange = () => api.cmd('siteDark', { on: dcb.checked });
      dk.append(dcb);
      box.append(dk);
    }

    const clear = el('button', 'vbtn', `Очистити cookie та дані сайту (${p.cookies})`);
    clear.title = 'Видаляє cookie й локальні дані цього сайту: ви вийдете з акаунтів на ньому';
    let armed = false;
    clear.onclick = () => {
      if (!armed) { armed = true; clear.textContent = 'Натисніть ще раз для підтвердження'; clear.classList.add('primary'); setTimeout(() => { armed = false; }, 4000); return; }
      api.cmd('siteClear');
    };
    box.append(clear);
  } else {
    box.append(el('div', 'vtxt', 'Для цієї сторінки окремих налаштувань сайту немає.'));
  }
  const all = el('button', 'vbtn', 'Усі дозволи й винятки…');
  all.onclick = () => api.cmd('menuRun', { cmd: 'openPage', arg: 'settings' });
  all.title = 'Налаштування → Дозволи та винятки сайтів';
  const allRow = el('div', 'vrow');
  allRow.append(all);
  box.append(allRow);
  root.append(box);
  box.style.left = Math.max(8, Math.min(parseFloat(box.style.left) || 8, innerWidth - box.offsetWidth - 8)) + 'px';
}

// ---------- підтвердження дій гаманця ----------
function renderApprove(p) {
  root.textContent = '';
  root.onmousedown = null; // клік повз вікно НЕ закриває запит
  const box = el('div', 'appr' + (p.danger ? ' danger' : ''));
  box.append(el('div', 'ah', p.title));
  box.append(el('div', 'aorigin', p.origin));
  const grid = el('div', 'alines');
  for (const [k, v] of p.lines || []) { grid.append(el('div', 'ak', k), el('div', 'av', v)); }
  let pick = null;
  if (p.choice) {
    pick = el('select', 'asel');
    pick.setAttribute('aria-label', p.choice.label);
    for (const o of p.choice.options) { const opt = el('option', null, o.label); opt.value = o.value; pick.append(opt); }
    pick.value = p.choice.value;
    const cell = el('div', 'av'); cell.append(pick);
    grid.append(el('div', 'ak', p.choice.label), cell);
  }
  let pick2 = null;
  if (p.choice2) {
    pick2 = el('select', 'asel');
    pick2.setAttribute('aria-label', p.choice2.label);
    for (const o of p.choice2.options) { const opt = el('option', null, o.label); opt.value = o.value; pick2.append(opt); }
    pick2.value = p.choice2.value;
    const cell2 = el('div', 'av'); cell2.append(pick2);
    grid.append(el('div', 'ak', p.choice2.label), cell2);
  }
  box.append(grid);
  for (const w of p.warnings || []) box.append(el('div', 'awarn', '⚠ ' + w));
  let pass = null;
  const err = el('div', 'verr');
  if (p.needsUnlock || p.needsAuth) {
    box.append(el('div', 'vtxt', p.needsUnlock ? 'Сховище заблоковано. Введіть майстер-пароль, щоб розблокувати та підтвердити.' : 'Для підтвердження введіть майстер-пароль.'));
    pass = el('input'); pass.type = 'password'; pass.placeholder = 'Майстер-пароль'; pass.autocomplete = 'off';
    box.append(pass);
  }
  box.append(err);
  if (p.lines && p.lines.length) {
    const aiBtn = el('button', 'ai-btn', '🤖 Пояснити дію через ШІ');
    aiBtn.type = 'button';
    aiBtn.title = 'Отримати просте пояснення від локальної моделі Ollama (100% приватно)';
    let aiBox = null;
    aiBtn.onclick = async () => {
      aiBtn.disabled = true;
      aiBtn.textContent = 'Аналізуємо транзакцію локально…';
      if (!aiBox) {
        aiBox = el('div', 'ai-box loading');
        box.insertBefore(aiBox, row);
      }
      aiBox.textContent = 'Запит до локальної моделі…';
      const r = await api.cmd('explainTx', { title: p.title, origin: p.origin, lines: p.lines, warnings: p.warnings });
      aiBtn.disabled = false;
      aiBox.classList.remove('loading');
      aiBox.textContent = '';
      if (r && r.ok) {
        aiBtn.textContent = '🤖 Оновити пояснення ШІ';
        const hdr = el('div', 'ai-hdr');
        hdr.append(el('span', null, 'Пояснення ШІ (локально)'), el('span', 'ai-model', r.model || ''));
        const txt = el('div', 'ai-txt', r.text);
        aiBox.append(hdr, txt);
      } else {
        aiBtn.textContent = '🤖 Спробувати знову';
        const errTxt = el('div', 'ai-err', (r && r.error) || 'Не вдалося отримати пояснення.');
        aiBox.append(errTxt);
      }
    };
    box.append(aiBtn);
  }
  const row = el('div', 'vrow');
  const no = el('button', 'vbtn', 'Відхилити');
  const yes = el('button', 'vbtn primary', 'Підтвердити');
  const decide = async (approve) => {
    yes.disabled = no.disabled = true;
    const r = await api.cmd('walletDecision', { id: p.id, approve, master: pass ? pass.value : '', choice: pick ? pick.value : undefined, choice2: pick2 ? pick2.value : undefined });
    if (pass) pass.value = '';
    yes.disabled = no.disabled = false;
    if (r && !r.ok) { err.textContent = r.error || 'Помилка'; if (pass) pass.focus(); }
  };
  no.onclick = () => decide(false);
  yes.onclick = () => decide(true);
  if (p.delay > 0) { // пауза для великих сум: «Підтвердити» вмикається після відліку
    let left = Math.min(Number(p.delay), 30);
    yes.disabled = true; yes.textContent = `Підтвердити (${left})`;
    const iv = setInterval(() => { left--; if (left <= 0) { clearInterval(iv); yes.disabled = false; yes.textContent = 'Підтвердити'; } else yes.textContent = `Підтвердити (${left})`; }, 1000);
  }
  no.title = 'Відхилити запит сайту (Esc). Нічого не буде підписано чи надіслано';
  yes.title = 'Підтвердити дію після перевірки сайту й деталей';
  if (pass) pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') decide(true); });
  row.append(no, yes);
  box.append(row);
  root.append(box);
  setTimeout(() => (pass ? pass.focus() : no.focus()), 30); // за замовчуванням фокус на «Відхилити»
}

// ---------- панель GitHub ----------
function ago(ts) {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return 'щойно';
  if (m < 60) return `${m} хв`;
  if (m < 1440) return `${Math.round(m / 60)} год`;
  return `${Math.round(m / 1440)} дн`;
}

function renderGithub(p) {
  root.textContent = '';
  root.onmousedown = (e) => { if (e.target === root) api.cmd('closeOverlay'); };
  const box = el('div', 'ghp');
  box.append(el('div', 'vh', 'GitHub' + (p.login ? ' · ' + p.login : '')));
  if (p.error) box.append(el('div', 'verr', p.error));
  const section = (title, items, mk) => {
    box.append(el('div', 'gsec', `${title} (${items.length})`));
    if (!items.length) { box.append(el('div', 'vtxt', 'Порожньо')); return; }
    for (const it of items) {
      const b = el('button', 'gitem');
      b.append(el('span', 'gt', it.title), el('span', 'gs', mk(it)));
      b.onclick = () => api.cmd('githubOpen', { url: it.url, id: it.id });
      b.title = `${it.title}\n${it.url}\nКлік — відкрити у новій вкладці`;
      box.append(b);
    }
  };
  section('Запити на рев’ю', p.reviews, (it) => `${it.repo} #${it.number} · ${ago(it.updated)}`);
  section('Сповіщення', p.notifications, (it) => `${it.repo} · ${it.type} · ${it.reason} · ${ago(it.updated)}`);
  const row = el('div', 'vrow');
  const a = el('button', 'vbtn', 'Оновити'); a.onclick = () => api.cmd('githubRefresh'); a.title = 'Запитати GitHub про нові сповіщення';
  const b = el('button', 'vbtn', 'Усе прочитано'); b.onclick = () => api.cmd('githubReadAll'); b.title = 'Позначити всі сповіщення прочитаними на GitHub';
  row.append(a, b);
  box.append(row);
  root.append(box);
}

// ---------- панель паролів ----------
function renderVault(p) {
  root.textContent = '';
  root.onmousedown = (e) => { if (e.target === root) api.cmd('closeOverlay'); };
  const box = el('div', 'vlt');
  box.append(el('div', 'vh', 'Менеджер паролів'));

  const open = () => api.cmd('menuRun', { cmd: 'openPage', arg: 'passwords' });
  if (p.status === 'none') {
    box.append(el('div', 'vtxt', 'Сховище ще не створено. Паролі шифруються майстер-паролем і зберігаються лише на цьому комп\u2019ютері.'));
    const b = el('button', 'vbtn primary', 'Створити сховище');
    b.onclick = open;
    b.title = 'Відкриє сторінку, де потрібно задати майстер-пароль';
    box.append(b);
  } else if (p.status === 'locked') {
    box.append(el('div', 'vtxt', 'Введіть майстер-пароль, щоб розблокувати сховище.'));
    const input = el('input');
    input.type = 'password';
    input.placeholder = 'Майстер-пароль';
    input.autocomplete = 'off';
    const err = el('div', 'verr');
    const go = el('button', 'vbtn primary', 'Розблокувати');
    const submit = async () => {
      go.disabled = true;
      const r = await api.cmd('vaultUnlock', input.value);
      input.value = '';
      go.disabled = false;
      if (r && !r.ok) { err.textContent = r.error; input.focus(); }
    };
    go.onclick = submit;
    go.title = 'Розблокувати сховище (Enter)';
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    box.append(input, err, go);
    setTimeout(() => input.focus(), 30);
  } else {
    if (!p.canFill) box.append(el('div', 'vtxt', p.secureOnly ? 'Автозаповнення вимкнено на незахищених (http) сторінках.' : 'Для цієї сторінки автозаповнення недоступне.'));
    else if (!p.entries.length) box.append(el('div', 'vtxt', `Для ${p.host} збережених паролів немає.`));
    else {
      box.append(el('div', 'vtxt', `Заповнити для ${p.host}:`));
      for (const e of p.entries) {
        const b = el('button', 'vitem', e.username || '(без імені користувача)');
        b.onclick = () => api.cmd('vaultFill', e.id);
        b.title = 'Підставити логін і пароль на цій сторінці';
        box.append(b);
      }
    }
    const row = el('div', 'vrow');
    const m = el('button', 'vbtn', 'Керувати паролями');
    m.onclick = open;
    m.title = 'Додати, змінити, видалити паролі; резервна копія та імпорт';
    const l = el('button', 'vbtn', 'Заблокувати');
    l.onclick = () => api.cmd('vaultLock');
    l.title = 'Негайно заблокувати сховище паролів і гаманець';
    row.append(m, l);
    box.append(row);
  }
  root.append(box);
}

// ---------- палітра команд (Ctrl+K) ----------
const KIND_ICON = { tab: '🗂', cmd: '⌘', bookmark: '★', history: '🕘', search: '🔍', url: '🌐' };

function renderPalette(data) {
  root.textContent = '';
  root.onmousedown = (e) => { if (e.target === root) api.cmd('closeOverlay'); };
  const box = el('div', 'pal');
  const input = el('input');
  input.placeholder = data.mode === 'tabs' ? 'Пошук по відкритих вкладках' : 'Вкладки, команди, закладки, історія — або введіть адресу чи запит';
  input.spellcheck = false;
  const list = el('div', 'plist');
  box.append(input, list);
  root.append(box);

  let items = [], sel = 0;
  const run = (it, newTab) => {
    if (it.kind === 'tab') api.cmd('paletteRun', { kind: 'tab', id: it.id });
    else if (it.kind === 'cmd') api.cmd('paletteRun', { kind: 'cmd', cmd: it.cmd, arg: it.arg });
    else api.cmd('paletteRun', { kind: 'url', url: it.url, newTab });
  };
  const match = (it, tokens) => {
    const hay = ((it.title || it.label || '') + ' ' + (it.url || '')).toLowerCase();
    return tokens.every(t => hay.includes(t));
  };
  function compute() {
    const q = input.value.trim();
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    const push = (kind, arr, limit, map) => {
      let n = 0;
      for (const x of arr || []) {
        if (n >= limit) break;
        if (tokens.length && !match(x, tokens)) continue;
        out.push(map(x)); n++;
      }
    };
    push('tab', data.tabs, 8, x => ({ kind: 'tab', id: x.id, title: x.title || x.url || 'Нова вкладка', sub: x.url }));
    if (data.mode !== 'tabs') {
      push('cmd', data.commands, tokens.length ? 6 : 8, x => ({ kind: 'cmd', cmd: x.cmd, arg: x.arg, title: x.label, sub: x.hint || '', tip: x.tip }));
      if (tokens.length) {
        push('bookmark', data.bookmarks, 5, x => ({ kind: 'bookmark', url: x.url, title: x.title || x.url, sub: x.url }));
        push('history', data.history, 6, x => ({ kind: 'history', url: x.url, title: x.title || x.url, sub: x.url }));
        out.push({ kind: 'search', url: q, title: q, sub: 'пошук або перехід (Shift+Enter — у новій вкладці)' });
      }
    }
    items = out.slice(0, 14);
    sel = Math.min(sel, Math.max(0, items.length - 1));
  }
  function draw() {
    list.textContent = '';
    items.forEach((it, i) => {
      const row = el('div', 'prow' + (i === sel ? ' sel' : ''));
      row.append(el('span', 'ic', KIND_ICON[it.kind]), el('span', 't', it.title), el('span', 'u', it.sub || ''));
      row.title = it.kind === 'cmd' ? (it.title + (it.tip ? ' — ' + it.tip : '')) : it.kind === 'tab' ? `Перейти до вкладки: ${it.title}${it.sub ? '\n' + it.sub : ''}` : (it.title || '') + (it.sub ? '\n' + it.sub : '');
      row.onmousedown = (e) => { e.preventDefault(); run(it, e.shiftKey); };
      list.append(row);
    });
    const s = list.querySelector('.sel');
    if (s) s.scrollIntoView({ block: 'nearest' });
  }
  input.addEventListener('input', () => { sel = 0; compute(); draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % Math.max(1, items.length); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel + items.length - 1) % Math.max(1, items.length); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[sel]) run(items[sel], e.shiftKey); }
    else if (e.key === 'Escape') api.cmd('closeOverlay');
  });
  compute(); draw();
  setTimeout(() => input.focus(), 30);
}

// ---------- деталі захисту W3IR Shield ----------
function renderShield(p) {
  root.textContent = '';
  root.onmousedown = (e) => { if (e.target === root) api.cmd('closeOverlay'); };
  const box = el('div', 'shld');
  if (p.right != null) box.style.right = Math.max(8, p.right) + 'px';
  else box.style.right = '48px';

  const hdr = el('div', 'shld-hdr');
  const leftHdr = el('div');
  leftHdr.append(el('div', 'vh', 'W3IR Shield'));
  leftHdr.append(el('div', 'shld-sub', 'Центр контролю приватності'));
  hdr.append(leftHdr);
  if (p.host) {
    const hostEl = el('div', 'shld-host', p.host);
    hostEl.title = p.host;
    hdr.append(hostEl);
  }
  box.append(hdr);

  if (p.isWeb) {
    const mainToggle = el('label', 'shld-main-toggle');
    const toggleInfo = el('div', 'shld-toggle-info');
    const toggleTitle = el('div', 'shld-toggle-title', p.adblockActive ? 'Захист W3IR Shield активний' : 'Захист вимкнено для сайту');
    const toggleSub = el('div', 'shld-toggle-sub', p.adblockActive ? 'Блокування трекерів, реклами та відбитків' : 'Сайт додано до білого списку винятків');
    toggleInfo.append(toggleTitle, toggleSub);

    const toggleSwitch = el('input');
    toggleSwitch.type = 'checkbox';
    toggleSwitch.checked = p.adblockActive;
    toggleSwitch.title = 'Перемикач захисту для поточного сайту (перезавантажить сторінку)';
    toggleSwitch.onchange = () => {
      api.cmd('siteAdblock', { allowed: !toggleSwitch.checked });
    };
    mainToggle.append(toggleInfo, toggleSwitch);
    box.append(mainToggle);
  } else {
    box.append(el('div', 'vtxt', 'Внутрішня сторінка або файл: зовнішні трекери відсутні.'));
  }

  box.append(el('div', 'gsec', 'Стан модулів приватності'));
  const stats = el('div', 'shld-stats');

  // 1. Блокування трекерів та реклами
  const trkRow = el('div', 'shld-row');
  const trkLabel = el('div', 'shld-item-info');
  trkLabel.append(el('span', 'shld-label-title', '🛡 Реклама й трекери'));
  trkLabel.append(el('div', 'shld-label-desc', p.adblockEnabled ? 'EasyList + EasyPrivacy' : 'Вимкнено глобально'));
  const trkBadge = el('span', 'shld-badge' + (p.blockedCount > 0 ? ' active' : ' neutral'), `${p.blockedCount || 0} заблоковано`);
  trkBadge.title = 'Кількість заблокованих небажаних запитів на активній вкладці';
  trkRow.append(trkLabel, trkBadge);
  stats.append(trkRow);

  // 2. Сторонні cookie
  const ckRow = el('div', 'shld-row');
  const ckLabel = el('div', 'shld-item-info');
  ckLabel.append(el('span', 'shld-label-title', '🍪 Сторонні cookie'));
  const ckBlocked = p.thirdPartyCookiesBlocked;
  const protName = p.protLevel === 'maximum' ? 'Максимальний' : p.protLevel === 'strict' ? 'Суворий' : 'Стандартний';
  ckLabel.append(el('div', 'shld-label-desc', ckBlocked ? `Блокуються (режим «${protName}»)` : 'Дозволено (режим «Стандартний»)'));
  const ckBadge = el('span', 'shld-badge' + (ckBlocked ? ' active' : ' neutral'), ckBlocked ? 'Заблоковано' : 'Дозволено');
  ckRow.append(ckLabel, ckBadge);
  stats.append(ckRow);

  // 3. Захист від відбитків (fingerprinting)
  const fpRow = el('div', 'shld-row');
  const fpLabel = el('div', 'shld-item-info');
  fpLabel.append(el('span', 'shld-label-title', '🎭 Захист від відбитків'));
  fpLabel.append(el('div', 'shld-label-desc', p.fpActive ? 'Шум Canvas + нормалізація розмірів' : 'Вимкнено'));
  const fpBadge = el('span', 'shld-badge' + (p.fpActive ? ' active' : ' neutral'), p.fpActive ? 'Активно' : 'Вимкнено');
  fpRow.append(fpLabel, fpBadge);
  stats.append(fpRow);

  // 4. WebRTC IP
  const rtcRow = el('div', 'shld-row');
  const rtcLabel = el('div', 'shld-item-info');
  rtcLabel.append(el('span', 'shld-label-title', '🌐 WebRTC (захист IP)'));
  const rtcText = p.webrtc === 'disable_non_proxied_udp' ? 'Без прямого UDP (лише через проксі)' : p.webrtc === 'default_public_interface_only' ? 'Лише публічний інтерфейс' : 'Звичайний (всі інтерфейси)';
  rtcLabel.append(el('div', 'shld-label-desc', rtcText));
  const rtcBadge = el('span', 'shld-badge' + (p.webrtc !== 'default' ? ' active' : ' neutral'), p.webrtc !== 'default' ? 'Захищено' : 'Звичайний');
  rtcRow.append(rtcLabel, rtcBadge);
  stats.append(rtcRow);

  // 5. Очищення трекінгових параметрів URL
  const urlRow = el('div', 'shld-row');
  const urlLabel = el('div', 'shld-item-info');
  urlLabel.append(el('span', 'shld-label-title', '🧹 Очищення посилань'));
  urlLabel.append(el('div', 'shld-label-desc', p.stripTracking ? 'Видалення utm_*, fbclid, gclid' : 'Вимкнено'));
  const urlBadge = el('span', 'shld-badge' + (p.stripTracking ? ' active' : ' neutral'), p.stripTracking ? 'Активно' : 'Вимкнено');
  urlRow.append(urlLabel, urlBadge);
  stats.append(urlRow);

  box.append(stats);

  // Bottom buttons
  const bRow = el('div', 'vrow');
  const setBtn = el('button', 'vbtn', 'Налаштування захисту…');
  setBtn.onclick = () => { api.cmd('closeOverlay'); api.cmd('menuRun', { cmd: 'openPage', arg: 'settings' }); };
  bRow.append(setBtn);

  if (p.isWeb && p.cookies > 0) {
    const clrBtn = el('button', 'vbtn', `Очистити cookie (${p.cookies})`);
    clrBtn.title = 'Видалити всі збережені cookie та локальні дані для цього сайту';
    let armed = false;
    clrBtn.onclick = () => {
      if (!armed) { armed = true; clrBtn.textContent = 'Підтвердити?'; clrBtn.classList.add('primary'); setTimeout(() => { armed = false; }, 3500); return; }
      api.cmd('siteClear');
    };
    bRow.append(clrBtn);
  }
  box.append(bRow);

  root.append(box);
}

api.on('overlay', (p) => {
  if (p.type === 'menu') renderMenu(p.items);
  else if (p.type === 'suggest') renderSuggest(p.items, p.selected);
  else if (p.type === 'palette') renderPalette(p);
  else if (p.type === 'vault') renderVault(p);
  else if (p.type === 'github') renderGithub(p);
  else if (p.type === 'approve') renderApprove(p);
  else if (p.type === 'site') renderSite(p);
  else if (p.type === 'shield') renderShield(p);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') api.cmd('closeOverlay'); });
