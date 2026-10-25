'use strict';
// Перевірка RPC-вузлів перед запитом: ім'я хоста не повинно вказувати на приватну, локальну чи службову адресу.
// isSafeRpc (wallet-evm-core.js) перевіряє схему, логін в адресі й IP-літерали, а тут додається резолв імені (для зовнішніх вузлів).
// Локальні вузли розробки (localhost, 127.0.0.1) і IP-літерали пропускаються: їх вирішує isSafeRpc.
// Якщо ім'я не вдалося розв'язати, вердикту немає: запит однаково не дійде до вузла.
const dns = require('dns');
const { FetchRequest } = require('ethers');
const { isPublicIp } = require('./safe-fetch');

const TTL_MS = 30000;
const MAX_CACHE = 200;
const okUntil = new Map();

async function assertPublicRpc(url, resolver = (h) => dns.promises.lookup(h, { all: true }), now = Date.now()) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { throw new Error('invalid RPC address'); }
  if (host === 'localhost' || host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return;
  if ((okUntil.get(host) || 0) > now) return;
  let list;
  try { list = await resolver(host); } catch { return; }
  const addrs = Array.isArray(list) ? list : [list];
  if (!addrs.length || addrs.some(x => !isPublicIp(x && x.address))) {
    const e = new Error('RPC host resolves to a non-public address');
    e.code = 'ENOTPUBLIC';
    throw e;
  }
  if (okUntil.size >= MAX_CACHE) okUntil.clear();
  okUntil.set(host, now + TTL_MS);
}

// Запит ethers, який перед кожним з'єднанням перевіряє адресу (guard — async (url) => void, кидає помилку, якщо вузол заборонений)
function guardedRequest(url, guard) {
  const req = new FetchRequest(url);
  req.preflightFunc = async (r) => { await guard(r.url); return r; };
  return req;
}

module.exports = { assertPublicRpc, guardedRequest };
