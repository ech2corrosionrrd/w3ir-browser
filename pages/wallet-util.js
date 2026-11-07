'use strict';
// Спільні помічники сторінки гаманця: виклик IPC, короткі адреси, ціни в USD, посилання оглядача, QR-код.

const call = (name, arg) => w3ir.invoke(name, arg);
const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);

const impTag = (a) => (a.chain === 'sol' ? 'SOL' : 'EVM');

const usdFmt = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });
const usdOf = (amount, price) => (price && Number.isFinite(Number(amount)) ? usdFmt.format(Number(amount) * price) : '');

const solExplorer = (a, cluster) => `https://explorer.solana.com/address/${a}` + (cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`);
const copy = (text, btn) => {
  navigator.clipboard.writeText(text).catch(() => {});
  const old = btn.textContent;
  btn.textContent = t('Скопійовано');
  setTimeout(() => { btn.textContent = old; }, 1200);
};

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
