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
  const imp = info.imported || [];
  const impTag = (a) => (a.chain === 'sol' ? 'SOL' : 'EVM');
  // усі рахунки для вибору: похідні від фрази (EVM+Solana) та імпортовані за ключем (одна мережа)
  const acctOptions = () => [...info.accounts.map((a, i) => ({ id: i, label: nameOf(i), chain: null })), ...imp.map(a => ({ id: a.id, label: `${a.name || short(a.address)} (${impTag(a)})`, chain: a.chain }))];
  const solAddrOf = (id) => (id >= 1000 ? (imp.find(a => a.id === id && a.chain === 'sol') || {}).address : sol.addresses[id]);
  const optionEls = (selected) => acctOptions().map(o => h('option', { value: String(o.id), selected: o.id === selected }, o.label));
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
  const accountsAll = h('div', { class: 'accts' }, [...accounts.childNodes, ...impCards]);
  call('wallet:balances').then(r => {
    if (r.ok) for (const b of r.balances) if (evmBal[b.address]) evmBal[b.address].textContent = b.balance === null ? 'баланс недоступний' : `${Number(b.balance).toFixed(5)} ${b.symbol}`;
  });
  call('wallet:solBalances').then(r => {
    if (r.ok) for (const b of r.balances) if (solBal[b.address]) solBal[b.address].textContent = b.balance === null ? 'баланс недоступний' : `${Number(b.balance).toFixed(5)} ${b.symbol}`;
  });

  // ----- токени й NFT обох мереж -----
  const tokAcct = h('select', { 'aria-label': 'Рахунок', onchange: () => loadTokens() }, optionEls());
  const tokChain = h('select', { 'aria-label': 'Мережа', onchange: () => loadTokens() },
    h('option', { value: 'evm' }, net.name), h('option', { value: 'sol' }, `Solana ${sol.clusters.find(c => c.id === sol.cluster).name}`));
  const tokMsg = h('div', { class: 'note', style: 'margin:8px 0' });
  const tokList = h('div', { class: 'list' });
  const nftGrid = h('div', { class: 'nft-grid' });
  const tokAdd = h('input', { type: 'text', class: 'pw', placeholder: 'Адреса контракту токена (ERC-20)', spellcheck: false, autocomplete: 'off', style: 'flex:1' });
  const tokAddMsg = h('span', { class: 'note' });
  const tokAddBar = h('div', { class: 'bar', style: 'margin-top:10px' }, tokAdd, h('button', { onclick: async () => {
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
    const picked = acctOptions().find(o => o.id === idx);
    if (picked && picked.chain) tokChain.value = picked.chain;
    tokChain.disabled = !!(picked && picked.chain);
    const isSol = tokChain.value === 'sol';
    tokMsg.textContent = '…'; tokList.textContent = ''; nftGrid.textContent = '';
    tokList.style.display = 'none';
    tokAddBar.style.display = isSol ? 'none' : '';
    if (isSol) {
      const r = await call('wallet:solTokens', { address: solAddrOf(idx) });
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
          tokList.append(h('div', { class: 'item' }, h('div', { class: 'main' }, h('div', { class: 't' }, title + (tk.symbol ? ` (${tk.symbol})` : '')), h('div', { class: 's pw', style: 'user-select:text' }, tk.mint)),
            h('span', { class: 'note' }, tk.amount), h('button', { class: 'link', onclick: () => sendDialog(idx, { chain: 'sol', asset: tk.mint }) }, 'Надіслати'), link));
        }
      }
      return;
    }
    const r = await call('wallet:evmTokens', { index: idx });
    if (!r.ok) { tokMsg.textContent = r.error || 'Помилка'; return; }
    tokMsg.textContent = r.tokens.length ? 'Баланси читаються з контрактів. Назви токенів задає їхній творець: звіряйте адресу контракту.' : 'У цій мережі немає токенів з ненульовим балансом. Додайте токен за адресою контракту.';
    for (const tk of r.tokens) {
      tokList.style.display = '';
      const net2 = info.networks.find(n => n.chainId === r.chainId);
      tokList.append(h('div', { class: 'item' }, h('div', { class: 'main' }, h('div', { class: 't' }, `${tk.symbol}${tk.name ? ' — ' + tk.name : ''}`), h('div', { class: 's pw', style: 'user-select:text' }, tk.address)),
        h('span', { class: 'note' }, tk.amount === null ? 'баланс недоступний' : tk.amount),
        tk.amount !== null && tk.raw !== '0' ? h('button', { class: 'link', onclick: () => sendDialog(idx, { chain: 'evm', asset: tk.address }) }, 'Надіслати') : '',
        net2 && net2.explorer ? h('a', { href: `${net2.explorer}/token/${tk.address}` }, 'Оглядач') : '',
        tk.custom ? h('button', { class: 'link danger', title: 'Прибрати зі списку', onclick: async () => { await call('wallet:removeToken', { address: tk.address }); loadTokens(); } }, '✕') : ''));
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
  const histAcct = h('select', { 'aria-label': 'Рахунок', onchange: loadHistory }, [...info.accounts.map((a, i) => h('option', { value: String(i) }, nameOf(i))), ...imp.filter(a => a.chain === 'sol').map(a => h('option', { value: String(a.id) }, a.name || short(a.address)))]);

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

  app.append(
    h('h2', null, 'Огляд'), summary,
    h('h2', null, 'Рахунки'),
    accountsAll,
    h('div', { class: 'bar', style: 'margin-top:10px' }, info.accounts.length < 10 ? h('button', { onclick: async () => { const r = await call('wallet:addAccount'); if (!r.ok) alert(r.error); render(); } }, '+ Додати рахунок') : '', h('button', { onclick: importDialog }, 'Імпортувати ключ\u2026')),
    h('h2', { id: 'tokens-anchor' }, 'Токени та NFT'),
    h('div', { class: 'bar' }, tokAcct, tokChain, h('button', { onclick: () => loadTokens() }, 'Оновити')),
    tokMsg, tokList, nftGrid, tokAddBar,
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
    h('h2', null, 'Безпека'),
    h('div', { class: 'list' },
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Надавати провайдер сайтам (window.ethereum, window.solana)'), h('div', { class: 'd' }, 'Вимкніть, якщо не користуєтеся dApp — сайти не зможуть навіть побачити гаманець')),
        (() => { const cb = h('input', { type: 'checkbox', class: 'switch', checked: st.inject, onchange: () => call('wallet:setInject', { on: cb.checked }) }); return cb; })()),
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Скасування дозволів токенів'), h('div', { class: 'd' }, 'Відкликає право адреси витрачати ваш токен (approve 0). Корисно, якщо ви давали необмежений дозвіл сайту, якому більше не довіряєте.')), h('button', { onclick: revokeDialog }, 'Скасувати дозвіл…')),
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
  loadContacts();
  if (sol.addresses.length) { loadTokens(); loadHistory(); }

  // ----- вікно «Надіслати» (основна валюта або токен) -----
  function sendDialog(index, preset = {}) {
    const acct = h('select', { onchange: () => loadAssets() }, optionEls(index));
    const chain = h('select', { onchange: () => loadAssets() },
      h('option', { value: 'evm', selected: preset.chain !== 'sol' }, `${net.name} (${net.symbol})`),
      h('option', { value: 'sol', selected: preset.chain === 'sol' }, `Solana ${sol.clusters.find(c => c.id === sol.cluster).name}`));
    const asset = h('select', null, h('option', { value: '' }, '…'));
    const to = h('input', { type: 'text', class: 'pw', placeholder: 'Адреса отримувача або ім\u2019я .eth', spellcheck: false, autocomplete: 'off', onchange: () => resolveEns() });
    const amount = h('input', { type: 'text', placeholder: '0.0', inputMode: 'decimal', autocomplete: 'off' });
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
      if (!/\.eth$/i.test(v)) return;
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
      speedRow.style.display = isSol ? 'none' : '';
      loadBook();
      asset.textContent = '';
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
      const r = await call('wallet:send', { chain: chain.value, asset: asset.value || undefined, index: Number(acct.value), to: to.value.trim(), amount: amount.value.trim().replace(',', '.'), speed: speed.value });
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
