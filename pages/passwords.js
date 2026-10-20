'use strict';
const call = (name, arg) => w3ir.invoke(name, arg);

// Виконує операцію, яка може вимагати повторного введення майстер-пароля
async function withAuth(fn) {
  let r = await fn({});
  if (r && r.needAuth) {
    const a = await ask('Підтвердіть особу', [{ name: 'master', label: 'Майстер-пароль', type: 'password' }], { okText: 'Підтвердити', note: 'Для цієї дії потрібне повторне введення майстер-пароля.' });
    if (!a) return null;
    r = await fn({ master: a.master });
    if (r && r.needAuth) { alert(r.error || 'Хибний майстер-пароль.'); return null; }
  }
  return r;
}

const strengthInfo = 'Мінімум 12 символів: великі й малі літери, цифри чи символи (або понад 20 символів). Майстер-пароль неможливо відновити — якщо ви його забудете, дані буде втрачено.';

// ---------- екрани ----------
async function render() {
  app.textContent = '';
  const st = await call('vault:status');
  app.append(h('h1', null, 'Менеджер паролів'));
  if (st.status === 'none') return renderCreate(st);
  if (st.status === 'locked') return renderUnlock();
  return renderList(st);
}

function renderCreate(st) {
  const m1 = h('input', { type: 'password', placeholder: 'Майстер-пароль', autocomplete: 'off' });
  const m2 = h('input', { type: 'password', placeholder: 'Повторіть майстер-пароль', autocomplete: 'off' });
  const err = h('div', { class: 'merr' });
  const go = async () => {
    if (m1.value !== m2.value) { err.textContent = 'Паролі не збігаються.'; return; }
    const r = await call('vault:create', { master: m1.value });
    m1.value = m2.value = '';
    if (!r.ok) { err.textContent = r.error; return; }
    render();
  };
  m2.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  app.append(
    h('div', { class: 'card' },
      h('h2', null, 'Створіть захищене сховище'),
      h('p', null, `Паролі шифруються алгоритмом AES-256-GCM. Ключ виводиться з вашого майстер-пароля (scrypt)${st.pepper ? ' та прив’язується до облікового запису Windows.' : '.'} Сховище зберігається лише на цьому комп’ютері.`),
      h('p', { class: 'note' }, strengthInfo),
      m1, m2, err,
      h('button', { class: 'primary', onclick: go }, 'Створити сховище')));
  m1.focus();
}

function renderUnlock() {
  const m = h('input', { type: 'password', placeholder: 'Майстер-пароль', autocomplete: 'off' });
  const err = h('div', { class: 'merr' });
  const go = async () => {
    const r = await call('vault:unlock', { master: m.value });
    m.value = '';
    if (!r.ok) { err.textContent = r.error; m.focus(); return; }
    render();
  };
  m.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  app.append(h('div', { class: 'card' }, h('h2', null, 'Сховище заблоковано'), m, err, h('button', { class: 'primary', onclick: go }, 'Розблокувати')));
  m.focus();
}

async function renderList(st) {
  const search = h('input', { type: 'search', class: 'wfilter-input', placeholder: 'Пошук за сайтом або іменем', spellcheck: false });
  const auditBar = h('div', { class: 'pw-audit', style: 'display:none' });
  const listEl = h('div');
  const autolock = h('select', { onchange: () => call('vault:setAutolock', { minutes: Number(autolock.value) }) },
    [5, 15, 30, 60, 120].map(n => h('option', { value: n, selected: n === st.autolock }, `${n} хв`)));

  const addEntry = async (entry) => {
    let currentTotp = '';
    if (entry) {
      const r = await withAuth((x) => call('vault:reveal', { id: entry.id, ...x }));
      if (r && r.ok && r.totp) currentTotp = r.totp;
    }
    const f = [
      { name: 'url', label: 'Адреса сайту (https://…)', value: entry ? entry.origin : 'https://' },
      { name: 'username', label: 'Ім’я користувача', value: entry ? entry.username : '' },
      { name: 'password', label: entry ? 'Новий пароль (залиште порожнім, щоб не змінювати)' : 'Пароль', type: 'password', value: '',
        extra: h('button', { class: 'link', type: 'button', onclick: async (e) => {
          const r = await call('vault:generate', { length: 20 });
          const input = e.target.parentElement.querySelector('input');
          input.type = 'text'; input.value = r.password;
        } }, 'Згенерувати') },
      { name: 'totp', label: 'Ключ 2FA (секрет або otpauth://)', value: currentTotp },
      { name: 'note', label: 'Нотатка', type: 'textarea', value: '' },
    ];
    const v = await ask(entry ? 'Редагувати запис' : 'Новий запис', f, { okText: 'Зберегти' });
    if (!v) return;
    const r = await call('vault:save', { id: entry && entry.id, ...v });
    if (!r.ok) alert(r.error);
    load();
  };

  const toolbar = h('div', { class: 'bar wrap', style: 'margin-bottom:10px' },
    search,
    h('button', { class: 'primary', onclick: () => addEntry(null) }, '+ Додати'),
    h('button', { onclick: async () => {
      const r = await call('vault:generate', { length: 20 });
      await ask('Згенерований пароль', [{ name: 'p', label: 'Скопіюйте його вручну', value: r.password }], { okText: 'Закрити' });
    } }, 'Генератор'),
    h('button', { onclick: async () => {
      const r = await call('vault:importCsv');
      if (r.ok) alert(`Імпортовано: ${r.added}, пропущено: ${r.skipped}. Після імпорту видаліть CSV-файл — він містить паролі у відкритому вигляді!`);
      else if (r.error) alert(r.error);
      load();
    } }, 'Імпорт CSV'));

  const tools = h('div', { class: 'tools' },
    h('button', { onclick: async () => {
      const a = await ask('Резервна копія', [{ name: 'backupPassword', label: 'Пароль резервної копії (не менше 12 символів)', type: 'password' }], { okText: 'Зберегти файл…', note: 'Файл шифрується окремим паролем і не залежить від облікового запису Windows.' });
      if (!a) return;
      const r = await withAuth((x) => call('vault:export', { ...x, backupPassword: a.backupPassword }));
      if (r && r.ok) alert('Резервну копію збережено.'); else if (r && r.error) alert(r.error);
    } }, 'Створити резервну копію'),
    h('button', { onclick: async () => {
      const a = await ask('Відновлення з копії', [{ name: 'backupPassword', label: 'Пароль резервної копії', type: 'password' }], { okText: 'Вибрати файл…' });
      if (!a) return;
      const r = await call('vault:import', a);
      if (r.ok) alert(`Додано або оновлено записів: ${r.added}`); else if (r.error) alert(r.error);
      load();
    } }, 'Відновити з копії'),
    h('button', { onclick: async () => {
      const a = await ask('Змінити майстер-пароль', [
        { name: 'oldPw', label: 'Поточний майстер-пароль', type: 'password' },
        { name: 'newPw', label: 'Новий майстер-пароль', type: 'password' },
        { name: 'newPw2', label: 'Повторіть новий', type: 'password' }], { okText: 'Змінити', note: strengthInfo });
      if (!a) return;
      if (a.newPw !== a.newPw2) { alert('Нові паролі не збігаються.'); return; }
      const r = await call('vault:changeMaster', a);
      alert(r.ok ? 'Майстер-пароль змінено.' : r.error);
    } }, 'Змінити майстер-пароль'),
    h('span', { style: 'flex:1' }),
    h('label', { class: 'note' }, 'Автоблокування через ', autolock),
    h('button', { class: 'danger', onclick: async () => { await call('vault:lock'); render(); } }, 'Заблокувати'));

  app.append(toolbar, auditBar, listEl, h('h2', null, 'Керування'), tools,
    h('p', { class: 'note' }, 'Пароль копіюється в буфер на 20 секунд. Автозаповнення працює лише за вашою командою (кнопка 🔑) і лише на сайті з точно такою самою адресою.'));

  let entries = [];
  const reveal = async (e, line) => {
    const r = await withAuth((x) => call('vault:reveal', { id: e.id, ...x }));
    if (!r || !r.ok) return;
    line.textContent = r.password;
    line.classList.add('shown');
    setTimeout(() => { line.textContent = '••••••••••'; line.classList.remove('shown'); }, 15000);
  };

  const updateAudit = () => {
    if (!entries.length) { auditBar.style.display = 'none'; return; }
    auditBar.style.display = 'flex';
    auditBar.textContent = '';
    const userCounts = {};
    for (const e of entries) {
      if (e.username) userCounts[e.username] = (userCounts[e.username] || 0) + 1;
    }
    const dupUsers = Object.values(userCounts).filter(c => c > 1).length;
    auditBar.append(
      h('span', { class: 'pw-audit-badge' }, '🔑 ' + t('Збережених записів: {0}', entries.length)),
      dupUsers
        ? h('span', { class: 'pw-audit-badge warn', title: 'Одне й те саме ім’я користувача вживається на кількох сайтах' }, '⚠ ' + t('Збігів логінів: {0}', dupUsers))
        : h('span', { class: 'pw-audit-badge' }, '🛡️ ' + t('Унікальні облікові записи'))
    );
  };

  const draw = () => {
    const q = search.value.toLowerCase().trim();
    const items = entries.filter(e => !q || e.host.toLowerCase().includes(q) || (e.username && e.username.toLowerCase().includes(q)));
    listEl.textContent = '';
    if (!items.length) { listEl.append(h('div', { class: 'empty' }, entries.length ? 'Нічого не знайдено' : 'Збережених паролів поки немає. Увійдіть на сайт — браузер запропонує зберегти пароль.')); return; }
    listEl.append(h('div', { class: 'list' }, items.map(e => {
      const pw = h('span', { class: 'pw' }, '••••••••••');
      const cleanHost = (e.host || '').replace(/^https?:\/\//, '').replace(/^www\./, '');
      const initial = (cleanHost[0] || '🔑').toUpperCase();
      const avatar = h('div', { class: 'pw-avatar', title: e.host }, initial);
      const totpBtn = e.hasTotp ? h('button', { class: 'pw-totp', title: 'Натисніть для копіювання коду', onclick: async (ev) => {
        const btn = ev.currentTarget;
        const r = await call('vault:totp', { id: e.id });
        if (r && r.ok) {
          const formatted = r.code.length === 6 ? `${r.code.slice(0, 3)} ${r.code.slice(3)}` : r.code;
          btn.textContent = `${formatted} (${r.remaining}s)`;
          btn.onclick = async () => {
            await call('vault:copyTotp', { id: e.id });
            btn.textContent = 'скопійовано (20 с)';
            setTimeout(() => { load(); }, 2000);
          };
        } else if (r && r.error) {
          alert(r.error);
        }
      } }, '🔑 2FA код') : null;

      return h('div', { class: 'item' },
        avatar,
        h('div', { class: 'main' },
          h('div', { class: 't' }, e.host),
          h('div', { class: 's' }, e.username || '(без імені користувача)', ' · ', pw)),
        totpBtn,
        h('button', { class: 'link', onclick: () => reveal(e, pw) }, 'Показати'),
        h('button', { class: 'link', onclick: async () => {
          const r = await withAuth((x) => call('vault:copy', { id: e.id, ...x }));
          if (r && r.ok) { pw.textContent = 'скопійовано (20 с)'; setTimeout(() => { pw.textContent = '••••••••••'; }, 2500); }
        } }, 'Копіювати'),
        h('button', { class: 'link', onclick: () => addEntry(e) }, 'Змінити'),
        h('button', { class: 'link', onclick: async () => {
          if (confirm(`Видалити пароль для ${e.host}?`)) { await call('vault:remove', { id: e.id }); load(); }
        } }, '✕'));
    })));
  };
  async function load() {
    const r = await call('vault:list');
    if (!r.ok) { render(); return; }
    entries = r.entries;
    updateAudit();
    draw();
  }
  search.addEventListener('input', draw);
  load();
}

render();
// Якщо сховище заблокувалося автоматично — повертаємо екран розблокування
setInterval(async () => { const st = await call('vault:status'); if (st.status !== 'unlocked' && document.querySelector('.tools')) render(); }, 5000);
