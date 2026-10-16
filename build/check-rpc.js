'use strict';
// Перевірка вбудованих RPC гаманця онлайн: кожна адреса має відповісти своїм chainId.
// Запуск: npm run check:rpc (перед випуском; у автотестах не використовується — мережа нестабільна).
const { BUILTIN_NETWORKS } = require('../src/wallet');

(async () => {
  let bad = 0;
  for (const n of BUILTIN_NETWORKS) {
    let res;
    try {
      const r = await fetch(n.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      res = j.result === '0x' + n.chainId.toString(16) ? 'OK' : 'ХИБНО: ' + JSON.stringify(j).slice(0, 100);
    } catch (e) { res = 'ХИБНО: ' + e.message; }
    if (res !== 'OK') bad++;
    console.log(`${res === 'OK' ? 'OK   ' : 'FAIL '} ${n.name} (${n.chainId}) ${n.rpc} ${res === 'OK' ? '' : res}`);
  }
  process.exit(bad ? 1 : 0);
})();
