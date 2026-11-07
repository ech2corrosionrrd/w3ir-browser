'use strict';
// Історія Solana з блокчейну та наближена історія EVM (з журналів подій токенів).

function buildHistory(ctx) {
  const { info, nameOf, imp, watch, viewOptions, solAddrOf } = ctx;
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
    solHistCsv.hidden = !r.items.length;
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
  const solHistCsv = h('button', { hidden: true, onclick: async () => {
    const r = await call('wallet:solHistoryCsv', { address: solAddrOf(Number(histAcct.value)) });
    histMsg.textContent = r.ok ? t('Збережено: {0}', r.path) : (r.error || 'Помилка');
  } }, 'Зберегти CSV');
  const evHistAcct = h('select', { 'aria-label': 'Рахунок', onchange: loadEvmHistory }, viewOptions().filter(o => o.chain !== 'sol').map(o => h('option', { value: String(o.id) }, o.label)));
  const histAcct = h('select', { 'aria-label': 'Рахунок', onchange: loadHistory }, [...info.accounts.map((a, i) => h('option', { value: String(i) }, nameOf(i))), ...imp.filter(a => a.chain === 'sol').map(a => h('option', { value: String(a.id) }, a.name || short(a.address))), ...watch.filter(a => a.chain === 'sol').map(a => h('option', { value: String(a.id) }, `${a.name || short(a.address)} (${t('перегляд')})`))]);
  return { evHistAcct, evHistCsv, evHistMsg, evHistList, histAcct, solHistCsv, histMsg, histList, loadEvmHistory, loadHistory };
}
