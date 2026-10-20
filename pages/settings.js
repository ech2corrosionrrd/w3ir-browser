'use strict';
async function main() {
  const { settings, engines, incognito, version, adblockEngine, extensions, theme, language, languages } = await w3ir.invoke('settings:get');
  const save = (patch) => w3ir.invoke('settings:set', patch);

  const toggle = (key, title, desc) => {
    const cb = h('input', { type: 'checkbox', class: 'switch', checked: !!settings[key], onchange: () => save({ [key]: cb.checked }) });
    return h('div', { class: 'row', title: desc || title }, h('div', null, h('div', null, title), desc && h('div', { class: 'd' }, desc)), cb);
  };
  const select = (key, title, options, desc) => {
    const s = h('select', { onchange: () => save({ [key]: s.value }) },
      Object.entries(options).map(([v, label]) => h('option', { value: v, selected: settings[key] === v }, label)));
    return h('div', { class: 'row', title: desc || title }, h('div', null, h('div', null, title), desc && h('div', { class: 'd' }, desc)), s);
  };
  const text = (key, title, desc, placeholder) => {
    const i = h('input', { type: 'text', value: settings[key] || '', placeholder, style: 'width:280px', spellcheck: false });
    i.addEventListener('change', () => save({ [key]: i.value.trim() }));
    return h('div', { class: 'row', title: desc || title }, h('div', null, h('div', null, title), desc && h('div', { class: 'd' }, desc)), i);
  };

  const cookies = h('input', { type: 'checkbox', checked: true });
  const cache = h('input', { type: 'checkbox', checked: true });
  const hist = h('input', { type: 'checkbox', checked: true });
  const status = h('span', { class: 'note' });
  const clear = h('button', { class: 'danger', onclick: async () => {
    await w3ir.invoke('clear', { cookies: cookies.checked, cache: cache.checked, history: hist.checked });
    status.textContent = ' Готово.';
  } }, 'Очистити');

  const extBox = h('div', { class: 'list' });
  const renderExt = (items) => {
    extBox.textContent = '';
    for (const x of items) {
      extBox.append(h('div', { class: 'row' }, h('div', null, h('div', null, x.name || x.path), h('div', { class: 'd' }, x.path)),
        h('button', { class: 'danger', onclick: async () => renderExt(await w3ir.invoke('ext:remove', { path: x.path })) }, 'Видалити')));
    }
    const err = h('span', { class: 'note' });
    extBox.append(h('div', { class: 'row' }, h('div', null, 'Підтримується частина API Chrome (контентні скрипти, прості розширення). Завантажте розпаковану папку з manifest.json.', err),
      h('button', { onclick: async () => {
        try { renderExt(await w3ir.invoke('ext:add')); } catch (e) { err.textContent = ' ' + String(e.message).replace(/^.*Error: /, ''); }
      } }, 'Додати розширення…')));
  };
  renderExt(extensions || []);

  // ---------- дозволи та винятки сайтів ----------
  const sitesBox = h('div', { class: 'list' });
  const PERM_NAMES = { media: 'Камера/мікрофон', geolocation: 'Геолокація', notifications: 'Сповіщення', 'clipboard-read': 'Читання буфера обміну' };
  const renderSites = async () => {
    const r = await w3ir.invoke('sites:list');
    sitesBox.textContent = '';
    if (!r.perms.length && !r.adblockAllow.length) sitesBox.append(h('div', { class: 'row' }, 'Збережених дозволів і винятків немає. Їх можна змінити кліком на замок в адресному рядку.'));
    for (const p of r.perms) {
      sitesBox.append(h('div', { class: 'row' }, h('div', null, h('div', null, p.origin), h('div', { class: 'd' }, `${PERM_NAMES[p.perm] || p.perm}: ${p.value ? 'дозволено' : 'заблоковано'}`)),
        h('button', { onclick: async () => { await w3ir.invoke('sites:resetPerm', { origin: p.origin, perm: p.perm }); renderSites(); } }, 'Скинути')));
    }
    for (const d of r.adblockAllow) {
      sitesBox.append(h('div', { class: 'row' }, h('div', null, h('div', null, d), h('div', { class: 'd' }, 'Блокування реклами вимкнено для цього сайту')),
        h('button', { onclick: async () => { await w3ir.invoke('sites:adblockRemove', { domain: d }); renderSites(); } }, 'Увімкнути блокування')));
    }
    if (r.perms.length) sitesBox.append(h('div', { class: 'row' }, h('div', { class: 'd' }, 'Скинути всі збережені дозволи сайтів'), h('button', { class: 'danger', onclick: async () => { if (confirm('Скинути всі збережені дозволи?')) { await w3ir.invoke('sites:resetAllPerms'); renderSites(); } } }, 'Скинути всі')));
  };
  renderSites();

  // ---------- захист від шахрайських сайтів ----------
  const safeBox = h('div', { class: 'list' });
  const renderSafe = async () => {
    const st = await w3ir.invoke('safe:status');
    safeBox.textContent = '';
    const when = st.updated ? new Date(st.updated).toLocaleString(LOCALE) : 'ще не завантажувались';
    const btn = h('button', { disabled: st.updating, onclick: async () => { btn.disabled = true; btn.textContent = 'Оновлюємо…'; await w3ir.invoke('safe:update'); renderSafe(); } }, 'Оновити списки');
    safeBox.append(h('div', { class: 'row', title: 'Списки зберігаються на вашому комп’ютері у стиснутому вигляді; адреси, які ви відвідуєте, нікуди не надсилаються' },
      h('div', null, h('div', null, `Списки загроз: шкідливих хостів ${st.counts.malware.toLocaleString(LOCALE)}, фішингових доменів ${st.counts.phishing.toLocaleString(LOCALE)}`),
        h('div', { class: 'd' }, `Оновлено: ${when}. Джерела: ${st.sources.join(', ')}. Оновлення раз на добу.`), st.error ? h('div', { class: 'merr' }, st.error) : ''), btn));
  };
  renderSafe();

  // ---------- оновлення ----------
  const updBox = h('div', { class: 'list' });
  const renderUpd = async () => {
    const st = await w3ir.invoke('update:status');
    updBox.textContent = '';
    const text = {
      idle: st.feedValid ? 'Оновлень ще не перевіряли' : 'Джерело оновлень не налаштовано', checking: 'Перевіряємо…', none: 'Встановлено найновішу версію',
      available: `Знайдено версію ${st.version}`, downloading: `Завантажуємо ${st.version || ''}… ${st.percent || 0} %`, ready: `Версію ${st.version} завантажено й перевірено — готово до встановлення`, error: 'Помилка оновлення',
    }[st.state] || st.state;
    const feed = h('input', { type: 'text', value: st.feed, placeholder: st.defaultFeed ? `за замовчуванням: ${st.defaultFeed}` : 'github:власник/репозиторій  або  https://сайт/оновлення/', style: 'width:340px', spellcheck: false });
    const feedMsg = h('div', { class: 'merr' });
    feed.addEventListener('change', async () => {
      const r = await w3ir.invoke('update:setFeed', { feed: feed.value });
      feedMsg.textContent = r.ok ? '' : r.error;
      if (r.ok) renderUpd();
    });
    const auto = h('input', { type: 'checkbox', class: 'switch', checked: st.autoUpdate, onchange: () => w3ir.invoke('update:setAuto', { on: auto.checked }) });
    updBox.append(
      h('div', { class: 'row' }, h('div', null, h('div', null, `Версія ${st.current}`), h('div', { class: 'd' }, text + (st.checkedAt ? ` · перевірено ${new Date(st.checkedAt).toLocaleString(LOCALE)}` : '')),
        st.error ? h('div', { class: 'merr' }, st.error) : '', st.notes ? h('div', { class: 'd' }, st.notes) : ''),
        st.state === 'ready'
          ? h('button', { class: 'primary', title: 'Закриє браузер, встановить оновлення й запустить його знову', onclick: async () => { await w3ir.invoke('update:install'); renderUpd(); } }, 'Встановити та перезапустити')
          : st.state === 'available'
            ? h('button', { class: 'primary', onclick: async () => { await w3ir.invoke('update:download'); renderUpd(); } }, 'Завантажити оновлення')
            : h('button', { class: 'primary', disabled: st.state === 'checking' || st.state === 'downloading', onclick: async () => { await w3ir.invoke('update:check'); renderUpd(); } }, 'Перевірити оновлення')),
      h('div', { class: 'row', title: 'Нова версія завантажується у фоні; встановлюється після вашого підтвердження або при наступному виході з браузера' }, h('div', null, h('div', null, 'Завантажувати оновлення автоматично'), h('div', { class: 'd' }, 'Перевірка кожні 6 годин. Без цього параметра браузер лише повідомляє про нову версію')), auto),
      h('div', { class: 'row' }, h('div', { style: 'flex:1' }, h('div', null, 'Джерело оновлень'), h('div', { class: 'd' }, `Залиште порожнім, щоб використовувати офіційне джерело. Лише https або github:власник/репозиторій. Кожне оновлення перевіряється підписом випускача (Ed25519, відбиток ключа: ${st.fingerprint}) — підроблений файл не буде встановлено.`), feed, feedMsg)),
      st.logFile ? h('div', { class: 'row', title: 'У журнал записуються перевірки, завантаження та спроби встановлення' }, h('div', null, h('div', null, 'Журнал оновлень'), h('div', { class: 'd pw', style: 'user-select:text' }, st.logFile))) : '',
      st.packaged ? '' : h('div', { class: 'row' }, 'Режим розробки: оновлення працюють лише в встановленій версії.'));
  };
  renderUpd();
  setInterval(() => { if (document.visibilityState === 'visible') renderUpd(); }, 4000);

  // ---------- GitHub ----------
  const ghBox = h('div', { class: 'list' });
  const renderGh = async () => {
    const st = await w3ir.invoke('github:status');
    ghBox.textContent = '';
    if (st.connected) {
      ghBox.append(h('div', { class: 'row' },
        h('div', null, h('div', null, `GitHub підключено${st.login ? ': ' + st.login : ''}`),
          h('div', { class: 'd' }, `Сповіщень: ${st.unread}, запитів на рев’ю: ${st.reviews}`),
          st.error ? h('div', { class: 'merr' }, st.error) : ''),
        h('button', { class: 'danger', onclick: async () => { await w3ir.invoke('github:disconnect'); renderGh(); } }, 'Відключити')));
      return;
    }
    const tok = h('input', { type: 'password', placeholder: 'ghp_… (classic token)', autocomplete: 'off', style: 'width:280px' });
    const err = h('div', { class: 'merr' });
    ghBox.append(
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Токен доступу'), h('div', { class: 'd' }, 'Потрібен classic personal access token зі scope «notifications» (для приватних репозиторіїв — також «repo»). Токен шифрується захистом Windows і недоступний сайтам.'),
        h('a', { href: 'https://github.com/settings/tokens/new?scopes=notifications&description=W3IR%20Browser' }, 'Створити токен на GitHub')), tok),
      h('div', { class: 'row' }, err, h('button', { class: 'primary', onclick: async () => {
        err.textContent = '';
        const r = await w3ir.invoke('github:connect', { token: tok.value });
        tok.value = '';
        if (!r.ok) err.textContent = r.error; else renderGh();
      } }, 'Підключити')));
  };
  renderGh();
  // ---------- керування браузером ШІ (MCP) ----------
  const agBox = h('div', { class: 'list' });
  let agShow = false;
  let agTest = '';
  const renderAg = async () => {
    const st = await w3ir.invoke('agent:status');
    agBox.textContent = '';
    const run = async (name, arg) => { const r = await w3ir.invoke(name, arg); if (r && r.ok === false) alert(r.error || 'Помилка'); renderAg(); };
    agBox.append(h('div', { class: 'row' },
      h('div', null, h('div', null, 'Дозволити ШІ керувати браузером'),
        h('div', { class: 'd' }, 'Локальний сервер MCP на 127.0.0.1 (ззовні недоступний). ШІ працює в окремому тимчасовому вікні без ваших входів, паролів і гаманця; кожен новий сайт ви підтверджуєте самі.')),
      h('input', { type: 'checkbox', class: 'switch', checked: st.enabled, onchange: (ev) => run(ev.target.checked ? 'agent:enable' : 'agent:disable') })));
    if (!st.coveredOk) agBox.append(h('div', { class: 'row' }, h('div', { class: 'd' }, 'ℹ Щоб ШІ стабільно клікав і робив скріншоти, коли вікно браузера перекрите іншими програмами, перезапустіть браузер один раз (налаштування застосується при старті).')));
    if (st.error) agBox.append(h('div', { class: 'row' }, h('div', { class: 'merr' }, st.error)));
    if (!st.enabled) return;
    const token = agShow ? (await w3ir.invoke('agent:token')).token : '';
    const url = `http://127.0.0.1:${st.port}/mcp`;
    const copy = (txt, btn) => { navigator.clipboard.writeText(txt).then(() => { const o = btn.textContent; btn.textContent = 'Скопійовано'; setTimeout(() => { btn.textContent = o; }, 1500); }); };
    const testOut = h('div', { class: 'd', style: 'margin-top:4px' }, agTest || '');
    const testBtn = h('button', { onclick: async () => {
      testBtn.disabled = true; testBtn.textContent = 'Перевірка…';
      const r = await w3ir.invoke('agent:test');
      agTest = r.ok ? `✔ Сервер відповідає (${r.ms} мс), інструментів: ${r.tools}. ` + (r.client ? `Клієнт підключався: ${r.client.name}.` : 'Клієнт ще не підключався: виконайте команду підключення.') : `✘ ${r.error} Перевірте порт, файрвол і чи ввімкнено перемикач.`;
      renderAg();
    } }, 'Перевірити підключення');
    const port = h('input', { type: 'number', min: 1024, max: 65535, value: st.port, style: 'width:90px' });
    port.addEventListener('change', () => run('agent:setPort', { port: Number(port.value) }));
    agBox.append(
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Стан'), h('div', { class: 'd' }, (st.running ? `Сервер працює: ${url}` : 'Сервер не запущений') + (st.windowOpen ? ' · вікно ШІ відкрито' : ''))), port),
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Підключення клієнта'),
        h('div', { class: 'd' }, st.client ? `✔ ${st.client.name} ${st.client.version || ''} підключився ${new Date(st.client.at).toLocaleTimeString(LOCALE)}` : 'Ще ніхто не підключався: виконайте команду підключення нижче (після неї перезапустіть Claude Code), і тут з’явиться клієнт.'),
        testOut),
      testBtn),
      h('div', { class: 'row' }, h('div', { style: 'flex:1' }, h('div', null, 'Токен доступу'),
        h('div', { class: 'd' }, 'Секрет: хто його має, може керувати вікном ШІ. Зберігається зашифрованим (DPAPI). Нікому не передавайте.'),
        h('code', { style: 'word-break:break-all;user-select:all' }, agShow ? token : '••••••••••••••••••••••••')),
        h('button', { onclick: () => { agShow = !agShow; renderAg(); } }, agShow ? 'Сховати' : 'Показати'),
        h('button', { class: 'danger', title: 'Старий токен перестане працювати', onclick: () => run('agent:regenerate') }, 'Новий токен')));
    if (agShow && token) {
      const cmd = `claude mcp add --transport http w3ir-browser ${url} --header "Authorization: Bearer ${token}"`;
      const cfg = JSON.stringify({ mcpServers: { 'w3ir-browser': { type: 'http', url, headers: { Authorization: 'Bearer ' + token } } } }, null, 2);
      const b1 = h('button', null, 'Копіювати');
      const b2 = h('button', null, 'Копіювати');
      b1.addEventListener('click', () => copy(cmd, b1));
      b2.addEventListener('click', () => copy(cfg, b2));
      agBox.append(
        h('div', { class: 'row' }, h('div', { style: 'flex:1' }, h('div', null, 'Claude Code'), h('code', { style: 'word-break:break-all;user-select:all' }, cmd)), b1),
        h('div', { class: 'row' }, h('div', { style: 'flex:1' }, h('div', null, 'Інші клієнти MCP (JSON)'), h('pre', { style: 'white-space:pre-wrap;word-break:break-all;margin:4px 0;user-select:all' }, cfg)), b2));
    }
    agBox.append(h('div', { class: 'row' }, h('div', null, h('div', null, 'Спільні вкладки'), h('div', { class: 'd' }, st.shares.length ? st.shares.map(x => `${x.site} — ${x.mode === 'control' ? 'керування' : 'читання'}, до ${new Date(x.until).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })}`).join('; ') : 'Немає. Поділитися вкладкою: правий клік по вкладці → «ШІ: дозволити…» або Ctrl+K.')),
      st.shares.length ? h('button', { class: 'danger', onclick: () => run('agent:unshareAll') }, 'Припинити всі') : null));
    agBox.append(h('div', { class: 'row' }, h('div', null, h('div', null, 'Дозволені сайти цього сеансу'), h('div', { class: 'd' }, st.sites.length ? st.sites.join(', ') : 'Поки жодного. Закриття вікна ШІ скидає сеанс.')),
      h('button', { class: 'danger', onclick: () => run('agent:closeWindow') }, 'Закрити вікно ШІ')));
    if (st.log.length) agBox.append(h('div', { class: 'row' }, h('div', { style: 'flex:1' }, h('div', null, 'Останні дії ШІ'),
      h('div', { class: 'd', style: 'white-space:pre-wrap' }, st.log.slice(-12).reverse().map(l => `${l.t.slice(11, 19)}  ${l.tool}  ${l.detail}`).join('\n')))));
  };
  renderAg();
  setInterval(() => { if (document.visibilityState === 'visible' && !document.activeElement.matches('input')) renderAg(); }, 5000);
  const kw = h('textarea', { rows: 4, spellcheck: false, placeholder: 'rust = https://doc.rust-lang.org/std/?search=%s' });
  kw.value = settings.keywords || '';
  kw.addEventListener('change', () => save({ keywords: kw.value }));

  // ---------- синхронізація закладок ----------
  const syncBox = h('div', { class: 'list' });
  const renderSync = async () => {
    const st = await w3ir.invoke('sync:status');
    syncBox.textContent = '';
    if (!st.available) { syncBox.append(h('div', { class: 'row' }, 'Захищене сховище ключів недоступне в цій системі — синхронізація вимкнена.')); return; }
    if (st.enabled) {
      const when = st.lastSync ? new Date(st.lastSync).toLocaleString(LOCALE) : 'ще не виконувалась';
      syncBox.append(h('div', { class: 'row' },
        h('div', null, h('div', null, 'Синхронізація увімкнена'), h('div', { class: 'd' }, st.folder), h('div', { class: 'd' }, `Остання синхронізація: ${when}`),
          st.lastError ? h('div', { class: 'merr' }, st.lastError) : ''),
        h('div', null,
          h('button', { onclick: async () => { await w3ir.invoke('sync:now'); renderSync(); } }, 'Синхронізувати зараз'), ' ',
          h('button', { class: 'danger', onclick: async () => { await w3ir.invoke('sync:disable'); renderSync(); } }, 'Вимкнути'))));
      return;
    }
    let folder = '';
    const folderLbl = h('div', { class: 'd' }, 'Папку не вибрано');
    const pass = h('input', { type: 'password', placeholder: 'Парольна фраза (мін. 12 символів)', autocomplete: 'off', style: 'width:280px' });
    const err = h('div', { class: 'merr' });
    syncBox.append(
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Папка синхронізації'), folderLbl, h('div', { class: 'd' }, 'Виберіть папку, яку синхронізує OneDrive, Dropbox, Google Drive чи Syncthing. У ній буде лише зашифрований файл.')),
        h('button', { onclick: async () => { const f = await w3ir.invoke('sync:pickFolder'); if (f) { folder = f; folderLbl.textContent = f; } } }, 'Вибрати папку…')),
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Парольна фраза'), h('div', { class: 'd' }, 'Однакова на всіх ваших пристроях. Її неможливо відновити. Не зберігається на диску — лише ключ, захищений вашим акаунтом Windows.')), pass),
      h('div', { class: 'row' }, err, h('button', { class: 'primary', onclick: async () => {
        err.textContent = '';
        if (!folder) { err.textContent = 'Спершу виберіть папку.'; return; }
        const r = await w3ir.invoke('sync:enable', { folder, passphrase: pass.value });
        pass.value = '';
        if (!r.ok) err.textContent = r.error; else renderSync();
      } }, 'Увімкнути синхронізацію')));
  };
  renderSync();

  // ---------- сегментовані вкладки та живий пошук ----------
  const tabDefs = [
    { id: 'sec-general', label: 'Загальні', icon: '⚙️' },
    { id: 'sec-privacy', label: 'Приватність', icon: '🛡️' },
    { id: 'sec-passwords', label: 'Паролі', icon: '🔐' },
    { id: 'sec-wallet', label: 'Гаманець', icon: '💼' },
    { id: 'sec-ai', label: 'ШІ', icon: '🤖' },
    { id: 'sec-updates', label: 'Оновлення', icon: '📦' }
  ];

  const tabBtns = {};
  const activateTab = (targetId) => {
    for (const td of tabDefs) {
      const btn = tabBtns[td.id];
      if (btn) {
        const isCur = td.id === targetId;
        btn.classList.toggle('active', isCur);
        btn.setAttribute('aria-selected', isCur ? 'true' : 'false');
      }
    }
  };

  const tabsBar = h('div', { class: 'wtabs', role: 'tablist' }, tabDefs.map((td, i) => {
    const btn = h('button', {
      class: 'wtab' + (i === 0 ? ' active' : ''),
      role: 'tab',
      'aria-selected': i === 0 ? 'true' : 'false',
      onclick: () => {
        activateTab(td.id);
        const el = document.getElementById(td.id);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        try { history.replaceState(null, '', '#' + td.id); } catch {}
      }
    }, h('span', null, td.icon), h('span', null, td.label));
    tabBtns[td.id] = btn;
    return btn;
  }));

  const secToTab = {
    'sec-general': 'sec-general',
    'sec-privacy': 'sec-privacy',
    'sec-sites': 'sec-privacy',
    'sec-downloads': 'sec-general',
    'sec-passwords': 'sec-passwords',
    'sec-wallet': 'sec-wallet',
    'sec-sync': 'sec-general',
    'sec-updates': 'sec-updates',
    'sec-github': 'sec-general',
    'sec-ai': 'sec-ai',
    'sec-keywords': 'sec-general',
    'sec-defaultbrowser': 'sec-general',
    'sec-extensions': 'sec-general',
    'sec-features': 'sec-general',
    'sec-clear': 'sec-privacy'
  };

  window.syncActiveTab = (headId) => {
    const target = secToTab[headId] || headId;
    if (tabBtns[target]) activateTab(target);
  };

  const filterInput = h('input', {
    type: 'search',
    class: 'wfilter-input',
    placeholder: 'Пошук налаштувань…',
    autocomplete: 'off',
    spellcheck: false
  });
  const filterBar = h('div', { class: 'wfilter-bar', style: 'margin: 12px 0 16px' }, filterInput);
  const noMatches = h('div', { class: 'note', style: 'display:none;margin:18px 0;text-align:center;padding:20px;background:var(--card);border-radius:12px;border:1px dashed var(--line)' }, 'Нічого не знайдено');

  const onFilter = () => {
    const q = filterInput.value.trim().toLowerCase();
    const allRows = app.querySelectorAll('.list .row');
    if (!q) {
      allRows.forEach(r => { r.style.display = ''; });
      app.querySelectorAll('h2, .list').forEach(el => { el.style.display = ''; });
      noMatches.style.display = 'none';
      return;
    }
    let matchedTotal = 0;
    allRows.forEach(r => {
      const match = r.textContent.toLowerCase().includes(q);
      r.style.display = match ? '' : 'none';
      if (match) matchedTotal++;
    });
    const heads = [...app.querySelectorAll('main > h2')];
    heads.forEach((hd, i) => {
      const nextHd = heads[i + 1];
      let cur = hd.nextElementSibling;
      let hasVisible = false;
      while (cur && cur !== nextHd) {
        if (cur.classList && cur.classList.contains('list')) {
          const listVisible = [...cur.querySelectorAll('.row')].some(r => r.style.display !== 'none');
          cur.style.display = listVisible ? '' : 'none';
          if (listVisible) hasVisible = true;
        }
        cur = cur.nextElementSibling;
      }
      hd.style.display = hasVisible ? '' : 'none';
    });
    noMatches.style.display = matchedTotal === 0 ? 'block' : 'none';
  };
  filterInput.addEventListener('input', debounce(onFilter, 50));

  app.append(
    h('h1', null, 'Налаштування'),
    h('p', { class: 'note' }, 'Потрібна допомога? Відкрийте ', h('a', { href: 'w3ir://help' }, 'довідку'), ' (F1). Наведіть курсор на параметр, щоб побачити пояснення.'),
    incognito ? h('div', { class: 'note' }, 'Ви в режимі інкогніто: історія та cookie не зберігаються.') : '',
    filterBar,
    tabsBar,
    noMatches,
    h('h2', { id: 'sec-general' }, 'Загальні'),
    h('div', { class: 'list' },
      (() => {
        const sel = h('select', { onchange: () => save({ theme: sel.value }) },
          Object.entries({ system: 'Як у системі', light: 'Світла', dark: 'Темна' }).map(([v, l]) => h('option', { value: v, selected: theme === v }, l)));
        return h('div', { class: 'row' }, h('div', null, h('div', null, 'Тема оформлення'), h('div', { class: 'd' }, 'Змінює браузер і сайти, що підтримують світлу/темну тему')), sel);
      })(),
      (() => {
        const sel = h('select', { 'data-notr': '', onchange: () => save({ language: sel.value }) },
          h('option', { value: 'auto', selected: language === 'auto' }, t('Як у системі')),
          Object.entries(languages).map(([v, l]) => h('option', { value: v, selected: language === v }, l)));
        return h('div', { class: 'row' }, h('div', null, h('div', null, 'Мова'), h('div', { class: 'd' }, 'Мова інтерфейсу браузера та внутрішніх сторінок. Сайти не змінюються')), sel);
      })(),
      select('searchEngine', 'Пошукова система', engines, 'Використовується для запитів в адресному рядку'),
      text('homepage', 'Домашня сторінка', 'Кнопка «⌂» та нові вікна', 'w3ir://newtab'),
      select('startup', 'При запуску', { newtab: 'Відкрити нову вкладку', restore: 'Відновити попередню сесію' }),
      toggle('showBookmarksBar', 'Панель закладок', 'Показувати закладки під адресним рядком'),
      toggle('verticalTabs', 'Вертикальні вкладки', 'Список вкладок збоку (також у меню та через Ctrl+K)'),
      (() => {
        const sel = h('select', { onchange: () => save({ sleepMinutes: Number(sel.value) }) },
          [5, 15, 30, 60, 120].map(m => h('option', { value: String(m), selected: (settings.sleepMinutes || 15) === m }, t('{0} хв', m))));
        return h('div', { class: 'row', title: 'Через скільки приспати вкладку' }, h('div', null, h('div', null, 'Приспляти вкладку через'),
          h('div', { class: 'd' }, 'Закріплені вкладки, вкладки зі звуком чи відео й вкладки з незбереженим введенням у формах не присипляються.')), sel);
      })(),
      toggle('sleepTabs', 'Приспляти неактивні вкладки', 'Неактивні вкладки звільняють оперативну пам’ять і оновлюються при поверненні')),
    h('h2', { id: 'sec-privacy' }, 'Приватність'),
    h('div', { class: 'list' },
      (() => {
        const modes = { standard: 'Стандартний', strict: 'Суворий', maximum: 'Максимальний' };
        const sel = h('select', { onchange: async () => { await save({ protection: sel.value }); location.reload(); } },
          Object.entries(modes).map(([v, l]) => h('option', { value: v, selected: (settings.protection || 'standard') === v }, l)));
        return h('div', { class: 'row', title: 'Режим захисту' }, h('div', null, h('div', null, 'Режим захисту'),
          h('div', { class: 'd' }, 'Стандартний — звичайна робота. Суворий — додатково блокує сторонні cookie й приховує локальні адреси в WebRTC. Максимальний — ще й WebRTC лише через проксі та без Referer для сторонніх сайтів. Деякі сайти (входи через сторонні сервіси, оплата) можуть працювати гірше: для такого сайту вимкніть блокувальник у панелі інформації про сайт.')), sel);
      })(),
      toggle('adblock', 'Блокувати рекламу та трекери', adblockEngine ? 'Активні фільтри EasyList / EasyPrivacy / uBlock + приховування рекламних блоків' : 'Завантаження фільтрів… тимчасово діє базовий список доменів'),
      toggle('httpsFirst', 'Спершу HTTPS', 'Автоматично відкривати http-сайти через https, якщо це можливо'),
      toggle('stripTracking', 'Прибирати трекінгові параметри з адрес', 'utm_*, fbclid, gclid та подібні'),
      toggle('safeBrowsing', 'Захист від шахрайських сайтів', 'Блокує відомі фішингові та шкідливі сайти й попереджає про підробні адреси (двійники банків, бірж, гаманців). Перевірка локальна'),
      toggle('sendGpc', 'Надсилати «Не відстежувати» (DNT / GPC)', 'Сайти отримують сигнал, що ви не хочете персоналізації')),
    safeBox,
    h('h2', { id: 'sec-sites' }, 'Дозволи та винятки сайтів'),
    sitesBox,
    h('h2', { id: 'sec-downloads' }, 'Завантаження'),
    h('div', { class: 'list' },
      text('downloadDir', 'Папка завантажень', 'Порожньо — стандартна папка «Завантаження»', 'Стандартна'),
      toggle('askDownload', 'Питати, куди зберегти кожен файл'),
      toggle('torrentConfirm', 'Питати перед відкриттям торентів', 'magnet-посилання та .torrent-файли відкриваються у вашому зовнішньому торент-клієнті')),
    h('div', { class: 'list', style: 'margin-bottom:10px' }, h('div', { class: 'row' }, h('div', null, h('div', null, 'Імпорт із Chrome, Edge, Firefox'), h('div', { class: 'd' }, 'Закладки, історія та паролі')), h('a', { href: 'w3ir://import' }, 'Відкрити'))),
    h('h2', { id: 'sec-passwords' }, 'Паролі'),
    h('div', { class: 'list' },
      toggle('savePasswords', 'Пропонувати зберігати паролі', 'Після входу на сайті браузер запитає, чи зберегти пароль'),
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Менеджер паролів'), h('div', { class: 'd' }, 'Шифроване сховище: AES-256-GCM + scrypt + захист акаунтом Windows')),
        h('a', { href: 'w3ir://passwords' }, 'Відкрити'))),
    h('h2', { id: 'sec-wallet' }, 'Гаманець'),
    h('div', { class: 'list' }, h('div', { class: 'row' }, h('div', null, h('div', null, 'Приховати гаманець'),
      h('div', { class: 'd' }, settings.walletHidden ? 'Гаманець приховано. Щоб показати його, відкрийте w3ir://wallet і введіть майстер-пароль.' : 'Прибирає гаманець з меню, стартової сторінки й панелі та вимикає його для сайтів. Дані лишаються у зашифрованому сховищі. Показати знову можна на сторінці гаманця з майстер-паролем. Видалення гаманця — там само, у розділі «Безпека».')),
      settings.walletHidden ? h('span', { class: 'note' }, 'Приховано') : h('button', { onclick: async () => { await w3ir.invoke('wallet:hide'); location.reload(); } }, 'Приховати'))),
    h('h2', { id: 'sec-sync' }, 'Синхронізація закладок (наскрізне шифрування)'),
    syncBox,
    h('h2', { id: 'sec-updates' }, 'Оновлення браузера'),
    updBox,
    h('h2', { id: 'sec-github' }, 'GitHub'),
    ghBox,
    h('h2', { id: 'sec-ai' }, 'Керування браузером ШІ (MCP)'),
    agBox,
    h('h2', { id: 'sec-keywords' }, 'Ключові слова адресного рядка'),
    h('div', { class: 'list' }, h('div', { class: 'row' }, h('div', { style: 'flex:1' },
      h('div', null, 'Вбудовані: gh owner/repo, ghi, ghp, gha, ghc, npm, mdn, yt, wiki, crates, pypi'),
      h('div', { class: 'd' }, 'Власні: по одному в рядку, формат «слово = https://сайт/?q=%s»'), kw))),
    h('h2', { id: 'sec-defaultbrowser' }, 'Браузер за замовчуванням'),
    h('div', { class: 'list' }, h('div', { class: 'row' },
      h('div', null, h('div', null, 'Зробити W3IR Browser основним'), h('div', { class: 'd' }, 'Відкриє системні налаштування «Програми за замовчуванням» (працює для встановленої версії)')),
      h('button', { onclick: () => w3ir.invoke('defaultbrowser') }, 'Відкрити налаштування'))),
    h('h2', { id: 'sec-extensions' }, 'Розширення (експериментально)'),
    extBox,
    h('h2', { id: 'sec-features' }, 'Стан функцій'),
    h('p', { class: 'note' }, 'Стабільна функція перевірена тривалим використанням і тестами. Бета працює, але ще дозріває. Експериментальна може змінюватися або давати збої.'),
    h('div', { class: 'list' }, [
      ['stable', 'Вкладки, закладки та історія'],
      ['stable', 'Блокувальник реклами й трекерів'],
      ['stable', 'Менеджер паролів'],
      ['stable', 'Перегляд PDF'],
      ['stable', 'Автоматичні оновлення'],
      ['beta', 'Режими захисту', 'Нова функція: на окремих сайтах можливі проблеми.'],
      ['beta', 'Гаманець EVM', 'Незалежного аудиту ще немає: не тримайте великі суми.'],
      ['beta', 'Гаманець Solana', 'Незалежного аудиту ще немає: не тримайте великі суми.'],
      ['beta', 'Інструменти PDF', 'Злиття, розділення, підпис: перевіряйте результат.'],
      ['beta', 'Синхронізація закладок'],
      ['experimental', 'Локальний ШІ-помічник', 'Якість залежить від моделі.'],
      ['experimental', 'Керування браузером ШІ (MCP)', 'Вимкнено за замовчуванням.'],
      ['experimental', 'Розширення Chrome', 'Сумісність часткова.'],
    ].map(([level, name, note]) => h('div', { class: 'row' },
      h('div', null, h('div', null, name), note && h('div', { class: 'd' }, note)),
      h('span', { class: 'maturity ' + level }, { stable: 'Стабільна', beta: 'Бета', experimental: 'Експериментальна' }[level])))),
    h('h2', { id: 'sec-clear' }, 'Очистити дані перегляду'),
    h('div', { class: 'list' }, h('div', { class: 'row' },
      h('div', null,
        h('label', null, hist, ' Історія'), ' ',
        h('label', null, cookies, ' Cookie та дані сайтів'), ' ',
        h('label', null, cache, ' Кеш')),
      h('div', null, clear, status))),
    h('p', { class: 'note' }, `W3IR Browser ${version} · на основі Chromium/Electron`));
}
function buildRail() {
  const heads = [...document.querySelectorAll('main > h2')];
  if (heads.length < 4) return;
  const links = heads.map((hd, i) => {
    if (!hd.id) hd.id = 'sec' + i;
    return h('a', { href: '#' + hd.id, onclick: (e) => { e.preventDefault(); hd.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, hd.textContent);
  });
  document.body.append(h('nav', { class: 'rail', 'aria-label': 'Розділи налаштувань' }, links));
  const mark = () => {
    let cur = 0;
    heads.forEach((hd, i) => { if (hd.getBoundingClientRect().top < 140) cur = i; });
    links.forEach((a, i) => a.classList.toggle('on', i === cur));
    if (window.syncActiveTab && heads[cur] && heads[cur].id) window.syncActiveTab(heads[cur].id);
  };
  window.addEventListener('scroll', mark, { passive: true });
  mark();
}
main().then(() => setTimeout(buildRail, 50));
