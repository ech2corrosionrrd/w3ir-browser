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
  const sol = info.sol;
  const net = info.networks.find(n => n.chainId === info.activeChain) || info.networks[0];
  const nameOf = (i) => info.names[i] || `Рахунок ${i + 1}`;
  const solExplorer = (a, cluster) => `https://explorer.solana.com/address/${a}` + (cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`);
  const copy = (text, btn) => {
    navigator.clipboard.writeText(text).catch(() => {});
    const old = btn.textContent;
    btn.textContent = t('Скопійовано');
    setTimeout(() => { btn.textContent = old; }, 1200);
  };

  // ----- огляд: стан сховища і мережі -----
  const evmSel = h('select', { 'aria-label': 'EVM-мережа', onchange: async () => { await call('wallet:setChain', { id: Number(evmSel.value) }); render(); } },
    info.networks.map(n => h('option', { value: n.chainId, selected: n.chainId === info.activeChain }, n.name + (n.builtin ? '' : ' (власна)'))));
  const solSel = h('select', { 'aria-label': 'Мережа Solana', onchange: async () => { await call('wallet:solSetCluster', { id: solSel.value }); render(); } },
    sol.clusters.map(c => h('option', { value: c.id, selected: c.id === sol.cluster }, c.name)));
  const summary = h('div', { class: 'wsum' },
    h('div', { class: 'wlock' }, h('span', { class: 'dot ok' }), h('div', null, h('div', { class: 't' }, 'Сховище розблоковано'), h('div', { class: 'd' }, 'Підпис і переказ потребують окремого підтвердження'))),
    h('div', { class: 'wnets' },
      h('label', null, h('span', null, 'EVM'), evmSel),
      h('label', null, h('span', null, 'Solana'), solSel)),
    h('button', { onclick: async () => { await call('vault:lock'); render(); } }, 'Заблокувати'));

  // ----- рахунки (EVM + Solana разом) -----
  const evmBal = {}, solBal = {};
  const rename = async (i) => {
    const a = await ask('Назва рахунку', [{ name: 'name', label: 'Назва (до 32 символів)', value: info.names[i] || '' }], { okText: 'Зберегти' });
    if (!a) return;
    const r = await call('wallet:rename', { index: i, name: a.name });
    if (r.ok) render();
  };
  const accounts = h('div', { class: 'accts' }, info.accounts.map((a, i) => {
    const sa = sol.addresses[i];
    const eb = h('span', { class: 'bal' }, '…'), sb = h('span', { class: 'bal' }, '…');
    evmBal[a] = eb; solBal[sa] = sb;
    const copyBtnE = h('button', { class: 'link', onclick: () => copy(a, copyBtnE) }, 'Копіювати');
    const copyBtnS = h('button', { class: 'link', onclick: () => copy(sa, copyBtnS) }, 'Копіювати');
    return h('div', { class: 'acct' },
      h('div', { class: 'ahead' },
        h('span', { class: 'avatar' }, String(i + 1)),
        h('div', { class: 'aname' }, nameOf(i), h('button', { class: 'link', title: 'Перейменувати', onclick: () => rename(i) }, '✎')),
        h('div', { class: 'aact' },
          h('button', { class: 'primary', onclick: () => sendDialog(i) }, 'Надіслати'),
          h('button', { onclick: () => { tokAcct.value = String(i); loadTokens(i); document.getElementById('tokens-anchor').scrollIntoView({ behavior: 'smooth' }); } }, 'Токени та NFT'))),
      h('div', { class: 'chain' }, h('span', { class: 'tag' }, 'EVM'), h('code', null, a), eb, copyBtnE, net.explorer ? h('a', { href: `${net.explorer}/address/${a}` }, 'Оглядач') : ''),
      h('div', { class: 'chain' }, h('span', { class: 'tag sol' }, 'SOL'), h('code', null, sa), sb, copyBtnS, h('a', { href: solExplorer(sa, sol.cluster) }, 'Оглядач')));
  }));
  call('wallet:balances').then(r => {
    if (r.ok) for (const b of r.balances) if (evmBal[b.address]) evmBal[b.address].textContent = b.balance === null ? 'баланс недоступний' : `${Number(b.balance).toFixed(5)} ${b.symbol}`;
  });
  call('wallet:solBalances').then(r => {
    if (r.ok) for (const b of r.balances) if (solBal[b.address]) solBal[b.address].textContent = b.balance === null ? 'баланс недоступний' : `${Number(b.balance).toFixed(5)} ${b.symbol}`;
  });

  // ----- токени й NFT вибраного рахунку -----
  const tokAcct = h('select', { 'aria-label': 'Рахунок', onchange: () => loadTokens(Number(tokAcct.value)) },
    sol.addresses.map((a, i) => h('option', { value: String(i) }, nameOf(i))));
  const tokMsg = h('div', { class: 'note', style: 'margin:8px 0' });
  const tokList = h('div', { class: 'list' });
  const nftGrid = h('div', { class: 'nft-grid' });
  async function loadTokens(i) {
    tokMsg.textContent = '…'; tokList.textContent = ''; nftGrid.textContent = '';
    tokList.style.display = 'none';
    const r = await call('wallet:solTokens', { address: sol.addresses[i] });
    if (!r.ok) { tokMsg.textContent = r.error || 'Помилка'; return; }
    if (!r.tokens.length) { tokMsg.textContent = 'Токенів і NFT на цьому рахунку немає.'; return; }
    tokMsg.textContent = (r.total > r.shown ? t('Показано {0} із {1}.', r.shown, r.total) + ' ' : '') + 'Назви токенів задають їхні творці й можуть вводити в оману: звіряйте адресу mint.';
    for (const tk of r.tokens) {
      const title = tk.name || short(tk.mint);
      const link = h('a', { href: solExplorer(tk.mint, r.cluster) }, 'Оглядач');
      if (tk.nft) {
        nftGrid.append(h('div', { class: 'nft-card' },
          tk.image ? h('img', { class: 'nft-thumb', src: tk.image, alt: title, onerror: (e) => { e.target.style.display = 'none'; } }) : '',
          h('div', { class: 'nft-body' }, h('span', { class: 'nft-badge' }, 'NFT'), h('div', { class: 'nft-title' }, title), tk.symbol ? h('div', { class: 'nft-desc' }, tk.symbol) : '', h('div', { class: 'tools', style: 'margin-top:8px' }, link))));
      } else {
        tokList.style.display = '';
        tokList.append(h('div', { class: 'item' }, h('div', { class: 'main' }, h('div', { class: 't' }, title + (tk.symbol ? ` (${tk.symbol})` : '')), h('div', { class: 's pw', style: 'user-select:text' }, tk.mint)), h('span', { class: 'note' }, tk.amount), link));
      }
    }
  }

  // ----- підключені сайти (EVM і Solana разом) -----
  const connected = h('div', { class: 'list' });
  const sites = new Map();
  for (const c of info.connections) sites.set(c.origin, { evm: c.chainId, sol: false });
  for (const c of sol.connections) sites.set(c.origin, { ...(sites.get(c.origin) || {}), sol: true });
  if (!sites.size) connected.append(h('div', { class: 'row' }, 'Жоден сайт не підключено.'));
  for (const [origin, c] of sites) {
    connected.append(h('div', { class: 'item' },
      h('div', { class: 'main' }, h('div', { class: 't' }, origin), h('div', { class: 's' }, [c.evm ? `EVM (chainId ${c.evm})` : '', c.sol ? 'Solana' : ''].filter(Boolean).join(' · '))),
      h('button', { class: 'link danger', onclick: async () => { await call('wallet:disconnect', { origin }); render(); } }, 'Відключити')));
  }

  // ----- журнал -----
  const log = h('div', { class: 'list' });
  if (!info.log.length) log.append(h('div', { class: 'row' }, 'Подій поки немає.'));
  for (const e of info.log.slice(0, 30)) {
    const n = info.networks.find(x => x.chainId === e.chainId);
    const isSol = typeof e.chainId === 'string';
    const href = e.hash ? (isSol ? `https://explorer.solana.com/tx/${e.hash}` + (e.chainId === 'mainnet-beta' ? '' : `?cluster=${e.chainId}`) : (n && n.explorer ? `${n.explorer}/tx/${e.hash}` : '')) : '';
    log.append(h('div', { class: 'item' }, h('span', { class: 'time' }, new Date(e.t).toLocaleString(LOCALE)),
      h('div', { class: 'main' }, h('div', { class: 't' }, e.action), h('div', { class: 's' }, e.origin + (e.hash ? ' · ' + short(e.hash) : ''))),
      href ? h('a', { href }, 'Оглядач') : ''));
  }

  // ----- мережі та RPC -----
  const rpc = h('input', { type: 'text', value: net.rpc, spellcheck: false, style: 'width:100%' });
  const rpcMsg = h('span', { class: 'note' });
  rpc.addEventListener('change', async () => {
    const r = await call('wallet:setRpc', { id: net.chainId, url: rpc.value });
    rpcMsg.textContent = r.ok ? ' Збережено.' : ' ' + r.error;
  });
  const solRpc = h('input', { type: 'text', value: sol.rpc[sol.cluster] || '', placeholder: sol.defaultRpc[sol.cluster], spellcheck: false, style: 'width:100%' });
  const solRpcMsg = h('span', { class: 'note' });
  solRpc.addEventListener('change', async () => {
    const r = await call('wallet:solSetRpc', { cluster: sol.cluster, url: solRpc.value });
    solRpcMsg.textContent = r.ok ? ' Збережено.' : ' ' + r.error;
  });

  app.append(
    h('h2', null, 'Огляд'), summary,
    h('h2', null, 'Рахунки'),
    accounts,
    h('div', { class: 'bar', style: 'margin-top:10px' }, info.accounts.length < 10 ? h('button', { onclick: async () => { const r = await call('wallet:addAccount'); if (!r.ok) alert(r.error); render(); } }, '+ Додати рахунок') : ''),
    h('h2', { id: 'tokens-anchor' }, 'Токени та NFT'),
    h('div', { class: 'bar' }, tokAcct, h('button', { onclick: () => loadTokens(Number(tokAcct.value)) }, 'Оновити')),
    tokMsg, tokList, nftGrid,
    h('h2', null, 'Децентралізоване сховище & NFT (Arweave / Irys)'),
    buildArweaveSection(info.accounts[0], net),
    h('h2', null, 'Підключені сайти'),
    connected,
    h('h2', null, 'Журнал дій'),
    log,
    h('h2', null, 'Мережі та RPC'),
    h('div', { class: 'list' },
      h('div', { class: 'row' }, h('div', { style: 'flex:1' }, h('div', null, 'RPC-сервер EVM'), h('div', { class: 'd' }, 'Через нього проходять запити про баланси та транзакції. Для приватності вкажіть власний вузол (https).'), rpc, rpcMsg)),
      h('div', { class: 'row' }, h('div', { style: 'flex:1' }, h('div', null, 'RPC-сервер Solana'), h('div', { class: 'd' }, 'Для вибраної мережі Solana; порожнє поле — типові вузли. Адреси виводяться з тієї самої фрази відновлення (шлях m/44′/501′/N′/0′, як у Phantom).'), solRpc, solRpcMsg))),
    h('h2', null, 'Безпека'),
    h('div', { class: 'list' },
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Надавати провайдер сайтам (window.ethereum, window.solana)'), h('div', { class: 'd' }, 'Вимкніть, якщо не користуєтеся dApp — сайти не зможуть навіть побачити гаманець')),
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
    h('p', { class: 'note' }, 'Підтримуються мережі EVM (Ethereum, Polygon, Base, Arbitrum, Optimism, BNB, Avalanche та власні) і Solana. Bitcoin та апаратні гаманці (Ledger/Trezor) поки не підтримуються. Це новий, незалежно не аудитований код — для великих сум використовуйте апаратний гаманець.'));
  railNav('Розділи гаманця');
  if (sol.addresses.length) loadTokens(0);

  // ----- вікно «Надіслати» -----
  function sendDialog(index) {
    const acct = h('select', null, info.accounts.map((a, i) => h('option', { value: String(i), selected: i === index }, nameOf(i))));
    const chain = h('select', null,
      h('option', { value: 'evm' }, `${net.name} (${net.symbol})`),
      h('option', { value: 'sol' }, `Solana ${sol.clusters.find(c => c.id === sol.cluster).name} (SOL)`));
    const to = h('input', { type: 'text', class: 'pw', placeholder: 'Адреса отримувача', spellcheck: false, autocomplete: 'off' });
    const amount = h('input', { type: 'text', placeholder: '0.0', inputMode: 'decimal', autocomplete: 'off' });
    const msg = h('div', { class: 'merr' });
    const ok = h('div', { class: 'note' });
    const go = h('button', { class: 'primary', onclick: submit }, 'Надіслати');
    const close = () => box.remove();
    async function submit() {
      msg.textContent = ''; ok.textContent = '';
      go.disabled = true;
      const r = await call('wallet:send', { chain: chain.value, index: Number(acct.value), to: to.value.trim(), amount: amount.value.trim().replace(',', '.') });
      go.disabled = false;
      if (!r.ok) { msg.textContent = r.error; return; }
      ok.textContent = t('Надіслано. Підпис транзакції: {0}', short(r.hash));
      setTimeout(() => { close(); render(); }, 1800);
    }
    const box = h('div', { class: 'modal', onmousedown: (e) => { if (e.target === box) close(); } },
      h('div', { class: 'mbox' },
        h('h2', { class: 'mtitle' }, 'Надіслати'),
        h('p', { class: 'note' }, 'Перед відправленням відкриється окреме вікно підтвердження браузера з усіма даними: отримувач, сума, комісія (для Solana — ще й результат симуляції). Перевірте адресу символ за символом.'),
        h('label', { class: 'mfield' }, h('span', null, 'Звідки'), acct),
        h('label', { class: 'mfield' }, h('span', null, 'Мережа'), chain),
        h('label', { class: 'mfield' }, h('span', null, 'Отримувач'), to),
        h('label', { class: 'mfield' }, h('span', null, 'Сума'), amount),
        msg, ok,
        h('div', { class: 'mbtns' }, h('button', { onclick: close }, 'Скасувати'), go)));
    box.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    document.body.append(box);
    to.focus();
  }
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

function buildArweaveSection(first, net) {
  const input = h('input', { type: 'text', placeholder: 'Введіть txId або ar://...', spellcheck: false, style: 'flex:1' });
  const statusMsg = h('div', { class: 'note', style: 'margin-top:6px' });
  const cardContainer = h('div', { class: 'nft-grid' });

  const inspect = async () => {
    const val = input.value.trim();
    if (!val) return;
    statusMsg.textContent = 'Завантаження з Arweave шлюзів…';
    cardContainer.textContent = '';
    const res = await call('arweave:nft', { txId: val });
    if (!res.ok) {
      statusMsg.textContent = res.error || 'Помилка завантаження NFT.';
      return;
    }
    const meta = res.metadata;
    statusMsg.textContent = 'Знайдено в постійному сховищі Arweave.';

    const imgEl = h('img', {
      class: 'nft-thumb',
      src: meta.imageGateway || meta.image,
      alt: meta.name,
      onerror: () => { imgEl.style.display = 'none'; }
    });

    const traitsEls = (meta.attributes || []).map(a =>
      h('div', { class: 'nft-trait' }, `${a.trait_type}: `, h('strong', null, a.value))
    );

    const card = h('div', { class: 'nft-card' },
      meta.image ? imgEl : '',
      h('div', { class: 'nft-body' },
        h('span', { class: 'nft-badge' }, '⚡ Arweave Permanent'),
        h('div', { class: 'nft-title' }, meta.name),
        meta.description ? h('div', { class: 'nft-desc' }, meta.description) : '',
        traitsEls.length ? h('div', { class: 'nft-traits' }, traitsEls) : '',
        h('div', { class: 'tools', style: 'margin-top:8px' },
          h('a', { href: meta.arweaveUrl, target: '_blank' }, 'Відкрити ar://'),
          h('a', { href: `https://viewblock.io/arweave/tx/${meta.txId}`, target: '_blank' }, 'Оглядач блоків'))));

    cardContainer.append(card);
  };

  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') inspect(); });

  return h('div', { class: 'card', style: 'max-width:none;margin:0' },
    h('p', { style: 'margin-top:0' }, 'Всі NFT та постійні медіафайли у W3IR Browser завантажуються та верифікуються напряму через децентралізоване сховище Arweave (шлюзи Irys / Arweave) без посередників чи платних API.'),
    h('div', { class: 'bar', style: 'margin:12px 0 6px' },
      input,
      h('button', { class: 'primary', onclick: inspect }, 'Переглянути NFT')),
    statusMsg,
    cardContainer,
    h('div', { class: 'tools', style: 'margin-top:10px' },
      h('span', { class: 'note' }, 'Швидкі посилання маркетплейсів для першого рахунку:'),
      h('a', { href: `https://opensea.io/${first}` }, 'OpenSea'),
      h('a', { href: `https://rarible.com/user/${first}` }, 'Rarible'),
      net && net.explorer ? h('a', { href: `${net.explorer}/address/${first}#nfttransfers` }, 'Перекази NFT в оглядачі') : ''));
}

render();
setInterval(async () => { const st = await call('wallet:status'); if (st.vault !== 'unlocked' && document.querySelector('.list')) render(); }, 5000);
