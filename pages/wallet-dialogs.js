'use strict';
// Модальні вікна гаманця: перегляд адреси, Ledger, імпорт ключа, показ секретів, скасування дозволу, резервна копія.

// ----- імпорт рахунку за приватним ключем -----
async function watchDialog() {
  const a = await ask('Додати адресу для перегляду', [{ name: 'address', label: 'Адреса (EVM або Solana)' }, { name: 'name', label: 'Назва (необов\u2019язково, до 32 символів)' }], { okText: 'Додати', note: 'Рахунок лише для перегляду: гаманець показує баланси, токени, NFT та історію цієї адреси, але не має її ключа й не може нічого підписати чи надіслати.' });
  if (!a) return;
  const r = await call('wallet:addWatch', { address: a.address, name: a.name });
  if (r.ok) render(); else alert(r.error);
}
// ----- Ledger (експериментально) -----
function ledgerDialog() {
  const kind = h('select', null, h('option', { value: 'ledgerLive' }, "Ledger Live: m/44'/60'/N'/0/0"), h('option', { value: 'standard' }, "Стандартний: m/44'/60'/0'/0/N"));
  const idx = h('select', null, Array.from({ length: 10 }, (_, i) => h('option', { value: String(i) }, String(i + 1))));
  const name = h('input', { type: 'text', placeholder: 'Назва рахунку (необов\u2019язково)', spellcheck: false });
  const msg = h('div', { class: 'merr' });
  const go = h('button', { class: 'primary', onclick: async () => {
    msg.textContent = ''; go.disabled = true; go.textContent = t('Підтвердіть адресу на Ledger…');
    const r = await call('wallet:ledgerAdd', { kind: kind.value, index: Number(idx.value), name: name.value });
    go.disabled = false; go.textContent = t('Підключити');
    if (!r.ok) { msg.textContent = r.error; return; }
    box.remove(); render();
  } }, 'Підключити');
  const box = h('div', { class: 'modal', onmousedown: (e) => { if (e.target === box) box.remove(); } },
    h('div', { class: 'mbox' }, h('h2', { class: 'mtitle' }, 'Підключити Ledger'),
      h('div', { class: 'warnbox' }, 'Експериментальна функція: перевірена лише на імітованому пристрої. Спершу спробуйте з невеликою сумою. Підключіть Ledger, розблокуйте його й відкрийте застосунок «Ethereum». Адреса з’явиться на екрані пристрою: звірте її з тією, що покаже браузер, і підтвердьте.'),
      h('label', { class: 'mfield' }, h('span', null, 'Шлях деривації'), kind), h('label', { class: 'mfield' }, h('span', null, 'Номер рахунку'), idx), h('label', { class: 'mfield' }, h('span', null, 'Назва'), name),
      msg, h('div', { class: 'mbtns' }, h('button', { onclick: () => box.remove() }, 'Скасувати'), go)));
  document.body.append(box);
}
function importDialog() {
  const key = h('textarea', { rows: 3, placeholder: 'Приватний ключ: EVM — 64 шістнадцяткові символи; Solana — base58 (формат Phantom) або JSON-масив із файлу keypair', spellcheck: false, autocomplete: 'off', style: 'width:100%;font-family:Consolas,monospace' });
  const name = h('input', { type: 'text', placeholder: 'Назва рахунку (необов\u2019язково)', spellcheck: false });
  const msg = h('div', { class: 'merr' });
  const go = h('button', { class: 'primary', onclick: async () => {
    msg.textContent = ''; go.disabled = true;
    const r = await call('wallet:importKey', { key: key.value, name: name.value });
    go.disabled = false;
    if (!r.ok) { msg.textContent = r.error; return; }
    key.value = ''; box.remove(); render();
  } }, 'Імпортувати');
  const box = h('div', { class: 'modal', onmousedown: (e) => { if (e.target === box) { key.value = ''; box.remove(); } } },
    h('div', { class: 'mbox' }, h('h2', { class: 'mtitle' }, 'Імпорт за приватним ключем'),
      h('div', { class: 'warnbox' }, 'Приватний ключ дає повний контроль над рахунком. Вставляйте його лише тут і ніколи не показуйте сторонім. Імпортований рахунок не відновлюється з фрази відновлення гаманця: зробіть окрему резервну копію ключа. Для великих сум краще апаратний гаманець.'),
      h('label', { class: 'mfield' }, h('span', null, 'Приватний ключ'), key), h('label', { class: 'mfield' }, h('span', null, 'Назва'), name),
      msg, h('div', { class: 'mbtns' }, h('button', { onclick: () => { key.value = ''; box.remove(); } }, 'Скасувати'), go)));
  document.body.append(box);
  key.focus();
}
function showSecret(secret) {
  const box = h('div', { class: 'modal', onmousedown: (e) => { if (e.target === box) box.remove(); } },
    h('div', { class: 'mbox' }, h('h2', { class: 'mtitle' }, 'Приватний ключ'),
      h('div', { class: 'warnbox' }, 'Не показуйте цей ключ нікому й не вставляйте його на сайтах: хто його знає, контролює рахунок. Вікно закриється автоматично через хвилину.'),
      h('div', { class: 'pw', style: 'user-select:text;word-break:break-all;margin:12px 0;font-size:12px' }, secret),
      h('div', { class: 'mbtns' }, h('button', { class: 'primary', onclick: () => box.remove() }, 'Закрити'))));
  document.body.append(box);
  setTimeout(() => box.remove(), 60000);
}

// ----- скасування дозволу токена -----
function revokeDialog(acctOptions) {
  const acct = h('select', null, acctOptions().filter(o => o.chain !== 'sol').map(o => h('option', { value: String(o.id) }, o.label)));
  const token = h('input', { type: 'text', class: 'pw', placeholder: 'Адреса контракту токена (ERC-20)', spellcheck: false, autocomplete: 'off' });
  const spender = h('input', { type: 'text', class: 'pw', placeholder: 'Кому видано дозвіл (адреса)', spellcheck: false, autocomplete: 'off' });
  const msg = h('div', { class: 'merr' }), done = h('div', { class: 'note' });
  const go = h('button', { class: 'primary', onclick: async () => {
    msg.textContent = ''; go.disabled = true;
    const r = await call('wallet:revoke', { index: Number(acct.value), token: token.value.trim(), spender: spender.value.trim() });
    go.disabled = false;
    if (!r.ok) { msg.textContent = r.error; return; }
    done.textContent = t('Надіслано. Підпис транзакції: {0}', short(r.hash));
    setTimeout(() => { box.remove(); render(); }, 1800);
  } }, 'Скасувати дозвіл');
  const box = h('div', { class: 'modal', onmousedown: (e) => { if (e.target === box) box.remove(); } },
    h('div', { class: 'mbox' }, h('h2', { class: 'mtitle' }, 'Скасування дозволу токена'),
      h('p', { class: 'note' }, 'Надсилає транзакцію approve з нульовою сумою для вибраного токена й адреси. У вікні підтвердження буде видно поточний дозвіл. Скасування коштує комісії за газ.'),
      h('label', { class: 'mfield' }, h('span', null, 'Рахунок'), acct), h('label', { class: 'mfield' }, h('span', null, 'Токен'), token), h('label', { class: 'mfield' }, h('span', null, 'Кому видано дозвіл'), spender),
      msg, done, h('div', { class: 'mbtns' }, h('button', { onclick: () => box.remove() }, 'Закрити'), go)));
  document.body.append(box);
  token.focus();
}

// ----- резервна копія файлом -----
async function backupExportDialog() {
  const a = await ask('Зберегти зашифровану копію', [{ name: 'password', label: 'Пароль резервної копії (від 12 символів)', type: 'password' }, { name: 'password2', label: 'Повторіть пароль', type: 'password' }], { okText: 'Вибрати файл і зберегти', note: 'Це НЕ майстер-пароль: його знадобиться ввести при відновленні. Без нього файл не прочитати, а хто знає і файл, і пароль — контролює кошти. Зберігайте їх окремо.' });
  if (!a) return;
  const r = await withAuth((x) => call('wallet:backupExport', { ...x, password: a.password, password2: a.password2 }));
  if (!r) return;
  alert(r.ok ? t('Копію збережено: {0}', r.path) : r.error);
}

function showPhraseOnly(phrase, passphrase) {
  const words = phrase.split(' ');
  const box = h('div', { class: 'modal', onmousedown: (e) => { if (e.target === box) box.remove(); } },
    h('div', { class: 'mbox' }, h('h2', { class: 'mtitle' }, 'Фраза відновлення'),
      h('div', { class: 'phrase' }, words.map((w, i) => h('div', { class: 'word' }, h('span', null, String(i + 1)), w))),
      passphrase ? h('div', { class: 'warnbox' }, t('Фраза-пароль (25-те слово): {0}', passphrase)) : '',
      h('div', { class: 'mbtns' }, h('button', { class: 'primary', onclick: () => box.remove() }, 'Закрити'))));
  document.body.append(box);
  setTimeout(() => box.remove(), 60000);
}
