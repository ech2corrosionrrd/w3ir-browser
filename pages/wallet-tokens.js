'use strict';
// Токени та NFT (EVM і Solana): список, галерея з лінивим завантаженням метаданих, додавання й пошук.

function buildTokens(ctx) {
  const { info, sol, net, viewOptions, viewEls, solAddrOf } = ctx;
  const sendDialog = (...a) => ctx.sendDialog(...a);
  // ----- токени й NFT обох мереж -----
  const tokAcct = h('select', { 'aria-label': 'Рахунок', onchange: () => loadTokens() }, viewEls());
  const tokChain = h('select', { 'aria-label': 'Мережа', onchange: () => loadTokens() },
    h('option', { value: 'evm' }, net.name), h('option', { value: 'sol' }, `Solana ${sol.clusters.find(c => c.id === sol.cluster).name}`));
  const tokSearch = h('input', { type: 'text', class: 'wfilter-input', placeholder: 'ERC-20, SPL, Mint, Symbol…', spellcheck: false, autocomplete: 'off' });
  const tokMsg = h('div', { class: 'note', style: 'margin:8px 0' });
  const tokList = h('div', { class: 'list' });
  tokSearch.addEventListener('input', () => {
    const q = tokSearch.value.trim().toLowerCase();
    for (const it of tokList.children) {
      if (!it.classList || !it.classList.contains('item')) continue;
      it.style.display = it.textContent.toLowerCase().includes(q) ? '' : 'none';
    }
  });
  const tokFilterBar = h('div', { class: 'wfilter-bar', style: 'display:none' }, tokSearch);
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
    const rowFor = (tk) => {
      const btn = h('button', { onclick: async () => {
        btn.disabled = true;
        const a = await call('wallet:addToken', { address: tk.address });
        if (a.ok) { btn.textContent = t('Додано'); loadTokens(); } else { btn.disabled = false; alert(a.error); }
      } }, 'Додати');
      return h('div', { class: 'row' }, h('div', null, h('div', null, `${tk.symbol}${tk.name ? ' — ' + tk.name : ''}`, tk.suspicious ? h('span', { class: 'note' }, ' ⚠ ' + t('схоже на розсилку')) : ''),
        h('div', { class: 'd' }, `${tk.amount} · ${tk.address}`)), btn);
    };
    const list = h('div', { class: 'list' }, r.tokens.filter(tk => !tk.suspicious).map(rowFor));
    const spamTokens = r.tokens.filter(tk => tk.suspicious);
    const spamList = spamTokens.length ? h('details', { class: 'spam-box' }, h('summary', null, t('Схожі на розсилку: {0}', spamTokens.length)), h('div', { class: 'list' }, spamTokens.map(rowFor))) : null;
    box.append(h('div', { class: 'mbox' }, h('h2', { class: 'mtitle' }, 'Знайдені токени'),
      h('p', { class: 'note' }, 'Токени з недавніх переказів на цей рахунок. Додавайте лише ті, які впізнаєте: шахраї надсилають токени-приманки.'), list,
      ...(spamList ? [spamList] : []),
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
    tokSearch.value = ''; tokFilterBar.style.display = 'none';
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
      if (tokList.querySelectorAll('.item').length >= 3) tokFilterBar.style.display = 'flex';
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
    if (tokList.querySelectorAll('.item').length >= 3) tokFilterBar.style.display = 'flex';
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
  const gotoTokens = (id) => {
    tokAcct.value = String(id);
    loadTokens(id);
    const anchor = document.getElementById('tokens-anchor');
    if (anchor) anchor.scrollIntoView({ behavior: 'smooth' });
  };
  return { tokAcct, tokChain, tokFilterBar, tokMsg, tokList, nftMsg, nftGrid, nftMore, tokAddBar, nftAddBar, loadTokens, gotoTokens };
}
