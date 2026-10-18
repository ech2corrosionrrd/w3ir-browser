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
  if (st.hidden) return renderHidden(st);
  if (st.vault === 'none') return gate('Гаманець зберігається у зашифрованому сховищі паролів.', 'Створити сховище паролів', 'w3ir://passwords');
  if (st.vault === 'locked') return renderUnlock();
  if (!st.exists) return renderSetup();
  return renderDashboard(st);
}

function gate(text, linkText, href) {
  app.append(h('div', { class: 'card' }, h('p', null, text), h('a', { href }, linkText)));
}

// Гаманець приховано: бачимо лише картку з кнопкою «Показати» (потрібен майстер-пароль; заблоковане сховище розблоковується тим самим паролем)
function renderHidden(st) {
  const m = h('input', { type: 'password', placeholder: 'Майстер-пароль', autocomplete: 'off' });
  const err = h('div', { class: 'merr' });
  const go = async () => {
    if (st.vault === 'locked') {
      const u = await call('vault:unlock', { master: m.value });
      if (!u.ok) { err.textContent = u.error; return; }
    }
    const r = await call('wallet:unhide', { master: m.value });
    m.value = '';
    if (r && r.ok) render(); else err.textContent = (r && r.error) || t('Не вдалося показати гаманець.');
  };
  m.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  app.append(h('div', { class: 'card' }, h('h2', null, 'Гаманець приховано'),
    h('p', { class: 'note' }, 'Гаманця немає в меню, на стартовій сторінці й панелі, а сайти його не бачать. Дані лишаються в зашифрованому сховищі. Щоб показати гаманець, введіть майстер-пароль.'),
    m, err, h('button', { class: 'primary', onclick: go }, 'Показати гаманець')));
  m.focus();
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

async function renderDashboard(st) {
  const info = st.info;
  const sol = info.sol;
  const net = info.networks.find(n => n.chainId === info.activeChain) || info.networks[0];
  const nameOf = (i) => info.names[i] || `Рахунок ${i + 1}`;
  const imp = info.imported || [];
  const impTag = (a) => (a.chain === 'sol' ? 'SOL' : 'EVM');
  const watch = info.watch || []; // рахунки лише для перегляду (без ключа)
  // усі рахунки для вибору: похідні від фрази (EVM+Solana) та імпортовані за ключем (одна мережа)
  const acctOptions = () => [...info.accounts.map((a, i) => ({ id: i, label: nameOf(i), chain: null })), ...imp.map(a => ({ id: a.id, label: `${a.name || short(a.address)} (${impTag(a)})`, chain: a.chain }))];
  // рахунки для ПЕРЕГЛЯДУ (токени, NFT, історія): власні й лише для перегляду; для переказів використовується acctOptions
  const viewOptions = () => [...acctOptions(), ...watch.map(a => ({ id: a.id, label: `${a.name || short(a.address)} (${impTag(a)} \u00B7 ${t('перегляд')})`, chain: a.chain }))];
  const solAddrOf = (id) => (id >= 5000 ? (watch.find(a => a.id === id && a.chain === 'sol') || {}).address : (id >= 1000 ? (imp.find(a => a.id === id && a.chain === 'sol') || {}).address : sol.addresses[id]));
  const optionEls = (selected) => acctOptions().map(o => h('option', { value: String(o.id), selected: o.id === selected }, o.label));
  const viewEls = (selected) => viewOptions().map(o => h('option', { value: String(o.id), selected: o.id === selected }, o.label));
  // QR-код адреси (малюється DOM-елементами з матриці, без innerHTML)
  async function showQr(title, address) {
    const r = await call('wallet:qr', { text: address });
    if (!r.ok) { alert(r.error); return; }
    const q = r.qr, cell = 6, quiet = 4, dim = (q.size + quiet * 2) * cell;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${dim} ${dim}`); svg.setAttribute('width', '240'); svg.setAttribute('height', '240'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'QR-код адреси');
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('width', String(dim)); bg.setAttribute('height', String(dim)); bg.setAttribute('fill', '#fff'); svg.append(bg);
    let d = '';
    for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.rows[y][x] === '1') d += `M${(x + quiet) * cell} ${(y + quiet) * cell}h${cell}v${cell}h-${cell}z`;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d); path.setAttribute('fill', '#000'); svg.append(path);
    const box = h('div', { class: 'modal', onmousedown: (e) => { if (e.target === box) box.remove(); } },
      h('div', { class: 'mbox', style: 'text-align:center' }, h('h2', { class: 'mtitle' }, title), h('div', { style: 'display:inline-block;padding:6px;background:#fff;border-radius:10px' }, svg),
        h('div', { class: 'pw', style: 'user-select:text;word-break:break-all;margin:12px 0;font-size:12px' }, address),
        h('p', { class: 'note' }, 'Покажіть цей код відправнику. Перевірте, що адреса під кодом збігається з адресою у вашого гаманця.'),
        h('div', { class: 'mbtns' }, h('button', { class: 'primary', onclick: () => box.remove() }, 'Закрити'))));
    document.body.append(box);
  }
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
  const evmOpts = () => acctOptions().filter(o => o.chain !== 'sol');
  const solOpts = () => acctOptions().filter(o => o.chain !== 'evm');
  const dappSel = (chainKey, opts, current) => {
    const sel = h('select', { 'aria-label': chainKey === 'sol' ? 'Рахунок для сайтів: Solana' : 'Рахунок для сайтів: EVM', onchange: async () => {
      const r = await call('wallet:setDappAccount', { chain: chainKey, index: Number(sel.value) });
      if (!r.ok) alert(r.error);
    } }, opts().map(o => h('option', { value: String(o.id), selected: o.id === current }, o.label)));
    return sel;
  };
  const summary = h('div', { class: 'wsum' },
    h('div', { class: 'wlock' }, h('span', { class: 'dot ok' }), h('div', null, h('div', { class: 't' }, 'Сховище розблоковано'), h('div', { class: 'd' }, 'Підпис і переказ потребують окремого підтвердження'))),
    h('div', { class: 'wnets' },
      h('label', null, h('span', null, 'EVM'), evmSel),
      h('label', null, h('span', null, 'Solana'), solSel),
      h('label', null, h('span', null, 'Сайти: EVM'), dappSel('evm', evmOpts, info.dapp.evm)),
      h('label', null, h('span', null, 'Сайти: Solana'), dappSel('sol', solOpts, info.dapp.sol))),
    h('div', { class: 'wquick' },
      h('button', { class: 'primary', title: 'Надіслати з першого рахунку (інший рахунок — у його картці нижче)', onclick: () => sendDialog(0) }, 'Надіслати'),
      h('button', { title: 'QR-код і адреса першого рахунку EVM', onclick: () => showQr(`${nameOf(0)} · EVM`, info.accounts[0]) }, 'Отримати'),
      h('button', { onclick: async () => { await call('vault:lock'); render(); } }, 'Заблокувати')));

  // ----- рахунки (EVM + Solana разом) -----
  const evmBal = {}, solBal = {};
  const usdFmt = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });
  const usdOf = (amount, price) => (price && Number.isFinite(Number(amount)) ? usdFmt.format(Number(amount) * price) : '');
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
    const qrE = h('button', { class: 'link', onclick: () => showQr(`${nameOf(i)} · EVM`, a) }, 'QR');
    const qrS = h('button', { class: 'link', onclick: () => showQr(`${nameOf(i)} · Solana`, sa) }, 'QR');
    return h('div', { class: 'acct' },
      h('div', { class: 'ahead' },
        h('span', { class: 'avatar' }, String(i + 1)),
        h('div', { class: 'aname' }, nameOf(i), h('button', { class: 'link', title: 'Перейменувати', onclick: () => rename(i) }, '✎')),
        h('div', { class: 'aact' },
          h('button', { class: 'primary', onclick: () => sendDialog(i) }, 'Надіслати'),
          h('button', { onclick: () => { tokAcct.value = String(i); loadTokens(i); document.getElementById('tokens-anchor').scrollIntoView({ behavior: 'smooth' }); } }, 'Токени та NFT'))),
      h('div', { class: 'chain' }, h('span', { class: 'tag' }, 'EVM'), h('code', null, a), eb, copyBtnE, qrE, net.explorer ? h('a', { href: `${net.explorer}/address/${a}` }, 'Оглядач') : ''),
      h('div', { class: 'chain' }, h('span', { class: 'tag sol' }, 'SOL'), h('code', null, sa), sb, copyBtnS, qrS, h('a', { href: solExplorer(sa, sol.cluster) }, 'Оглядач')));
  }));
  // імпортовані рахунки
  const impCards = imp.map((a) => {
    const bal = h('span', { class: 'bal' }, '…');
    (a.chain === 'sol' ? solBal : evmBal)[a.address] = bal;
    const cp = h('button', { class: 'link', onclick: () => copy(a.address, cp) }, 'Копіювати');
    return h('div', { class: 'acct' },
      h('div', { class: 'ahead' }, h('span', { class: 'avatar imp' }, '\u2193'),
        h('div', { class: 'aname' }, a.name || t('Імпортований рахунок'), h('button', { class: 'link', title: 'Перейменувати', onclick: () => rename(a.id) }, '\u270E')),
        h('div', { class: 'aact' }, h('button', { class: 'primary', onclick: () => sendDialog(a.id, { chain: a.chain }) }, 'Надіслати'),
          h('button', { onclick: () => { tokAcct.value = String(a.id); loadTokens(a.id); document.getElementById('tokens-anchor').scrollIntoView({ behavior: 'smooth' }); } }, 'Токени та NFT'))),
      h('div', { class: 'chain' }, h('span', { class: 'tag' + (a.chain === 'sol' ? ' sol' : '') }, impTag(a)), h('code', null, a.address), bal, cp,
        h('button', { class: 'link', onclick: () => showQr(a.name || impTag(a), a.address) }, 'QR'),
        h('a', { href: a.chain === 'sol' ? solExplorer(a.address, sol.cluster) : (net.explorer ? `${net.explorer}/address/${a.address}` : '#') }, 'Оглядач')),
      h('div', { class: 'chain' }, h('span', { class: 'note' }, 'Імпортовано за приватним ключем: не відновлюється з фрази гаманця й недоступний сайтам (dApp).'),
        h('button', { class: 'link', onclick: async () => { const r = await withAuth((x) => call('wallet:revealKey', { id: a.id, ...x })); if (r && r.ok) showSecret(r.key); else if (r && r.error) alert(r.error); } }, 'Показати ключ'),
        h('button', { class: 'link danger', onclick: async () => { const r = await withAuth((x) => call('wallet:removeImported', { id: a.id, ...x })); if (r && r.ok) render(); else if (r && r.error) alert(r.error); } }, 'Видалити')));
  });
  const watchCards = watch.map((a) => {
    const bal = h('span', { class: 'bal' }, '\u2026');
    (a.chain === 'sol' ? solBal : evmBal)[a.address] = bal;
    const cp = h('button', { class: 'link', onclick: () => copy(a.address, cp) }, 'Копіювати');
    return h('div', { class: 'acct' },
      h('div', { class: 'ahead' }, h('span', { class: 'avatar imp' }, '\u{1F441}'),
        h('div', { class: 'aname' }, a.name || short(a.address), h('button', { class: 'link', title: 'Перейменувати', onclick: () => rename(a.id) }, '\u270E')),
        h('div', { class: 'aact' }, h('button', { onclick: () => { tokAcct.value = String(a.id); loadTokens(a.id); document.getElementById('tokens-anchor').scrollIntoView({ behavior: 'smooth' }); } }, 'Токени та NFT'))),
      h('div', { class: 'chain' }, h('span', { class: 'tag' + (a.chain === 'sol' ? ' sol' : '') }, impTag(a)), h('code', null, a.address), bal, cp,
        h('button', { class: 'link', onclick: () => showQr(a.name || impTag(a), a.address) }, 'QR'),
        h('a', { href: a.chain === 'sol' ? solExplorer(a.address, sol.cluster) : (net.explorer ? `${net.explorer}/address/${a.address}` : '#') }, 'Оглядач')),
      h('div', { class: 'chain' }, h('span', { class: 'note' }, 'Лише перегляд: ключа немає, надсилати, підписувати чи підключати до сайтів цю адресу неможливо.'),
        h('button', { class: 'link danger', onclick: async () => { const r = await call('wallet:removeWatch', { id: a.id }); if (r.ok) render(); else alert(r.error); } }, 'Прибрати')));
  });
  const accountsAll = h('div', { class: 'accts' }, [...accounts.childNodes, ...impCards, ...watchCards]);
  const showBalances = async (r, bals, chain) => {
    if (!r.ok) return;
    const pr = await call('wallet:prices', { chain }).catch(() => null);
    const price = pr && pr.ok && pr.enabled ? pr.native : null;
    for (const b of r.balances) {
      if (!bals[b.address]) continue;
      const usd = b.balance === null ? '' : usdOf(b.balance, price);
      bals[b.address].textContent = b.balance === null ? 'баланс недоступний' : `${Number(b.balance).toFixed(5)} ${b.symbol}${usd ? ' \u00B7 \u2248 ' + usd : ''}`;
    }
  };
  call('wallet:balances').then(r => showBalances(r, evmBal, 'evm'));
  call('wallet:solBalances').then(r => showBalances(r, solBal, 'sol'));

  // ----- токени й NFT обох мереж -----
  const tokAcct = h('select', { 'aria-label': 'Рахунок', onchange: () => loadTokens() }, viewEls());
  const tokChain = h('select', { 'aria-label': 'Мережа', onchange: () => loadTokens() },
    h('option', { value: 'evm' }, net.name), h('option', { value: 'sol' }, `Solana ${sol.clusters.find(c => c.id === sol.cluster).name}`));
  const tokMsg = h('div', { class: 'note', style: 'margin:8px 0' });
  const tokList = h('div', { class: 'list' });
  const nftGrid = h('div', { class: 'nft-grid' });
  const nftMsg = h('div', { class: 'note', style: 'margin:8px 0' });
  const nftMore = h('div', { class: 'bar' });
  const nftContract = h('input', { type: 'text', class: 'pw', placeholder: 'Адреса контракту NFT', spellcheck: false, autocomplete: 'off', style: 'flex:1' });
  const nftId = h('input', { type: 'text', placeholder: 'ID токена', inputMode: 'numeric', autocomplete: 'off', style: 'width:120px' });
  const nftAddMsg = h('span', { class: 'note' });
  const nftAddBar = h('div', { class: 'bar', style: 'margin-top:10px;display:none' }, nftContract, nftId,
    h('button', { onclick: async () => {
      nftAddMsg.textContent = '…';
      const r = await call('wallet:addNft', { contract: nftContract.value.trim(), id: nftId.value.trim() });
      if (!r.ok) { nftAddMsg.textContent = r.error; return; }
      nftContract.value = ''; nftId.value = ''; nftAddMsg.textContent = '';
      loadTokens();
    } }, 'Додати NFT'),
    h('button', { onclick: async () => {
      nftAddMsg.textContent = t('Шукаю серед недавніх переказів\u2026');
      const r = await call('wallet:discoverNfts', { index: Number(tokAcct.value) });
      if (!r.ok) { nftAddMsg.textContent = r.error; return; }
      nftAddMsg.textContent = t('Знайдено нових: {0}.', r.added) + (r.partial ? ' ' + t('Пошук неповний (обмеження RPC): додайте решту вручну.') : '');
      if (r.added) loadTokens();
    } }, 'Знайти NFT'), nftAddMsg);
  const tokAdd = h('input', { type: 'text', class: 'pw', placeholder: 'Адреса контракту токена (ERC-20)', spellcheck: false, autocomplete: 'off', style: 'flex:1' });
  const tokAddMsg = h('span', { class: 'note' });
  // Пошук токенів ERC-20 за недавніми переказами: показує знайдені (з ненульовим балансом), додає лише те, що ви оберете
  const findTokens = async () => {
    tokAddMsg.textContent = t('Шукаю серед недавніх переказів\u2026');
    const r = await call('wallet:discoverTokens', { index: Number(tokAcct.value) });
    if (!r.ok) { tokAddMsg.textContent = r.error; return; }
    tokAddMsg.textContent = r.partial ? t('Пошук неповний (обмеження RPC): додайте решту вручну.') : '';
    if (!r.tokens.length) { tokAddMsg.textContent = t('Нових токенів з балансом не знайдено.') + (r.partial ? ' ' + t('Пошук неповний (обмеження RPC): додайте решту вручну.') : ''); return; }
    const box = h('div', { class: 'modal', onmousedown: (e) => { if (e.target === box) box.remove(); } });
    const list = h('div', { class: 'list' }, r.tokens.map((tk) => {
      const btn = h('button', { onclick: async () => {
        btn.disabled = true;
        const a = await call('wallet:addToken', { address: tk.address });
        if (a.ok) { btn.textContent = t('Додано'); loadTokens(); } else { btn.disabled = false; alert(a.error); }
      } }, 'Додати');
      return h('div', { class: 'row' }, h('div', null, h('div', null, `${tk.symbol}${tk.name ? ' — ' + tk.name : ''}`, tk.suspicious ? h('span', { class: 'note' }, ' ⚠ ' + t('схоже на розсилку')) : ''),
        h('div', { class: 'd' }, `${tk.amount} · ${tk.address}`)), btn);
    }));
    box.append(h('div', { class: 'mbox' }, h('h2', { class: 'mtitle' }, 'Знайдені токени'),
      h('p', { class: 'note' }, 'Токени з недавніх переказів на цей рахунок. Додавайте лише ті, які впізнаєте: шахраї надсилають токени-приманки.'), list,
      h('div', { class: 'mbtns' }, h('button', { class: 'primary', onclick: () => box.remove() }, 'Закрити'))));
    document.body.append(box);
  };
  const tokAddBar = h('div', { class: 'bar', style: 'margin-top:10px' }, tokAdd, h('button', { onclick: findTokens }, 'Знайти токени'), h('button', { onclick: async () => {
    tokAddMsg.textContent = '…';
    const r = await call('wallet:addToken', { address: tokAdd.value.trim() });
    if (!r.ok) { tokAddMsg.textContent = r.error; return; }
    tokAdd.value = ''; tokAddMsg.textContent = t('Додано: {0}', r.token.symbol);
    loadTokens();
  } }, 'Додати токен'), tokAddMsg);
  async function loadTokens(i, chain) {
    if (i !== undefined) tokAcct.value = String(i);
    if (chain) tokChain.value = chain;
    const idx = Number(tokAcct.value);
    const picked = viewOptions().find(o => o.id === idx);
    if (picked && picked.chain) tokChain.value = picked.chain;
    tokChain.disabled = !!(picked && picked.chain);
    const isSol = tokChain.value === 'sol';
    const canSend = idx < 5000; // рахунки лише для перегляду нічого не надсилають
    nftGen++; const gen = nftGen; // нове завантаження скасовує незавершені запити метаданих попереднього рахунку
    tokMsg.textContent = '…'; tokList.textContent = ''; nftGrid.textContent = ''; nftMsg.textContent = ''; nftMore.textContent = '';
    nftAddBar.style.display = 'none';
    const usdSpans = []; // [адреса, елемент, кількість] — ціни підставляються після завантаження
    const fillUsd = async (chain) => {
      if (!usdSpans.length) return;
      const pr = await call('wallet:prices', { chain, tokens: usdSpans.map(x => x[0]) }).catch(() => null);
      if (!pr || !pr.ok || !pr.enabled) return;
      for (const [addr, el, amt] of usdSpans) { const u = usdOf(amt, pr.tokens[addr]); if (u) el.textContent = '\u2248 ' + u; }
    };
    tokList.style.display = 'none';
    tokAddBar.style.display = isSol ? 'none' : '';
    if (isSol) {
      const r = await call('wallet:solTokens', { address: solAddrOf(idx) });
      if (gen !== nftGen) return;
      if (!r.ok) { tokMsg.textContent = r.error || 'Помилка'; return; }
      if (!r.tokens.length) { tokMsg.textContent = 'Токенів і NFT на цьому рахунку немає.'; return; }
      tokMsg.textContent = (r.total > r.shown ? t('Показано {0} із {1}.', r.shown, r.total) + ' ' : '') + 'Назви токенів задають їхні творці й можуть вводити в оману: звіряйте адресу mint.';
      for (const tk of r.tokens) {
        const title = tk.name || short(tk.mint);
        const link = h('a', { href: solExplorer(tk.mint, r.cluster) }, 'Оглядач');
        if (tk.nft) continue; // NFT показує галерея нижче (з сторінками й лінивим завантаженням)
        tokList.style.display = '';
        const usd = h('span', { class: 'note' }, '');
        usdSpans.push([tk.mint, usd, tk.amount]);
        tokList.append(h('div', { class: 'item' }, h('div', { class: 'main' }, h('div', { class: 't' }, title + (tk.symbol ? ` (${tk.symbol})` : '')), h('div', { class: 's pw', style: 'user-select:text' }, tk.mint)),
          h('span', { class: 'note' }, tk.amount), usd, canSend ? h('button', { class: 'link', onclick: () => sendDialog(idx, { chain: 'sol', asset: tk.mint }) }, 'Надіслати') : '', link));
      }
      fillUsd('sol');
      loadSolNfts(idx, 0, gen);
      return;
    }
    const r = await call('wallet:evmTokens', { index: idx });
    if (gen !== nftGen) return;
    if (!r.ok) { tokMsg.textContent = r.error || 'Помилка'; return; }
    tokMsg.textContent = r.tokens.length ? 'Баланси читаються з контрактів. Назви токенів задає їхній творець: звіряйте адресу контракту.' : 'У цій мережі немає токенів з ненульовим балансом. Додайте токен за адресою контракту.';
    for (const tk of r.tokens) {
      tokList.style.display = '';
      const net2 = info.networks.find(n => n.chainId === r.chainId);
      const usd = h('span', { class: 'note' }, '');
      if (tk.amount !== null) usdSpans.push([tk.address, usd, tk.amount]);
      tokList.append(h('div', { class: 'item' }, h('div', { class: 'main' }, h('div', { class: 't' }, `${tk.symbol}${tk.name ? ' — ' + tk.name : ''}`), h('div', { class: 's pw', style: 'user-select:text' }, tk.address)),
        h('span', { class: 'note' }, tk.amount === null ? 'баланс недоступний' : tk.amount), usd,
        canSend && tk.amount !== null && tk.raw !== '0' ? h('button', { class: 'link', onclick: () => sendDialog(idx, { chain: 'evm', asset: tk.address }) }, 'Надіслати') : '',
        net2 && net2.explorer ? h('a', { href: `${net2.explorer}/token/${tk.address}` }, 'Оглядач') : '',
        tk.custom ? h('button', { class: 'link danger', title: 'Прибрати зі списку', onclick: async () => { await call('wallet:removeToken', { address: tk.address }); loadTokens(); } }, '✕') : ''));
    }
    fillUsd('evm');
    loadEvmNfts(idx, gen);
  }

  // ----- NFT на EVM (ERC-721 / ERC-1155): показ, додавання, пошук, переказ -----
  // ----- ліниве завантаження метаданих NFT: лише для карток біля видимої частини, по 3 одночасно; велике зображення зменшується
  // в пісочниці сторінки (canvas), а оригінал відкидається -----
  let nftGen = 0;
  const metaQueue = [];
  let metaActive = 0;
  const pumpMeta = () => { while (metaActive < 3 && metaQueue.length) { const job = metaQueue.shift(); metaActive++; job().catch(() => {}).finally(() => { metaActive--; pumpMeta(); }); } };
  const metaObserver = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { metaObserver.unobserve(en.target); const f = en.target.__load; if (f) { metaQueue.push(f); pumpMeta(); } }
  }, { rootMargin: '300px' });
  function thumbnail(src, side = 360) {
    return new Promise((resolve) => {
      const im = new Image();
      im.onload = () => {
        try {
          const w0 = im.naturalWidth || side, h0 = im.naturalHeight || side, k = Math.min(1, side / Math.max(w0, h0));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(w0 * k)); c.height = Math.max(1, Math.round(h0 * k));
          c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/webp', 0.82));
        } catch { resolve(src.length < 400000 ? src : ''); }
      };
      im.onerror = () => resolve('');
      im.src = src;
    });
  }
  // Картка NFT: заголовок і зображення підставляються після завантаження метаданих (loader повертає { name, image, status|metadata })
  function nftCard({ title, badge, extra, actions, loader, gen }) {
    const img = h('img', { class: 'nft-thumb', alt: title, style: 'display:none' });
    const ttl = h('div', { class: 'nft-title' }, title);
    const note = h('div', { class: 'nft-desc' }, '');
    const card = h('div', { class: 'nft-card' }, img, h('div', { class: 'nft-body' }, h('span', { class: 'nft-badge' }, badge), ttl, extra || '', note, h('div', { class: 'tools', style: 'margin-top:8px' }, actions)));
    if (loader) {
      card.__load = async () => {
        if (gen !== nftGen) return;
        const m = await loader();
        if (gen !== nftGen || !m || !m.ok) return;
        if (m.name) { ttl.textContent = m.name; img.alt = m.name; }
        const state = m.status || m.metadata;
        if (m.image) { const th = await thumbnail(m.image); if (th) { img.src = th; img.style.display = ''; } }
        if (!m.image && state === 'external') note.textContent = t('Метадані на стороньому сервері не завантажуються (приватність). Дозвіл — у розділі «Безпека».');
        else if (!m.image && state === 'unavailable') note.textContent = t('Метадані недоступні зараз.');
      };
      metaObserver.observe(card);
    }
    return card;
  }
  const NFT_WARN = 'Назви й зображення NFT задає їхній творець і вони можуть вводити в оману: звіряйте адресу контракту. Зображення завантажуються лише з IPFS, Arweave або з блокчейну.';

  // Галерея NFT Solana: сторінки по 24, «Показати ще»
  async function loadSolNfts(idx, offset, gen) {
    const addr = solAddrOf(idx);
    nftMore.textContent = '';
    const r = await call('wallet:solNfts', { address: addr, offset, limit: 24 });
    if (gen !== nftGen) return;
    if (!r.ok) { nftMsg.textContent = r.error || 'Помилка'; return; }
    const shown = Math.min(r.total, offset + r.items.length);
    nftMsg.textContent = r.total ? t('NFT: {0} (показано {1}).', r.total, shown) + ' ' + t(NFT_WARN) : '';
    for (const it of r.items) {
      const title = it.name || short(it.mint);
      nftGrid.append(nftCard({
        title, badge: 'NFT', gen, loader: it.hasUri ? () => call('wallet:solNftMeta', { address: addr, mint: it.mint }) : null,
        extra: it.symbol ? h('div', { class: 'nft-desc' }, it.symbol) : '',
        actions: [idx < 5000 ? h('button', { class: 'link', onclick: () => sendDialog(idx, { chain: 'sol', nft: { chain: 'sol', mint: it.mint, label: title, standard: 'spl' } }) }, 'Надіслати') : '', h('a', { href: solExplorer(it.mint, r.cluster) }, 'Оглядач')],
      }));
    }
    if (shown < r.total) nftMore.append(h('button', { onclick: () => loadSolNfts(idx, shown, gen) }, t('Показати ще ({0})', r.total - shown)));
  }

  // Галерея NFT на EVM: список із контрактів, метадані ліниво
  async function loadEvmNfts(idx, gen) {
    nftAddBar.style.display = '';
    nftMsg.textContent = '…';
    const r = await call('wallet:nfts', { index: idx });
    if (gen !== nftGen) return; // користувач уже перемкнув рахунок
    if (!r.ok) { nftMsg.textContent = r.error || 'Помилка'; return; }
    const net2 = info.networks.find(n => n.chainId === r.chainId);
    nftMsg.textContent = r.items.length
      ? t(NFT_WARN)
      : (r.saved ? 'Збережені NFT цієї мережі не належать вибраному рахунку.' : 'NFT не знайдено. Додайте NFT за адресою контракту та id або знайдіть серед недавніх переказів.');
    for (const it of r.items) {
      const title = it.collection ? `${it.collection} #${it.id}` : `#${it.id}`;
      nftGrid.append(nftCard({
        title, badge: it.standard === 'erc1155' ? 'ERC-1155' : 'NFT', gen, loader: () => call('wallet:evmNftMeta', { contract: it.contract, id: it.id }),
        extra: h('div', null, it.collection ? h('div', { class: 'nft-desc' }, it.collection) : '', it.standard === 'erc1155' ? h('div', { class: 'nft-desc' }, t('Кількість: {0}', it.amount)) : '', h('div', { class: 'nft-desc pw', style: 'user-select:text' }, short(it.contract))),
        actions: [
          idx < 5000 ? h('button', { class: 'link', onclick: () => sendDialog(idx, { chain: 'evm', nft: { chain: 'evm', contract: it.contract, id: it.id, standard: it.standard, label: title, amount: it.amount } }) }, 'Надіслати') : '',
          net2 && net2.explorer ? h('a', { href: `${net2.explorer}/token/${it.contract}?a=${it.id}` }, 'Оглядач') : '',
          h('button', { class: 'link danger', title: 'Прибрати зі списку (не видаляє NFT)', onclick: async () => { await call('wallet:removeNft', { contract: it.contract, id: it.id }); loadTokens(); } }, 'Прибрати'),
        ],
      }));
    }
  }

  // ----- історія Solana з блокчейну -----
  const histList = h('div', { class: 'list' });
  const histMsg = h('div', { class: 'note', style: 'margin:8px 0' });
  const fmtSol = (v) => { const n = BigInt(v); const sign = n < 0n ? '-' : '+'; const a = n < 0n ? -n : n; return `${sign}${(Number(a) / 1e9).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} SOL`; };
  const fmtTok = (d) => { const n = BigInt(d.delta); const sign = n < 0n ? '-' : '+'; const a = n < 0n ? -n : n; const s = a.toString().padStart(d.decimals + 1, '0'); const w = s.slice(0, s.length - d.decimals), f = s.slice(s.length - d.decimals).replace(/0+$/, ''); return `${sign}${w}${f ? '.' + f : ''} ${short(d.mint)}`; };
  async function loadHistory() {
    histMsg.textContent = '…'; histList.textContent = '';
    const r = await call('wallet:solHistory', { address: solAddrOf(Number(histAcct.value)) });
    if (!r.ok) { histMsg.textContent = r.error || 'Помилка'; return; }
    histMsg.textContent = r.items.length ? '' : 'Транзакцій поки немає.';
    for (const it of r.items) {
      const parts = [];
      if (it.solDelta !== undefined && it.solDelta !== '0') parts.push(fmtSol(it.solDelta));
      for (const d of it.tokens || []) parts.push(fmtTok(d));
      histList.append(h('div', { class: 'item' },
        h('span', { class: 'time' }, it.time ? new Date(it.time).toLocaleString(LOCALE) : ''),
        h('div', { class: 'main' }, h('div', { class: 't' }, parts.join(' · ') || short(it.signature)), h('div', { class: 's pw' }, short(it.signature))),
        h('span', { class: 'chip ' + (it.ok ? 'ok' : 'bad') }, it.ok ? 'Підтверджено' : 'Помилка'),
        h('a', { href: `https://explorer.solana.com/tx/${it.signature}` + (r.cluster === 'mainnet-beta' ? '' : `?cluster=${r.cluster}`) }, 'Оглядач')));
    }
  }
  // ----- історія EVM (наближена, з журналів подій токенів) -----
  const evHistList = h('div', { class: 'list' });
  const evHistMsg = h('div', { class: 'note', style: 'margin:8px 0' });
  async function loadEvmHistory() {
    evHistMsg.textContent = t('Шукаємо перекази в останніх блоках…'); evHistList.textContent = '';
    const r = await call('wallet:evmHistory', { index: Number(evHistAcct.value) });
    if (!r.ok) { evHistMsg.textContent = r.error || 'Помилка'; return; }
    const net2 = info.networks.find(x => x.chainId === r.chainId);
    evHistMsg.textContent = (r.items.length ? '' : t('Переказів токенів і NFT у цьому проміжку не знайдено.') + ' ') + t('Переглянуто останні {0} блоків. Переказ основної монети подій не залишає: дивіться «Журнал» нижче.', r.scanned) + (r.partial ? ' ' + t('Мережа відповіла не повністю.') : '');
    const spamBox = h('details', { class: 'spam-box' }, h('summary', null, ''));
    let spamCount = 0;
    for (const it of r.items) {
      const sign = it.dir === 'in' ? '+' : '−';
      const what = it.kind === 'nft' ? `NFT #${it.id.length > 12 ? it.id.slice(0, 6) + '…' : it.id}` : (it.amount !== undefined ? `${sign}${it.amount.replace(/(\.\d{6})\d+$/, '$1')} ${it.symbol}` : t('Токен {0}', short(it.token)));
      const row = h('div', { class: 'item' },
        h('span', { class: 'time' }, it.time ? new Date(it.time).toLocaleString(LOCALE) : ''),
        h('div', { class: 'main' }, h('div', { class: 't' }, (it.kind === 'nft' ? sign + ' ' : '') + what), h('div', { class: 's pw', title: it.peer }, t(it.dir === 'in' ? 'від {0}' : 'до {0}', it.peerName || short(it.peer)) + ' · ' + short(it.hash))),
        h('span', { class: 'chip ' + (it.dir === 'in' ? 'ok' : '') }, it.dir === 'in' ? t('Отримано') : t('Надіслано')),
        net2 && net2.explorer ? h('a', { href: `${net2.explorer}/tx/${it.hash}` }, 'Оглядач') : '');
      if (it.suspicious) { spamCount++; spamBox.append(row); } else evHistList.append(row);
    }
    if (spamCount) {
      spamBox.firstChild.textContent = t('Підозрілі перекази ({0}): токени-розсилки від невідомих адрес. Не взаємодійте з ними й не переходьте за посиланнями з їхніх назв.', spamCount);
      evHistList.append(spamBox);
    }
    evHistCsv.hidden = !r.items.length;
  }
  const evHistCsv = h('button', { hidden: true, onclick: async () => {
    const r = await call('wallet:evmHistoryCsv', { index: Number(evHistAcct.value) });
    evHistMsg.textContent = r.ok ? t('Збережено: {0}', r.path) : (r.error || 'Помилка');
  } }, 'Зберегти CSV');
  const evHistAcct = h('select', { 'aria-label': 'Рахунок', onchange: loadEvmHistory }, viewOptions().filter(o => o.chain !== 'sol').map(o => h('option', { value: String(o.id) }, o.label)));
  const histAcct = h('select', { 'aria-label': 'Рахунок', onchange: loadHistory }, [...info.accounts.map((a, i) => h('option', { value: String(i) }, nameOf(i))), ...imp.filter(a => a.chain === 'sol').map(a => h('option', { value: String(a.id) }, a.name || short(a.address))), ...watch.filter(a => a.chain === 'sol').map(a => h('option', { value: String(a.id) }, `${a.name || short(a.address)} (${t('перегляд')})`))]);

  // ----- підключені сайти (EVM і Solana разом) з вибором рахунку для кожного -----
  const connected = h('div', { class: 'list' });
  const sites = new Map();
  for (const c of info.connections) sites.set(c.origin, { evm: c.chainId, evmAddr: c.accounts[0], sol: false });
  for (const c of sol.connections) sites.set(c.origin, { ...(sites.get(c.origin) || {}), sol: true, solAddr: c.address });
  const idOf = (addr, chain) => {
    const list = chain === 'sol' ? sol.addresses : info.accounts;
    const i = list.indexOf(addr);
    if (i >= 0) return i;
    const a = imp.find(x => x.chain === chain && x.address === addr);
    return a ? a.id : -1;
  };
  const siteSel = (origin, chain, addr) => {
    const sel = h('select', { 'aria-label': 'Рахунок для сайту', onchange: async () => {
      const r = await call('wallet:setSiteAccount', { origin, chain, index: Number(sel.value) });
      if (!r.ok) { alert(r.error); render(); }
    } }, (chain === 'sol' ? solOpts() : evmOpts()).map(o => h('option', { value: String(o.id), selected: o.id === idOf(addr, chain) }, o.label)));
    return sel;
  };
  if (!sites.size) connected.append(h('div', { class: 'row' }, 'Жоден сайт не підключено.'));
  for (const [origin, c] of sites) {
    connected.append(h('div', { class: 'item', style: 'flex-wrap:wrap' },
      h('div', { class: 'main' }, h('div', { class: 't' }, origin), h('div', { class: 's' }, [c.evm ? `EVM (chainId ${c.evm})` : '', c.sol ? 'Solana' : ''].filter(Boolean).join(' · '))),
      c.evm ? h('span', { class: 'tag' }, 'EVM') : '', c.evm ? siteSel(origin, 'evm', c.evmAddr) : '',
      c.sol ? h('span', { class: 'tag sol' }, 'SOL') : '', c.sol ? siteSel(origin, 'sol', c.solAddr) : '',
      h('button', { class: 'link danger', onclick: async () => { await call('wallet:disconnect', { origin }); render(); } }, 'Відключити')));
  }

  // ----- журнал -----
  const log = h('div', { class: 'list' });
  const statusEls = new Map();
  const itemEls = new Map();
  if (!info.log.length) log.append(h('div', { class: 'row' }, 'Подій поки немає.'));
  for (const e of info.log.slice(0, 30)) {
    const n = info.networks.find(x => x.chainId === e.chainId);
    const isSol = typeof e.chainId === 'string';
    const href = e.hash ? (isSol ? `https://explorer.solana.com/tx/${e.hash}` + (e.chainId === 'mainnet-beta' ? '' : `?cluster=${e.chainId}`) : (n && n.explorer ? `${n.explorer}/tx/${e.hash}` : '')) : '';
    const chip = e.hash ? h('span', { class: 'chip' }, '') : '';
    if (e.hash) statusEls.set(e.hash, chip);
    const row = h('div', { class: 'item' }, h('span', { class: 'time' }, new Date(e.t).toLocaleString(LOCALE)),
      h('div', { class: 'main' }, h('div', { class: 't' }, e.action), h('div', { class: 's' }, e.origin + (e.hash ? ' · ' + short(e.hash) : ''))),
      chip,
      href ? h('a', { href }, 'Оглядач') : '');
    if (e.hash) itemEls.set(e.hash, row);
    log.append(row);
  }

  const logEntries = info.log.slice(0, 30).filter(e => e.hash).map(e => ({ hash: e.hash, chainId: e.chainId }));
  if (logEntries.length) {
    call('wallet:txStatuses', { items: logEntries }).then((r) => {
      if (!r.ok) return;
      const label = { confirmed: 'Підтверджено', pending: 'Очікує', failed: 'Помилка' };
      for (const [hash, st] of Object.entries(r.statuses)) {
        const el = statusEls.get(hash);
        if (el && label[st]) { el.textContent = label[st]; el.className = 'chip ' + (st === 'confirmed' ? 'ok' : st === 'failed' ? 'bad' : 'wait'); }
      }
    });
  }

  call('wallet:pending').then((r) => {
    if (!r.ok) return;
    for (const p of r.items) {
      const row = itemEls.get(p.hash);
      if (!row) continue;
      const act = (mode) => async () => {
        const res = await call('wallet:replace', { hash: p.hash, mode });
        if (!res.ok) { alert(res.error); return; }
        render();
      };
      row.append(h('button', { class: 'link', onclick: act('speedup') }, 'Прискорити'), h('button', { class: 'link danger', onclick: act('cancel') }, 'Скасувати'));
    }
  });

  // ----- адресна книга -----
  const contactsBox = h('div', { class: 'list' });
  const cName = h('input', { type: 'text', placeholder: 'Назва', spellcheck: false, style: 'max-width:200px' });
  const cAddr = h('input', { type: 'text', class: 'pw', placeholder: 'Адреса (EVM або Solana)', spellcheck: false, autocomplete: 'off', style: 'flex:1' });
  const cMsg = h('span', { class: 'note' });
  async function loadContacts() {
    const r = await call('wallet:contacts');
    contactsBox.textContent = '';
    if (!r.ok || !r.contacts.length) { contactsBox.append(h('div', { class: 'row' }, 'Контактів поки немає.')); return; }
    for (const c of r.contacts) {
      contactsBox.append(h('div', { class: 'item' }, h('span', { class: 'tag' + (c.chain === 'sol' ? ' sol' : '') }, c.chain === 'sol' ? 'SOL' : 'EVM'),
        h('div', { class: 'main' }, h('div', { class: 't' }, c.name), h('div', { class: 's pw', style: 'user-select:text' }, c.address)),
        h('button', { class: 'link danger', onclick: async () => { await call('wallet:removeContact', { address: c.address }); loadContacts(); } }, 'Видалити')));
    }
  }

  // ----- імпорт рахунку за приватним ключем -----
  async function watchDialog() {
    const a = await ask('Додати адресу для перегляду', [{ name: 'address', label: 'Адреса (EVM або Solana)' }, { name: 'name', label: 'Назва (необов\u2019язково, до 32 символів)' }], { okText: 'Додати', note: 'Рахунок лише для перегляду: гаманець показує баланси, токени, NFT та історію цієї адреси, але не має її ключа й не може нічого підписати чи надіслати.' });
    if (!a) return;
    const r = await call('wallet:addWatch', { address: a.address, name: a.name });
    if (r.ok) render(); else alert(r.error);
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
  function revokeDialog() {
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

  // ----- портфель по всіх мережах (за запитом: багато звернень до RPC) -----
  const pfMsg = h('div', { class: 'note', style: 'margin:8px 0' }, 'Підсумок по всіх основних мережах EVM і Solana: нативні монети та відомі токени (вбудований список і додані вами) на всіх рахунках, в USD за орієнтовними цінами. Рахунки лише для перегляду в суму не входять.');
  const pfTotal = h('div', { class: 'pf-total', style: 'font-size:22px;font-weight:600;margin:6px 0' });
  const pfList = h('div', { class: 'list' });
  const money = (v) => (v === null || v === undefined ? '\u2014' : usdFmt.format(v));
  const fmtAmt = (a) => { const n = Number(a); return Number.isFinite(n) ? (n >= 1000 ? n.toFixed(2) : n.toFixed(5).replace(/0+$/, '').replace(/\.$/, '')) : String(a); };
  async function loadPortfolio(force) {
    pfMsg.textContent = '\u2026'; pfList.textContent = ''; pfTotal.textContent = '';
    const r = await call('wallet:portfolio', { force: !!force });
    if (!r.ok) { pfMsg.textContent = r.error; return; }
    pfMsg.textContent = (r.pricesOn ? '' : t('Ціни вимкнено в налаштуваннях безпеки: показано лише кількість.') + ' ') + t('Оновлено {0}. Ціни орієнтовні.', new Date(r.at).toLocaleTimeString(LOCALE));
    pfTotal.textContent = r.pricesOn ? t('Разом: {0}', money(r.total)) + (r.watchTotal ? '  \u00B7  ' + t('для перегляду: {0}', money(r.watchTotal)) : '') : '';
    const rowEl = (title, usd, rows) => {
      const parts = [];
      for (const row of rows) {
        const bits = [];
        if (row.native && Number(row.native.amount) > 0) bits.push(`${fmtAmt(row.native.amount)} ${title.symbol}`);
        for (const tk of row.tokens) bits.push(`${fmtAmt(tk.amount)} ${tk.symbol || short(tk.address)}`);
        if (bits.length) parts.push(h('div', { class: 's' }, `${row.watch ? '\u{1F441} ' : ''}${short(row.address)}: ${bits.join(', ')}${row.priced === false ? ' (' + t('частина без ціни') + ')' : ''}`));
      }
      return h('div', { class: 'item', style: 'flex-wrap:wrap' }, h('div', { class: 'main' }, h('div', { class: 't' }, title.name + (title.error ? ` \u2014 ${title.error}` : '')), parts.length ? parts : h('div', { class: 's' }, title.error ? '' : t('Порожньо'))), h('span', { class: 'note' }, r.pricesOn && !title.error ? money(usd) : ''));
    };
    for (const c of r.chains) pfList.append(rowEl({ name: c.name, symbol: c.symbol, error: c.error }, c.usd + c.watchUsd, c.rows));
    if (!r.sol.skipped) pfList.append(rowEl({ name: 'Solana', symbol: 'SOL' }, r.sol.usd + r.sol.watchUsd, r.sol.rows));
    else pfList.append(h('div', { class: 'item' }, h('div', { class: 'main' }, h('div', { class: 't' }, 'Solana'), h('div', { class: 's' }, t('Не Mainnet Beta: ціни й підсумок не рахуються')))));
  }
  const portfolioBox = h('div', null, h('div', { class: 'bar' }, h('button', { class: 'primary', onclick: () => loadPortfolio(false) }, 'Показати портфель'), h('button', { onclick: () => loadPortfolio(true) }, 'Оновити')), pfMsg, pfTotal, pfList);

  // ----- режими обережності -----
  const pol = info.policy || {};
  const polContacts = h('input', { type: 'checkbox', class: 'switch', checked: !!pol.contactsOnly });
  const polConfirm = h('input', { type: 'number', min: '0', step: 'any', value: String(pol.confirmUsd || 0), style: 'width:110px;flex:none' });
  const polMax = h('input', { type: 'number', min: '0', step: 'any', value: String(pol.maxUsd || 0), style: 'width:110px;flex:none' });
  const polDays = h('input', { type: 'number', min: '0', max: '365', step: '1', value: String(pol.siteDays || 0), style: 'width:80px;flex:none' });
  const polMsg = h('span', { class: 'note' });
  const polRow = 'display:flex;gap:10px;align-items:center;justify-content:flex-start';
  const policyBox = h('div', { style: 'display:grid;gap:8px' },
    h('label', { style: polRow }, polContacts, h('span', null, 'Надсилати лише на мої рахунки та адреси з адресної книги')),
    h('label', { style: polRow }, polConfirm, h('span', null, 'USD: підтвердження великих сум із паузою 5 с (від; 0 — вимкнено)')),
    h('label', { style: polRow }, polMax, h('span', null, 'USD: забороняти переказ більше за (0 — без ліміту)')),
    h('label', { style: polRow }, polDays, h('span', null, 'Відключати сайти, якими не користувались N днів (0 — ніколи)')),
    h('div', { class: 'bar' }, h('button', { class: 'primary', onclick: async () => {
      polMsg.textContent = '\u2026';
      const r = await withAuth((x) => call('wallet:setPolicy', { ...x, policy: { contactsOnly: polContacts.checked, confirmUsd: Number(polConfirm.value) || 0, maxUsd: Number(polMax.value) || 0, siteDays: Math.floor(Number(polDays.value) || 0) } }));
      if (!r) { polMsg.textContent = ''; return; }
      polMsg.textContent = r.ok ? t('Збережено.') : r.error;
    } }, 'Зберегти'), polMsg));

  // ----- резервна копія файлом -----
  async function backupExportDialog() {
    const a = await ask('Зберегти зашифровану копію', [{ name: 'password', label: 'Пароль резервної копії (від 12 символів)', type: 'password' }, { name: 'password2', label: 'Повторіть пароль', type: 'password' }], { okText: 'Вибрати файл і зберегти', note: 'Це НЕ майстер-пароль: його знадобиться ввести при відновленні. Без нього файл не прочитати, а хто знає і файл, і пароль — контролює кошти. Зберігайте їх окремо.' });
    if (!a) return;
    const r = await withAuth((x) => call('wallet:backupExport', { ...x, password: a.password, password2: a.password2 }));
    if (!r) return;
    alert(r.ok ? t('Копію збережено: {0}', r.path) : r.error);
  }

  // ----- активні дозволи токенів і NFT -----
  const apAcct = h('select', { 'aria-label': 'Рахунок', onchange: () => loadApprovals() }, evmOpts().map(o => h('option', { value: String(o.id) }, o.label)));
  const apMsg = h('div', { class: 'note', style: 'margin:8px 0' });
  const apList = h('div', { class: 'list' });
  let apDanger = [];
  const apBulk = h('button', { class: 'danger', style: 'display:none', onclick: async () => {
    for (const it of apDanger) {
      const r = await call('wallet:revokeApproval', { index: Number(apAcct.value), kind: it.kind, token: it.token, spender: it.spender });
      if (!r.ok) { apMsg.textContent = r.error; break; }
    }
    loadApprovals();
  } }, '');
  const apScan = h('button', { onclick: async () => {
    apMsg.textContent = t('Шукаю дозволи в недавніх подіях\u2026');
    const r = await call('wallet:scanApprovals', { index: Number(apAcct.value) });
    if (!r.ok) { apMsg.textContent = r.error; return; }
    await loadApprovals(t('Знайдено нових: {0}.', r.added) + (r.partial ? ' ' + t('Пошук неповний (обмеження RPC): старіші дозволи скасовуйте вручну чи через оглядач.') : ''));
  } }, 'Знайти дозволи');
  async function loadApprovals(prefix) {
    apMsg.textContent = '\u2026'; apList.textContent = ''; apBulk.style.display = 'none';
    const r = await call('wallet:approvals', { index: Number(apAcct.value) });
    if (!r.ok) { apMsg.textContent = r.error; return; }
    const net2 = info.networks.find(n => n.chainId === r.chainId);
    apDanger = r.items.filter(i => i.danger.length);
    apMsg.textContent = (prefix ? prefix + ' ' : '') + (r.items.length ? t('Діючих дозволів: {0}.', r.total) : (r.saved ? 'Діючих дозволів не знайдено.' : 'Натисніть «Знайти дозволи», щоб переглянути, хто може витрачати ваші токени.'));
    if (apDanger.length) { apBulk.style.display = ''; apBulk.textContent = t('Скасувати небезпечні ({0})', apDanger.length); }
    for (const it of r.items) {
      const who = it.label ? `${it.label} (${short(it.spender)})` : it.spender;
      apList.append(h('div', { class: 'item' },
        h('div', { class: 'main' },
          h('div', { class: 't' }, it.kind === 'nft' ? t('Усі NFT колекції {0}', short(it.token)) : `${it.symbol}${it.name ? ' \u2014 ' + it.name : ''}`),
          h('div', { class: 's pw', style: 'user-select:text' }, t('Кому: {0}', who)),
          it.danger.length ? h('div', { class: 'merr' }, '\u26A0 ' + it.danger.join('; ')) : ''),
        h('span', { class: 'note' }, it.kind === 'nft' ? '' : (it.unlimited ? t('НЕОБМЕЖЕНО') : it.amount)),
        net2 && net2.explorer ? h('a', { href: `${net2.explorer}/address/${it.token}` }, 'Оглядач') : '',
        h('button', { class: it.danger.length ? 'danger' : 'link', onclick: async () => {
          const rr = await call('wallet:revokeApproval', { index: Number(apAcct.value), kind: it.kind, token: it.token, spender: it.spender });
          if (!rr.ok) { apMsg.textContent = rr.error; return; }
          loadApprovals(t('Скасування надіслано: {0}', short(rr.hash)));
        } }, 'Скасувати')));
    }
  }
  const approvalsBox = h('div', null,
    h('p', { class: 'note' }, 'Тут видно, які адреси зараз можуть витрачати ваші токени ERC-20 чи всі NFT колекції. Небезпечні (необмежені чи для звичайного рахунку) угорі. Список складається з недавніх подій блокчейну й перевіряється за поточним станом контрактів.'),
    h('div', { class: 'bar' }, apAcct, apScan, h('button', { onclick: () => loadApprovals() }, 'Оновити'), apBulk), apMsg, apList);

  app.append(
    info.backup && !info.backup.confirmed ? h('div', { class: 'warnbox', style: 'display:flex;gap:12px;align-items:center;flex-wrap:wrap' }, h('div', { style: 'flex:1' }, 'Резервну копію не підтверджено: ви ще не перевіряли, що фразу відновлення записано. Без неї кошти не повернути, якщо пристрій втратиться.'), h('button', { class: 'primary', onclick: async () => { if (await backupQuizFlow()) render(); } }, 'Перевірити зараз')) : '',
    h('h2', null, 'Огляд'), summary,
    h('h2', null, 'Портфель'), portfolioBox,
    h('h2', null, 'Рахунки'),
    accountsAll,
    h('div', { class: 'bar', style: 'margin-top:10px' }, info.accounts.length < 10 ? h('button', { onclick: async () => { const r = await call('wallet:addAccount'); if (!r.ok) alert(r.error); render(); } }, '+ Додати рахунок') : '', h('button', { onclick: importDialog }, 'Імпортувати ключ\u2026'), h('button', { onclick: watchDialog }, 'Додати адресу для перегляду\u2026')),
    h('h2', { id: 'tokens-anchor' }, 'Токени та NFT'),
    h('div', { class: 'bar' }, tokAcct, tokChain, h('button', { onclick: () => loadTokens() }, 'Оновити')),
    tokMsg, tokList, nftMsg, nftGrid, nftMore, tokAddBar, nftAddBar,
    h('h2', null, 'Історія EVM'),
    h('div', { class: 'bar' }, evHistAcct, h('button', { onclick: loadEvmHistory }, 'Показати'), evHistCsv),
    evHistMsg, evHistList,
    h('h2', null, 'Історія Solana'),
    h('div', { class: 'bar' }, histAcct, h('button', { onclick: loadHistory }, 'Оновити')),
    histMsg, histList,
    h('h2', null, 'Децентралізоване сховище & NFT (Arweave / Irys)'),
    buildArweaveSection(info.accounts[0], net),
    h('h2', null, 'Адресна книга'),
    contactsBox,
    h('div', { class: 'bar', style: 'margin-top:10px' }, cName, cAddr, h('button', { onclick: async () => {
      cMsg.textContent = '';
      const r = await call('wallet:addContact', { name: cName.value, address: cAddr.value.trim() });
      if (!r.ok) { cMsg.textContent = r.error; return; }
      cName.value = ''; cAddr.value = ''; loadContacts();
    } }, 'Додати контакт'), cMsg),
    h('h2', null, 'Підключені сайти'),
    connected,
    h('h2', null, 'Журнал дій'),
    log,
    h('h2', null, 'Мережі та RPC'),
    h('div', { class: 'list' },
      h('div', { class: 'row' }, h('div', { style: 'flex:1' }, h('div', null, 'RPC-сервер EVM'), h('div', { class: 'd' }, 'Через нього проходять запити про баланси та транзакції. Для приватності вкажіть власний вузол (https).'), rpc, rpcMsg)),
      h('div', { class: 'row' }, h('div', { style: 'flex:1' }, h('div', null, 'RPC-сервер Solana'), h('div', { class: 'd' }, 'Для вибраної мережі Solana; порожнє поле — типові вузли. Адреси виводяться з тієї самої фрази відновлення (шлях m/44′/501′/N′/0′, як у Phantom).'), solRpc, solRpcMsg))),
    h('h2', null, 'Активні дозволи'),
    approvalsBox,
    h('h2', null, 'Безпека'),
    h('div', { class: 'list' },
      // режими обережності: ліміти, лише адресна книга, автовідключення сайтів
      h('div', { class: 'row', style: 'flex-direction:column;align-items:stretch;gap:8px' }, h('div', null, h('div', null, 'Режими обережності'), h('div', { class: 'd' }, 'Діють для переказів зі сторінки гаманця (не для транзакцій, які пропонують сайти). Зміна потребує майстер-пароля. Ліміти в USD працюють лише коли ціна відома.')),
        policyBox),
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Параметри ключів'), h('div', { class: 'd' }, `EVM: ${({ standard: "m/44'/60'/0'/0/i", ledgerLive: "m/44'/60'/i'/0/0", legacy: "m/44'/60'/0'/i" })[(info.derivation || {}).evmPath] || "m/44'/60'/0'/0/i"} · Solana: ${({ phantom: "m/44'/501'/i'/0'", bip44: "m/44'/501'/i'" })[(info.derivation || {}).solPath] || "m/44'/501'/i'/0'"} · ${(info.derivation || {}).passphrase ? t('фраза-пароль задана') : t('без фрази-пароля')}`))),
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Резервна копія фрази'), h('div', { class: 'd' }, info.backup && info.backup.confirmed ? t('Підтверджено {0}.', new Date(info.backup.at).toLocaleDateString(LOCALE)) : 'Не підтверджено.')),
        h('div', { class: 'bar' }, h('button', { onclick: async () => { if (await backupQuizFlow()) { alert(t('Готово: резервну копію підтверджено.')); render(); } } }, 'Перевірити фразу'), h('button', { onclick: backupExportDialog }, 'Зберегти зашифровану копію\u2026'))),
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Надавати провайдер сайтам (window.ethereum, window.solana)'), h('div', { class: 'd' }, 'Вимкніть, якщо не користуєтеся dApp — сайти не зможуть навіть побачити гаманець')),
        (() => { const cb = h('input', { type: 'checkbox', class: 'switch', checked: st.inject, onchange: () => call('wallet:setInject', { on: cb.checked }) }); return cb; })()),
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Повторно запитувати майстер-пароль'), h('div', { class: 'd' }, 'Скільки часу після введення пароля підтвердження транзакцій і підписів не вимагають його знову. Коротший час безпечніший; довший зручніший, якщо ви часто підтверджуєте дії.')),
        (() => { const sel = h('select', { onchange: () => call('wallet:setReauth', { minutes: Number(sel.value) }) }, [2, 5, 10, 15].map(m => h('option', { value: String(m), selected: (st.reauthMinutes || 2) === m }, t('{0} хв', m)))); return sel; })()),
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Щоразу питати, яким рахунком увійти на сайті'), h('div', { class: 'd' }, 'Під час авторизації (підключення гаманця, вхід через гаманець) браузер показує вибір рахунку навіть для сайту, який уже підключено. Вимкніть, якщо сайти запитують підключення дуже часто.')),
        (() => { const cb = h('input', { type: 'checkbox', class: 'switch', checked: st.askAccount !== false, onchange: () => call('wallet:setAskAccount', { on: cb.checked }) }); return cb; })()),
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Показувати орієнтовні ціни в USD'), h('div', { class: 'd' }, 'Ціни завантажуються з CoinGecko: сервіс бачить ваш IP та ідентифікатори монет і адреси контрактів токенів, але не адреси ваших рахунків. Ціни лише для показу й нічого не впливають на підтвердження. Вимкніть, щоб гаманець не звертався до цього сервісу.')),
        (() => { const cb = h('input', { type: 'checkbox', class: 'switch', checked: st.prices !== false, onchange: async () => { await call('wallet:setPrices', { on: cb.checked }); render(); } }); return cb; })()),
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Завантажувати картинки й метадані NFT з будь-яких сайтів'), h('div', { class: 'd' }, 'Вимкнено: лише IPFS, Arweave/Irys і дані з блокчейну (сторонні сайти не бачать вашого IP). Увімкніть, якщо ваші NFT зберігаються на звичайних сайтах: такі сайти побачать ваш IP. Завантаження виконує браузер із захистом від локальних адрес і ліміти розміру.')),
        (() => { const cb = h('input', { type: 'checkbox', class: 'switch', checked: st.nftAnyHost === true, onchange: async () => { await call('wallet:setNftAnyHost', { on: cb.checked }); render(); } }); return cb; })()),
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Скасування дозволів токенів'), h('div', { class: 'd' }, 'Відкликає право адреси витрачати ваш токен (approve 0). Корисно, якщо ви давали необмежений дозвіл сайту, якому більше не довіряєте.')), h('button', { onclick: revokeDialog }, 'Скасувати дозвіл…')),
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Показати фразу відновлення'), h('div', { class: 'd' }, 'Потрібен майстер-пароль')),
        h('button', { onclick: async () => {
          const r = await withAuth((x) => call('wallet:reveal', x));
          if (r && r.ok) showPhraseOnly(r.phrase, r.passphrase); else if (r && r.error) alert(r.error);
        } }, 'Показати')),
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Приховати гаманець'), h('div', { class: 'd' }, 'Прибирає гаманець з меню, стартової сторінки й панелі та вимикає його для сайтів. Ключі лишаються у сховищі; показати знову можна лише з майстер-паролем.')),
        h('button', { onclick: async () => { const r = await call('wallet:hide'); if (r && r.ok) render(); else if (r && r.error) alert(r.error); } }, 'Приховати')),
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Видалити гаманець'), h('div', { class: 'd' }, 'Видаляє ключі з цього пристрою. Без фрази відновлення кошти недоступні.')),
        h('button', { class: 'danger', onclick: async () => {
          const r = await withAuth((x) => call('wallet:remove', x));
          if (r && r.ok) render(); else if (r && r.error) alert(r.error);
        } }, 'Видалити'))),
    h('p', { class: 'note' }, 'Підтримуються мережі EVM (Ethereum, Polygon, Base, Arbitrum, Optimism, BNB, Avalanche та власні) і Solana. Bitcoin та апаратні гаманці (Ledger/Trezor) поки не підтримуються. Це новий, незалежно не аудитований код — для великих сум використовуйте апаратний гаманець.'));
  railNav('Розділи гаманця');
  loadContacts();
  if (sol.addresses.length) { loadTokens(); loadHistory(); }

  // ----- вікно «Надіслати» (основна валюта або токен) -----
  function sendDialog(index, preset = {}) {
    const acct = h('select', { onchange: () => loadAssets() }, optionEls(index));
    const chain = h('select', { onchange: () => loadAssets() },
      h('option', { value: 'evm', selected: preset.chain !== 'sol' }, `${net.name} (${net.symbol})`),
      h('option', { value: 'sol', selected: preset.chain === 'sol' }, `Solana ${sol.clusters.find(c => c.id === sol.cluster).name}`));
    const asset = h('select', null, h('option', { value: '' }, '…'));
    const to = h('input', { type: 'text', class: 'pw', placeholder: 'Адреса отримувача або ім\u2019я .eth / .sol', spellcheck: false, autocomplete: 'off', onchange: () => resolveEns() });
    const amount = h('input', { type: 'text', placeholder: '0.0', inputMode: 'decimal', autocomplete: 'off' });
    if (preset.nft) { amount.value = '1'; amount.disabled = preset.nft.standard !== 'erc1155'; }
    const speed = h('select', null, h('option', { value: 'standard' }, 'Стандартна'), h('option', { value: 'fast' }, 'Швидка (вища комісія)'), h('option', { value: 'low' }, 'Повільна (нижча комісія)'));
    const speedRow = h('label', { class: 'mfield' }, h('span', null, 'Швидкість комісії'), speed);
    const book = h('select', { onchange: () => { if (book.value) { to.value = book.value; book.value = ''; } } }, h('option', { value: '' }, 'Із адресної книги…'));
    const ensNote = h('div', { class: 'note' });
    const msg = h('div', { class: 'merr' });
    const ok = h('div', { class: 'note' });
    const go = h('button', { class: 'primary', onclick: submit }, 'Надіслати');
    async function resolveEns() {
      ensNote.textContent = '';
      const v = to.value.trim();
      if (!/\.(eth|sol)$/i.test(v)) return;
      ensNote.textContent = '…';
      const r = await call('wallet:resolveName', { name: v });
      if (!r.ok) { ensNote.textContent = r.error; return; }
      ensNote.textContent = t('Ім\u2019я {0} вказує на адресу {1}. Звірте її з тією, яку вам дав одержувач.', v, r.address);
      to.value = r.address;
    }
    async function loadBook() {
      const r = await call('wallet:contacts');
      if (!r.ok) return;
      book.textContent = '';
      book.append(h('option', { value: '' }, 'Із адресної книги…'));
      for (const c of r.contacts.filter(x => x.chain === chain.value)) book.append(h('option', { value: c.address }, `${c.name} (${short(c.address)})`));
    }
    const close = () => box.remove();
    let token = 0;
    async function loadAssets() {
      const my = ++token;
      const picked = acctOptions().find(o => o.id === Number(acct.value));
      if (picked && picked.chain) chain.value = picked.chain;
      chain.disabled = !!(picked && picked.chain);
      const isSol = chain.value === 'sol';
      speedRow.style.display = '';
      loadBook();
      asset.textContent = '';
      if (preset.nft) {
        chain.value = preset.nft.chain; chain.disabled = true; speedRow.style.display = '';
        asset.disabled = true;
        asset.append(h('option', { value: '' }, `NFT \u00B7 ${preset.nft.label}`));
        return;
      }
      asset.append(h('option', { value: '' }, isSol ? 'SOL' : net.symbol));
      const r = isSol ? await call('wallet:solTokens', { address: solAddrOf(Number(acct.value)) }) : await call('wallet:evmTokens', { index: Number(acct.value) });
      if (my !== token || !r.ok) return;
      const list = isSol ? r.tokens.filter(x => !x.nft).map(x => ({ id: x.mint, label: `${x.symbol || x.name || short(x.mint)} (${x.amount})` }))
        : r.tokens.filter(x => x.amount !== null && x.raw !== '0').map(x => ({ id: x.address, label: `${x.symbol} (${x.amount})` }));
      for (const a of list) asset.append(h('option', { value: a.id, selected: a.id === preset.asset }, a.label));
      if (preset.asset && chain.value === preset.chain) { asset.value = preset.asset; preset = {}; }
    }
    async function submit() {
      msg.textContent = ''; ok.textContent = '';
      go.disabled = true;
      const n = preset.nft;
      const r = n && n.chain === 'evm'
        ? await call('wallet:sendNft', { index: Number(acct.value), contract: n.contract, id: n.id, to: to.value.trim(), amount: amount.value.trim(), speed: speed.value })
        : await call('wallet:send', { chain: chain.value, asset: n ? n.mint : (asset.value || undefined), index: Number(acct.value), to: to.value.trim(), amount: amount.value.trim().replace(',', '.'), speed: speed.value });
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
        h('label', { class: 'mfield' }, h('span', null, 'Актив'), asset),
        h('label', { class: 'mfield' }, h('span', null, 'Отримувач'), to),
        book, ensNote,
        h('label', { class: 'mfield' }, h('span', null, 'Сума'), amount),
        speedRow,
        msg, ok,
        h('div', { class: 'mbtns' }, h('button', { onclick: close }, 'Скасувати'), go)));
    box.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    document.body.append(box);
    loadAssets();
    to.focus();
  }
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
