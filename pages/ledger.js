'use strict';
// Службова прихована сторінка: передає сирі 64-байтові пакети HID між головним процесом і Ledger через WebHID.
// Уся логіка протоколу — в src/ledger.js. Доступ до пристрою дозволяє лише головний процес (src/ledger-bridge.js).
const LEDGER_VENDOR = 0x2c97;
const LEDGER_USAGE_PAGE = 0xffa0;
const READ_TIMEOUT_MS = 120000; // користувач підтверджує дію кнопками на пристрої
let dev = null;
const queue = [];
const waiters = [];

const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (s) => new Uint8Array((s.match(/../g) || []).map((x) => parseInt(x, 16)));

function onReport(ev) {
  const hex = toHex(new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength));
  const w = waiters.shift();
  if (w) { clearTimeout(w.timer); w.resolve(hex); } else queue.push(hex);
}

async function openDevice() {
  if (dev && dev.opened) return dev;
  const list = await navigator.hid.getDevices();
  const d = list.find((x) => x.vendorId === LEDGER_VENDOR && x.collections.some((c) => c.usagePage === LEDGER_USAGE_PAGE));
  if (!d) throw new Error('Ledger не знайдено: підключіть пристрій, розблокуйте його й відкрийте застосунок «Ethereum».');
  if (!d.opened) await d.open();
  if (dev !== d) { d.addEventListener('inputreport', onReport); dev = d; }
  return d;
}

navigator.hid.addEventListener('disconnect', (ev) => { if (dev && ev.device === dev) dev = null; });

window.ledgerIo = {
  async reset() { queue.length = 0; while (waiters.length) { const w = waiters.shift(); clearTimeout(w.timer); w.reject(new Error('Скасовано')); } return true; },
  async write(hex) { const d = await openDevice(); await d.sendReport(0, fromHex(hex)); return true; },
  async read() {
    await openDevice();
    if (queue.length) return queue.shift();
    return new Promise((resolve, reject) => {
      const w = { resolve, reject, timer: setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); reject(new Error('Ledger не відповів: підтвердіть дію на пристрої та повторіть.')); }, READ_TIMEOUT_MS) };
      waiters.push(w);
    });
  },
};
