'use strict';
// Підключені сайти, журнал дій і адресна книга.

function buildConnected(ctx) {
  const { info, sol, imp, evmOpts, solOpts } = ctx;
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
  return connected;
}

function buildLog(ctx) {
  const { info } = ctx;
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
  return log;
}

function buildContacts() {
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
  return { contactsBox, cName, cAddr, cMsg, loadContacts };
}
