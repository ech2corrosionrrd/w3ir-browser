'use strict';
// Unit-тести запасних вузлів RPC (src/rpc-failover.js): хеджування читання, відмови, відправлення без дублювання. Локальні http-сервери, без мережі.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { Network } = require('ethers');
const { FailoverProvider } = require(path.join(__dirname, '..', '..', 'src', 'rpc-failover.js'));

// вузол: delay — затримка відповіді, fault — помилка вузла (-32005), hits — лічильник за методами
function node({ delay = 0, fault = false, balance = '0x1' } = {}) {
  const hits = {};
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const one = (j) => {
        hits[j.method] = (hits[j.method] || 0) + 1;
        if (fault) return { jsonrpc: '2.0', id: j.id, error: { code: -32005, message: 'rate limit exceeded' } };
        if (j.method === 'eth_chainId') return { jsonrpc: '2.0', id: j.id, result: '0x1' };
        if (j.method === 'eth_getBalance') return { jsonrpc: '2.0', id: j.id, result: balance };
        if (j.method === 'eth_sendRawTransaction') return { jsonrpc: '2.0', id: j.id, result: '0x' + 'ab'.repeat(32) };
        return { jsonrpc: '2.0', id: j.id, result: '0x0' };
      };
      const j = JSON.parse(body);
      setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(Array.isArray(j) ? j.map(one) : one(j))); }, delay);
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}`, hits, close: () => srv.close() })));
}
const addr = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const mk = (urls, opts) => new FailoverProvider(urls, Network.from(1), opts);

test('rpc-failover: повільний перший вузол — відповідь від другого за ≈hedge, а не за повний тайм-аут', async () => {
  const slow = await node({ delay: 3000 }), fast = await node({ balance: '0x2a' });
  const p = mk([slow.url, fast.url], { timeout: 4000, hedgeMs: 200 });
  const t0 = Date.now();
  const bal = await p.getBalance(addr);
  const ms = Date.now() - t0;
  assert.equal(bal, 42n);
  assert.ok(ms < 1500, `відповідь за ${ms} мс`);
  assert.equal(p.activeUrl, fast.url, 'швидкий вузол став першим');
  slow.close(); fast.close(); p.destroy();
});

test('rpc-failover: швидкий перший вузол — другий не чіпається', async () => {
  const a = await node({ balance: '0x5' }), b = await node();
  const p = mk([a.url, b.url], { hedgeMs: 300 });
  assert.equal(await p.getBalance(addr), 5n);
  await new Promise(r => setTimeout(r, 450));
  assert.equal(b.hits.eth_getBalance || 0, 0, 'другий вузол не отримав запиту');
  a.close(); b.close(); p.destroy();
});

test('rpc-failover: помилка вузла (ліміт) — одразу наступний вузол, без очікування hedge', async () => {
  const bad = await node({ fault: true }), good = await node({ balance: '0x9' });
  const p = mk([bad.url, good.url], { hedgeMs: 5000 });
  const t0 = Date.now();
  assert.equal(await p.getBalance(addr), 9n);
  assert.ok(Date.now() - t0 < 1500, 'не чекали 5 с');
  bad.close(); good.close(); p.destroy();
});

test('rpc-failover: усі вузли відмовили — повертається помилка вузла, а не зависання', async () => {
  const a = await node({ fault: true }), b = await node({ fault: true });
  const p = mk([a.url, b.url], { hedgeMs: 100 });
  await assert.rejects(p.getBalance(addr), /rate limit|usage|RPC|error/i);
  a.close(); b.close(); p.destroy();
});

test('rpc-failover: відправлення транзакції не дублюється на другий вузол, поки перший відповідає', async () => {
  const a = await node({ delay: 400 }), b = await node();
  const p = mk([a.url, b.url], { hedgeMs: 100, timeout: 3000 });
  const r = await p._send({ id: 1, jsonrpc: '2.0', method: 'eth_sendRawTransaction', params: ['0x01'] });
  assert.equal(r[0].result, '0x' + 'ab'.repeat(32));
  assert.equal(b.hits.eth_sendRawTransaction || 0, 0, 'транзакція пішла лише на перший вузол');
  a.close(); b.close(); p.destroy();
});
