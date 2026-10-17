'use strict';
// Перевірка вбудованих RPC гаманця онлайн: кожна адреса має відповісти своїм chainId.
// Основний вузол може бути недоступним у вашій мережі (тоді працює запасний), тому помилкою вважається лише мережа,
// у якій не відповіли ВСІ вузли; недоступні окремі вузли виводяться як попередження.
// Запуск: npm run check:rpc (перед випуском; у автотестах не використовується — мережа нестабільна).
const { BUILTIN_NETWORKS } = require('../src/wallet');

async function ping(url, chainId) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    return j.result === '0x' + chainId.toString(16) ? 'OK' : 'ХИБНО: ' + JSON.stringify(j).slice(0, 100);
  } catch (e) { return 'ХИБНО: ' + e.message; }
}

(async () => {
  let bad = 0;
  for (const n of BUILTIN_NETWORKS) {
    const urls = [n.rpc, ...(n.rpcFallback || [])];
    const res = [];
    for (const u of urls) res.push(await ping(u, n.chainId));
    const alive = res.filter(r => r === 'OK').length;
    if (!alive) bad++;
    console.log(`${alive ? (alive === urls.length ? 'OK   ' : 'WARN ') : 'FAIL '} ${n.name} (${n.chainId}): ${alive}/${urls.length} вузлів`);
    urls.forEach((u, i) => { if (res[i] !== 'OK') console.log(`        ${u} ${res[i]}`); });
  }
  process.exit(bad ? 1 : 0);
})();
