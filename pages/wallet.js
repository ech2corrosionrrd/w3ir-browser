'use strict';
const call = (name, arg) => w3ir.invoke(name, arg);
const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);

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

async function render() {
  const st = await call('wallet:status');
  app.textContent = '';
  app.append(h('h1', null, 'Гаманець (Web3)'));
  if (st.vault === 'none') return gate('Гаманець зберігається у зашифрованому сховищі паролів.', 'Створити сховище паролів', 'w3ir://passwords');
  if (st.vault === 'locked') return renderUnlock();
  if (!st.exists) return renderSetup();
  return renderDashboard(st);
}

function gate(text, linkText, href) {
  app.append(h('div', { class: 'card' }, h('p', null, text), h('a', { href }, linkText)));
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
      h('h2', null, 'Або імпортуйте наявний'),
      phrase, err,
      h('button', { onclick: async () => {
        const r = await call('wallet:import', { phrase: phrase.value });
        phrase.value = '';
        if (!r.ok) { err.textContent = r.error; return; }
        render();
      } }, 'Імпортувати фразу')));
}

function showPhrase(phrase) {
  app.textContent = '';
  const words = phrase.split(' ');
  app.append(h('h1', null, 'Збережіть фразу відновлення'),
    h('div', { class: 'warnbox' }, 'Запишіть ці слова на папері в правильному порядку й зберігайте в безпечному місці. Хто знає фразу — контролює ваші кошти. Ніколи не вводьте її на сайтах і нікому не показуйте. Ми не зможемо її відновити.'),
    h('div', { class: 'phrase' }, words.map((w, i) => h('div', { class: 'word' }, h('span', null, String(i + 1)), w))),
    h('button', { class: 'primary', onclick: () => render() }, 'Я записав(ла) фразу'));
}

async function renderDashboard(st) {
  const info = st.info;
  const net = info.networks.find(n => n.chainId === info.activeChain) || info.networks[0];

  // мережа
  const sel = h('select', { onchange: async () => { await call('wallet:setChain', { id: Number(sel.value) }); render(); } },
    info.networks.map(n => h('option', { value: n.chainId, selected: n.chainId === info.activeChain }, n.name + (n.builtin ? '' : ' (власна)'))));
  const rpc = h('input', { type: 'text', value: net.rpc, spellcheck: false, style: 'width:100%' });
  const rpcMsg = h('span', { class: 'note' });
  rpc.addEventListener('change', async () => {
    const r = await call('wallet:setRpc', { id: net.chainId, url: rpc.value });
    rpcMsg.textContent = r.ok ? ' Збережено.' : ' ' + r.error;
  });

  // рахунки
  const balEls = {};
  const accounts = h('div', { class: 'list' }, info.accounts.map((a, i) => {
    const bal = h('span', { class: 'note' }, '…');
    balEls[a] = bal;
    return h('div', { class: 'item' },
      h('div', { class: 'main' },
        h('div', { class: 't' }, `Рахунок ${i + 1}`),
        h('div', { class: 's pw', style: 'user-select:text' }, a)),
      bal,
      h('button', { class: 'link', onclick: () => navigator.clipboard.writeText(a).catch(() => {}) }, 'Копіювати'),
      net.explorer ? h('a', { href: `${net.explorer}/address/${a}` }, 'Оглядач') : '');
  }));
  call('wallet:balances').then(r => {
    if (!r.ok) return;
    for (const b of r.balances) if (balEls[b.address]) balEls[b.address].textContent = b.balance === null ? 'баланс недоступний' : `${Number(b.balance).toFixed(5)} ${b.symbol}`;
  });

  const first = info.accounts[0];
  const connected = h('div', { class: 'list' });
  if (!info.connections.length) connected.append(h('div', { class: 'row' }, 'Жоден сайт не підключено.'));
  for (const c of info.connections) {
    connected.append(h('div', { class: 'item' }, h('div', { class: 'main' }, h('div', { class: 't' }, c.origin), h('div', { class: 's' }, `chainId ${c.chainId}`)),
      h('button', { class: 'link danger', onclick: async () => { await call('wallet:disconnect', { origin: c.origin }); render(); } }, 'Відключити')));
  }

  const log = h('div', { class: 'list' });
  if (!info.log.length) log.append(h('div', { class: 'row' }, 'Подій поки немає.'));
  for (const e of info.log.slice(0, 30)) {
    const n = info.networks.find(x => x.chainId === e.chainId);
    log.append(h('div', { class: 'item' }, h('span', { class: 'time' }, new Date(e.t).toLocaleString('uk-UA')),
      h('div', { class: 'main' }, h('div', { class: 't' }, e.action), h('div', { class: 's' }, e.origin + (e.hash ? ' · ' + short(e.hash) : ''))),
      e.hash && n && n.explorer ? h('a', { href: `${n.explorer}/tx/${e.hash}` }, 'Оглядач') : ''));
  }

  app.append(
    h('h2', null, 'Мережа'),
    h('div', { class: 'list' }, h('div', { class: 'row' }, h('div', null, h('div', null, 'Активна мережа'), h('div', { class: 'd' }, 'Нові підключення починаються з неї. Дозволені: https-адреси RPC.')), sel),
      h('div', { class: 'row' }, h('div', { style: 'flex:1' }, h('div', null, 'RPC-сервер'), h('div', { class: 'd' }, 'Через нього проходять запити про баланси та транзакції. Для приватності вкажіть власний вузол.'), rpc, rpcMsg))),
    h('h2', null, 'Рахунки'),
    accounts,
    h('div', { class: 'bar', style: 'margin-top:10px' }, info.accounts.length < 10 ? h('button', { onclick: async () => { const r = await call('wallet:addAccount'); if (!r.ok) alert(r.error); render(); } }, '+ Додати рахунок') : ''),
    h('h2', null, 'NFT'),
    h('div', { class: 'card', style: 'max-width:none;margin:0' },
      h('p', { style: 'margin-top:0' }, 'Підключайте гаманець на маркетплейсах («Connect wallet» → W3IR Wallet): перегляд, купівля й продаж NFT працюють у вкладці, а кожна дія підтверджується окремим вікном.'),
      h('p', { class: 'note' }, 'Вбудований перегляд колекції потребує сторонніх сервісів з API-ключами, тому не вмикається за замовчуванням (приватність). Швидкі посилання для першого рахунку:'),
      h('div', { class: 'tools' },
        h('a', { href: `https://opensea.io/${first}` }, 'OpenSea'),
        h('a', { href: `https://rarible.com/user/${first}` }, 'Rarible'),
        net.explorer ? h('a', { href: `${net.explorer}/address/${first}#nfttransfers` }, 'Перекази NFT в оглядачі') : '')),
    h('h2', null, 'Підключені сайти'),
    connected,
    h('h2', null, 'Журнал дій'),
    log,
    h('h2', null, 'Безпека'),
    h('div', { class: 'list' },
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Надавати провайдер сайтам (window.ethereum)'), h('div', { class: 'd' }, 'Вимкніть, якщо не користуєтеся dApp — сайти не зможуть навіть побачити гаманець')),
        (() => { const cb = h('input', { type: 'checkbox', class: 'switch', checked: st.inject, onchange: () => call('wallet:setInject', { on: cb.checked }) }); return cb; })()),
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Показати фразу відновлення'), h('div', { class: 'd' }, 'Потрібен майстер-пароль')),
        h('button', { onclick: async () => {
          const r = await withAuth((x) => call('wallet:reveal', x));
          if (r && r.ok) showPhraseOnly(r.phrase); else if (r && r.error) alert(r.error);
        } }, 'Показати')),
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Видалити гаманець'), h('div', { class: 'd' }, 'Видаляє ключі з цього пристрою. Без фрази відновлення кошти недоступні.')),
        h('button', { class: 'danger', onclick: async () => {
          const r = await withAuth((x) => call('wallet:remove', x));
          if (r && r.ok) render(); else if (r && r.error) alert(r.error);
        } }, 'Видалити'))),
    h('p', { class: 'note' }, 'Підтримуються мережі EVM (Ethereum, Polygon, Base, Arbitrum, Optimism, BNB, Avalanche та власні). Solana, Bitcoin та апаратні гаманці (Ledger/Trezor) не підтримуються. Це новий, незалежно не аудитований код — для великих сум використовуйте апаратний гаманець.'));
}

function showPhraseOnly(phrase) {
  const words = phrase.split(' ');
  const box = h('div', { class: 'modal', onmousedown: (e) => { if (e.target === box) box.remove(); } },
    h('div', { class: 'mbox' }, h('h2', { class: 'mtitle' }, 'Фраза відновлення'),
      h('div', { class: 'phrase' }, words.map((w, i) => h('div', { class: 'word' }, h('span', null, String(i + 1)), w))),
      h('div', { class: 'mbtns' }, h('button', { class: 'primary', onclick: () => box.remove() }, 'Закрити'))));
  document.body.append(box);
  setTimeout(() => box.remove(), 60000);
}

render();
setInterval(async () => { const st = await call('wallet:status'); if (st.vault !== 'unlocked' && document.querySelector('.list')) render(); }, 5000);
