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
  const svg = qrSvg(r.qr);
  const box = h('div', { class: 'modal', onmousedown: (e) => { if (e.target === box) box.remove(); } },
    h('div', { class: 'mbox', style: 'text-align:center' }, h('h2', { class: 'mtitle' }, title), h('div', { style: 'display:inline-block;padding:6px;background:#fff;border-radius:10px' }, svg),
      h('div', { class: 'pw', style: 'user-select:text;word-break:break-all;margin:12px 0;font-size:12px' }, address),
      h('p', { class: 'note' }, 'Покажіть цей код відправнику. Перевірте, що адреса під кодом збігається з адресою у вашого гаманця.'),
      h('div', { class: 'mbtns' }, h('button', { class: 'primary', onclick: () => box.remove() }, 'Закрити'))));
  document.body.append(box);
}
