'use strict';
// Екрани до появи гаманця: приховано, розблокування, створення/імпорт, фраза відновлення, перевірка запису фрази.

function gate(text, linkText, href) {
  app.append(h('div', { class: 'card' }, h('p', null, text), h('a', { href }, linkText)));
}

// Гаманець приховано: бачимо лише картку з кнопкою «Показати» (потрібен майстер-пароль; заблоковане сховище розблоковується тим самим паролем)
function renderHidden(st) {
  const m = h('input', { type: 'password', placeholder: 'Майстер-пароль', autocomplete: 'off' });
  const err = h('div', { class: 'merr' });
  const hasVault = st.vault !== 'none';
  const go = async () => {
    if (st.vault === 'locked') {
      const u = await call('vault:unlock', { master: m.value });
      if (!u.ok) { err.textContent = u.error; return; }
    }
    const r = await call('wallet:unhide', { master: m.value });
    m.value = '';
    if (r && r.ok) location.reload(); else err.textContent = (r && r.error) || t('Не вдалося показати гаманець.');
  };
  m.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  app.append(h('div', { class: 'card' }, h('h2', null, 'Гаманець приховано'),
    h('p', { class: 'note' }, hasVault ? 'Гаманця немає в меню, на стартовій сторінці й панелі, а сайти його не бачать. Дані лишаються в зашифрованому сховищі. Щоб показати гаманець, введіть майстер-пароль.' : 'Гаманець приховано. Натисніть «Показати гаманець», щоб повернути його.'),
    ...(hasVault ? [m] : []), err, h('button', { class: 'primary', onclick: go }, 'Показати гаманець')));
  if (hasVault) m.focus();
}

function renderUnlock() {
  const m = h('input', { type: 'password', placeholder: 'Майстер-пароль', autocomplete: 'off' });
  const err = h('div', { class: 'merr' });
  const go = async () => {
    const r = await call('vault:unlock', { master: m.value });
    m.value = '';
    if (!r.ok) { err.textContent = r.error; return; }
    render();
  };
  m.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  app.append(h('div', { class: 'card' }, h('h2', null, 'Розблокуйте сховище'), h('p', { class: 'note' }, 'Гаманець зберігається у сховищі паролів і використовує той самий майстер-пароль.'), m, err, h('button', { class: 'primary', onclick: go }, 'Розблокувати')));
  m.focus();
}

function renderSetup() {
  const passInp = h('input', { type: 'password', placeholder: 'Фраза-пароль BIP39 (необов\u2019язково)', autocomplete: 'off', spellcheck: false });
  const evmPathSel = h('select', null, [['standard', "MetaMask, Trezor: m/44'/60'/0'/0/i"], ['ledgerLive', "Ledger Live: m/44'/60'/i'/0/0"], ['legacy', "Старі MEW, Ledger: m/44'/60'/0'/i"]].map(([v, l]) => h('option', { value: v }, l)));
  const solPathSel = h('select', null, [['phantom', "Phantom, Solflare: m/44'/501'/i'/0'"], ['bip44', "Ledger Live, старі: m/44'/501'/i'"]].map(([v, l]) => h('option', { value: v }, l)));
  const previewBox = h('div');
  const importOpts = () => ({ phrase: phrase.value, passphrase: passInp.value, evmPath: evmPathSel.value, solPath: solPathSel.value });
  const phrase = h('textarea', { rows: 3, placeholder: 'слово1 слово2 … (12 або 24 слова)', spellcheck: false });
  const err = h('div', { class: 'merr' });
  app.append(
    h('div', { class: 'card', style: 'max-width:none' },
      h('h2', null, 'Створіть гаманець'),
      h('p', null, 'Гаманець дозволяє підключатися до децентралізованих застосунків (dApp), підписувати повідомлення, надсилати транзакції та керувати NFT на мережах, сумісних з Ethereum (EVM).'),
      h('p', { class: 'note' }, 'Фраза відновлення (12 слів) — єдиний спосіб повернути кошти. Її бачите лише ви; ми її не зберігаємо в хмарі й не можемо відновити.'),
      h('button', { class: 'primary', onclick: async () => {
        const r = await call('wallet:create');
        if (!r.ok) { err.textContent = r.error; return; }
        showPhrase(r.phrase);
      } }, 'Створити новий гаманець')),
    h('div', { class: 'card', style: 'max-width:none' },
      h('h2', null, 'Відновити з файлу резервної копії'),
      h('p', { class: 'note' }, 'Файл .w3irbackup, збережений раніше з цього гаманця (зашифрований окремим паролем резервної копії).'),
      (() => {
        const pw = h('input', { type: 'password', placeholder: 'Пароль резервної копії', autocomplete: 'off' });
        const msg = h('div', { class: 'merr' });
        return h('div', null, pw, msg, h('button', { onclick: async () => {
          msg.textContent = '\u2026';
          const r = await call('wallet:backupImport', { password: pw.value });
          pw.value = '';
          if (!r.ok) { msg.textContent = r.error; return; }
          alert(t('Відновлено: рахунків {0}, контактів {1}, імпортованих ключів {2}.', r.accounts, r.contacts, r.imported));
          render();
        } }, 'Вибрати файл і відновити'));
      })(),
      h('h2', null, 'Або імпортуйте наявний'),
      phrase,
      h('details', { style: 'margin:8px 0' }, h('summary', null, 'Додатково: фраза-пароль і шлях деривації (для сумісності з іншими гаманцями)'),
        h('p', { class: 'note' }, 'Потрібно, лише якщо гаманець у вас був створений із фразою-паролем (25-те слово BIP39) чи з нестандартним шляхом, наприклад Ledger Live. Звірте адреси в попередньому перегляді з тими, що показує ваш інший гаманець. Фразу-пароль не можна відновити: без неї кошти недоступні.'),
        passInp, h('label', { class: 'mfield' }, h('span', null, 'Шлях EVM'), evmPathSel), h('label', { class: 'mfield' }, h('span', null, 'Шлях Solana'), solPathSel)),
      h('div', { class: 'bar' }, h('button', { onclick: async () => {
        previewBox.textContent = '\u2026'; err.textContent = '';
        const r = await call('wallet:previewImport', importOpts());
        if (!r.ok) { previewBox.textContent = ''; err.textContent = r.error; return; }
        previewBox.textContent = '';
        previewBox.append(h('div', { class: 'note' }, 'EVM: ' + r.evm.join(', ')), h('div', { class: 'note' }, 'Solana: ' + r.sol.join(', ')));
      } }, 'Показати перші адреси')),
      previewBox, err,
      h('button', { onclick: async () => {
        const r = await call('wallet:import', importOpts());
        phrase.value = ''; passInp.value = '';
        if (!r.ok) { err.textContent = r.error; return; }
        render();
      } }, 'Імпортувати фразу')));
}

// Три слова з аркуша: перевіряє браузер (фраза зі сховища не виходить). Повертає true, якщо підтверджено
async function backupQuizFlow() {
  const q = await withAuth((x) => call('wallet:backupQuiz', x));
  if (!q) return false;
  if (!q.ok) { alert(q.error); return false; }
  for (;;) {
    const a = await ask('Перевірте, що фразу записано', q.positions.map((n, i) => ({ name: 'w' + i, label: t('Слово №{0}', n) })), { okText: 'Перевірити', note: 'Введіть слова зі свого аркуша з фразою. Це підтверджує, що ви зможете відновити гаманець.' });
    if (!a) return false;
    const r = await call('wallet:backupCheck', { answers: q.positions.map((_, i) => a['w' + i]) });
    if (!r.ok) { alert(r.error); return false; }
    if (r.correct) return true;
    alert(t('Слова не збігаються з фразою. Перевірте аркуш і спробуйте ще раз.'));
  }
}

function showPhrase(phrase) {
  app.textContent = '';
  const words = phrase.split(' ');
  app.append(h('h1', null, 'Збережіть фразу відновлення'),
    h('div', { class: 'warnbox' }, 'Запишіть ці слова на папері в правильному порядку й зберігайте в безпечному місці. Хто знає фразу — контролює ваші кошти. Ніколи не вводьте її на сайтах і нікому не показуйте. Ми не зможемо її відновити.'),
    h('div', { class: 'phrase' }, words.map((w, i) => h('div', { class: 'word' }, h('span', null, String(i + 1)), w))),
    h('button', { class: 'primary', onclick: async () => { const ok = await backupQuizFlow(); if (ok) alert(t('Готово: резервну копію підтверджено.')); render(); } }, 'Я записав(ла) фразу'),
    h('button', { style: 'margin-left:8px', title: 'Фраза лишиться непідтвердженою: на сторінці гаманця з\u2019явиться нагадування', onclick: () => render() }, 'Пропустити перевірку'));
}
