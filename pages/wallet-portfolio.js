'use strict';
// Портфель по всіх мережах (за запитом).

function buildPortfolio() {
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
  return portfolioBox;
}
