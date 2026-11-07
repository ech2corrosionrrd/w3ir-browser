'use strict';
// Сторінка гаманця: вибір екрана, збирання панелі. Розділи лежать у wallet-*.js (див. порядок у wallet.html).

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

// Спільний стан панелі: дані гаманця й помічники вибору рахунків. Вікно «Надіслати» й перехід до токенів додаються після збирання.
function makeWalletCtx(st) {
  const info = st.info;
  const sol = info.sol;
  const net = info.networks.find(n => n.chainId === info.activeChain) || info.networks[0];
  const nameOf = (i) => info.names[i] || `Рахунок ${i + 1}`;
  const imp = info.imported || [];
  const watch = info.watch || []; // рахунки лише для перегляду (без ключа)
  // усі рахунки для вибору: похідні від фрази (EVM+Solana) та імпортовані за ключем (одна мережа)
  const acctOptions = () => [...info.accounts.map((a, i) => ({ id: i, label: nameOf(i), chain: null })), ...imp.map(a => ({ id: a.id, label: `${a.name || short(a.address)} (${impTag(a)})`, chain: a.chain }))];
  // рахунки для ПЕРЕГЛЯДУ (токени, NFT, історія): власні й лише для перегляду; для переказів використовується acctOptions
  const viewOptions = () => [...acctOptions(), ...watch.map(a => ({ id: a.id, label: `${a.name || short(a.address)} (${impTag(a)} \u00B7 ${t('перегляд')})`, chain: a.chain }))];
  const solAddrOf = (id) => (id >= 5000 ? (watch.find(a => a.id === id && a.chain === 'sol') || {}).address : (id >= 1000 ? (imp.find(a => a.id === id && a.chain === 'sol') || {}).address : sol.addresses[id]));
  const optionEls = (selected) => acctOptions().map(o => h('option', { value: String(o.id), selected: o.id === selected }, o.label));
  const viewEls = (selected) => viewOptions().map(o => h('option', { value: String(o.id), selected: o.id === selected }, o.label));
  const evmOpts = () => acctOptions().filter(o => o.chain !== 'sol');
  const solOpts = () => acctOptions().filter(o => o.chain !== 'evm');
  return { st, info, sol, net, nameOf, imp, watch, acctOptions, viewOptions, solAddrOf, optionEls, viewEls, evmOpts, solOpts };
}

function buildTabs(secBadge) {
  const tabDefs = [
    { id: 'sec-accounts', label: 'Рахунки', icon: '💎' },
    { id: 'sec-portfolio', label: 'Портфель', icon: '📊' },
    { id: 'sec-history', label: 'Історія', icon: '⏱' },
    { id: 'sec-security', label: 'Безпека', icon: '🛡', badge: secBadge },
    { id: 'sec-arweave', label: 'Arweave', icon: '⚡' }
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
    }, h('span', null, td.icon), h('span', null, td.label), td.badge || '');
    tabBtns[td.id] = btn;
    return btn;
  }));

  window.syncActiveTab = (headId) => {
    if (tabBtns[headId]) activateTab(headId);
  };
  return { tabsBar, activateTab };
}

async function renderDashboard(st) {
  const ctx = makeWalletCtx(st);
  const { info, sol, net, solAddrOf, acctOptions } = ctx;
  ctx.sendDialog = makeSendDialog(ctx);
  const summary = buildSummary(ctx);
  const accountsAll = buildAccounts(ctx);
  const { tokAcct, tokChain, tokFilterBar, tokMsg, tokList, nftMsg, nftGrid, nftMore, tokAddBar, nftAddBar, loadTokens, gotoTokens } = buildTokens(ctx);
  ctx.gotoTokens = gotoTokens;
  const { evHistAcct, evHistCsv, evHistMsg, evHistList, histAcct, solHistCsv, histMsg, histList, loadEvmHistory, loadHistory } = buildHistory(ctx);
  const connected = buildConnected(ctx);
  const log = buildLog(ctx);
  const { contactsBox, cName, cAddr, cMsg, loadContacts } = buildContacts();
  const portfolioBox = buildPortfolio();
  const policyBox = buildPolicy(info);
  const { approvalsBox, secBadge } = buildApprovals(ctx);
  const { tabsBar, activateTab } = buildTabs(secBadge);

  app.append(
    info.backup && !info.backup.confirmed ? h('div', { class: 'warnbox', style: 'display:flex;gap:12px;align-items:center;flex-wrap:wrap' }, h('div', { style: 'flex:1' }, 'Резервну копію не підтверджено: ви ще не перевіряли, що фразу відновлення записано. Без неї кошти не повернути, якщо пристрій втратиться.'), h('button', { class: 'primary', onclick: async () => { if (await backupQuizFlow()) render(); } }, 'Перевірити зараз')) : '',
    h('h2', null, 'Огляд'), summary,
    tabsBar,
    h('h2', { id: 'sec-accounts' }, 'Рахунки'),
    accountsAll,
    h('div', { class: 'bar', style: 'margin-top:10px' }, info.accounts.length < 10 ? h('button', { onclick: async () => { const r = await call('wallet:addAccount'); if (!r.ok) alert(r.error); render(); } }, '+ Додати рахунок') : '', h('button', { onclick: importDialog }, 'Імпортувати ключ\u2026'), h('button', { onclick: ledgerDialog }, 'Підключити Ledger\u2026'), h('button', { onclick: watchDialog }, 'Додати адресу для перегляду\u2026')),
    h('h2', { id: 'tokens-anchor' }, 'Токени та NFT'),
    h('div', { class: 'bar' }, tokAcct, tokChain, h('button', { onclick: () => loadTokens() }, 'Оновити')),
    tokFilterBar, tokMsg, tokList, nftMsg, nftGrid, nftMore, tokAddBar, nftAddBar,
    h('h2', { id: 'sec-portfolio' }, 'Портфель'), portfolioBox,
    h('h2', { id: 'sec-history' }, 'Історія EVM'),
    h('div', { class: 'bar' }, evHistAcct, h('button', { onclick: loadEvmHistory }, 'Показати'), evHistCsv),
    evHistMsg, evHistList,
    h('h2', null, 'Історія Solana'),
    h('div', { class: 'bar' }, histAcct, h('button', { onclick: loadHistory }, 'Оновити'), solHistCsv),
    histMsg, histList,
    h('h2', { id: 'sec-sol-staking' }, 'Стейкінг Solana'),
    buildSolStakingSection(st, sol, net, solAddrOf, acctOptions),
    h('h2', { id: 'sec-arweave' }, 'Децентралізоване сховище & NFT (Arweave / Irys)'),
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
    buildRpc(ctx),
    h('h2', null, 'Активні дозволи'),
    approvalsBox,
    h('h2', { id: 'sec-security' }, 'Безпека'),
    buildSecuritySettings(ctx, policyBox),
    h('p', { class: 'note' }, 'Підтримуються мережі EVM (Ethereum, Polygon, Base, Arbitrum, Optimism, BNB, Avalanche та власні) і Solana. Bitcoin та апаратні гаманці (Ledger/Trezor) поки не підтримуються. Це новий, незалежно не аудитований код — для великих сум використовуйте апаратний гаманець.'));
  railNav('Розділи гаманця');
  if (location.hash && location.hash.length > 1) {
    const targetId = location.hash.slice(1);
    const targetEl = document.getElementById(targetId);
    if (targetEl) {
      activateTab(targetId);
      setTimeout(() => targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' }), 40);
    }
  }
  loadContacts();
  if (sol.addresses.length) { loadTokens(); loadHistory(); }
}

render();
setInterval(async () => { const st = await call('wallet:status'); if (st.vault !== 'unlocked' && document.querySelector('.list')) render(); }, 5000);
