'use strict';
// Вікно «Надіслати» (основна валюта, токен або NFT). Повертає функцію sendDialog(index, preset).

function makeSendDialog(ctx) {
  const { net, sol, acctOptions, optionEls, solAddrOf } = ctx;
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
  return sendDialog;
}
