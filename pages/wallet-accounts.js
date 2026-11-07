'use strict';
// Огляд (мережі, швидкі кнопки) і список рахунків із балансами.

function buildSummary(ctx) {
  const { info, sol, nameOf, evmOpts, solOpts } = ctx;
  const sendDialog = (...a) => ctx.sendDialog(...a);
  // ----- огляд: стан сховища і мережі -----
  const evmSel = h('select', { 'aria-label': 'EVM-мережа', onchange: async () => { await call('wallet:setChain', { id: Number(evmSel.value) }); render(); } },
    info.networks.map(n => h('option', { value: n.chainId, selected: n.chainId === info.activeChain }, n.name + (n.builtin ? '' : ' (власна)'))));
  const solSel = h('select', { 'aria-label': 'Мережа Solana', onchange: async () => { await call('wallet:solSetCluster', { id: solSel.value }); render(); } },
    sol.clusters.map(c => h('option', { value: c.id, selected: c.id === sol.cluster }, c.name)));
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
  return summary;
}

function buildAccounts(ctx) {
  const { info, sol, net, nameOf, imp, watch } = ctx;
  const sendDialog = (...a) => ctx.sendDialog(...a);
  const gotoTokens = (...a) => ctx.gotoTokens(...a);
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
          h('button', { onclick: () => gotoTokens(i) }, 'Токени та NFT'))),
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
          h('button', { onclick: () => gotoTokens(a.id) }, 'Токени та NFT'))),
      h('div', { class: 'chain' }, h('span', { class: 'tag' + (a.chain === 'sol' ? ' sol' : '') }, impTag(a)), h('code', null, a.address), bal, cp,
        h('button', { class: 'link', onclick: () => showQr(a.name || impTag(a), a.address) }, 'QR'),
        h('a', { href: a.chain === 'sol' ? solExplorer(a.address, sol.cluster) : (net.explorer ? `${net.explorer}/address/${a.address}` : '#') }, 'Оглядач')),
      h('div', { class: 'chain' }, h('span', { class: 'note' }, a.hw ? t('Ledger ({0}): ключ лишається на пристрої, кожен підпис підтверджується на ньому. Експериментально.', a.path) : 'Імпортовано за приватним ключем: не відновлюється з фрази гаманця й недоступний сайтам (dApp).'),
        a.hw ? null : h('button', { class: 'link', onclick: async () => { const r = await withAuth((x) => call('wallet:revealKey', { id: a.id, ...x })); if (r && r.ok) showSecret(r.key); else if (r && r.error) alert(r.error); } }, 'Показати ключ'),
        h('button', { class: 'link danger', onclick: async () => { const r = await withAuth((x) => call('wallet:removeImported', { id: a.id, ...x })); if (r && r.ok) render(); else if (r && r.error) alert(r.error); } }, 'Видалити')));
  });
  const watchCards = watch.map((a) => {
    const bal = h('span', { class: 'bal' }, '\u2026');
    (a.chain === 'sol' ? solBal : evmBal)[a.address] = bal;
    const cp = h('button', { class: 'link', onclick: () => copy(a.address, cp) }, 'Копіювати');
    return h('div', { class: 'acct' },
      h('div', { class: 'ahead' }, h('span', { class: 'avatar imp' }, '\u{1F441}'),
        h('div', { class: 'aname' }, a.name || short(a.address), h('button', { class: 'link', title: 'Перейменувати', onclick: () => rename(a.id) }, '\u270E')),
        h('div', { class: 'aact' }, h('button', { onclick: () => gotoTokens(a.id) }, 'Токени та NFT'))),
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
  return accountsAll;
}
