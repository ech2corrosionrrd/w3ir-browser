'use strict';
// Джерела метаданих NFT: захищене завантаження з довільних https (SSRF), підказка ?ext= від Irys, галерея NFT Solana (сторінки, ліниві метадані).
const { EventEmitter } = require('events');
const { ok } = require('../lib');

class RpcErr extends Error { constructor(code, msg) { super(msg); this.code = code; } }

// Підставний https.get: відповіді за адресою; запис викликів
function fakeRequest(routes, calls) {
  return (url, options, cb) => {
    calls.push(String(url));
    const req = new EventEmitter();
    req.destroy = (e) => { if (e) setImmediate(() => req.emit('error', e)); };
    setImmediate(() => {
      const r = routes[String(url)];
      if (!r) return req.emit('error', new Error('ECONNREFUSED'));
      const res = new EventEmitter();
      res.statusCode = r.status || 200;
      res.headers = { 'content-type': r.type || 'image/png', ...(r.location ? { location: r.location } : {}), ...(r.len !== undefined ? { 'content-length': String(r.len) } : {}) };
      res.resume = () => {};
      res.destroy = () => {};
      cb(res);
      if (r.body !== undefined) setImmediate(() => { res.emit('data', Buffer.from(r.body)); res.emit('end'); });
    });
    return req;
  };
}

async function nftSourcesTests() {
  const { isPublicIp, safeLookup, checkUrl, fetchPublic } = require('../../src/safe-fetch');
  const meta = require('../../src/nft-meta');

  // --- адреси: лише публічні ---
  const priv = ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '', 'не адреса', '999.1.1.1'];
  ok(priv.every(a => !isPublicIp(a)), 'safe-fetch: приватні, локальні, службові й некоректні адреси (IPv4, IPv6, відображені) не вважаються публічними');
  ok(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'].every(isPublicIp), 'safe-fetch: справжні публічні адреси проходять');
  const lookupWith = (list, opts = {}) => new Promise((res) => safeLookup('x.example', opts, (e, a, f) => res({ e, a, f }), (h, o, cb) => cb(null, list)));
  const l1 = await lookupWith([{ address: '8.8.8.8', family: 4 }]);
  const l2 = await lookupWith([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]);
  const l3 = await lookupWith([{ address: '8.8.8.8', family: 4 }], { all: true });
  ok(l1.a === '8.8.8.8' && l1.f === 4 && l2.e && l2.e.code === 'ENOTPUBLIC' && Array.isArray(l3.a), 'safe-fetch: lookup відхиляє ім’я, що вказує хоч на одну непублічну адресу (захист від підміни DNS), і підтримує режим all');
  const bad = ['http://example.com/a', 'https://user:pw@example.com/a', 'https://example.com:8443/a', 'https://127.0.0.1/a', 'https://[::1]/a', 'https://8.8.8.8/a', 'https://localhost/a', 'https://a.localhost/a', 'https://printer.local/a', 'https://db.internal/a', 'file:///C:/x', 'javascript:alert(1)', 'не адреса'];
  const checks = bad.map(u => { try { checkUrl(u); return true; } catch { return false; } });
  ok(checks.every(c => c === false) && checkUrl('https://example.com/a.png').hostname === 'example.com' && checkUrl('https://example.com:443/a').port === '', 'safe-fetch: лише https, порт 443, без облікових даних, IP-адрес і локальних імен');

  // --- завантаження: перенаправлення, ліміти ---
  const calls = [];
  const routes = {
    'https://cdn.example/a.png': { body: 'PNGDATA', type: 'image/png' },
    'https://gw.example/img': { status: 302, location: 'https://cdn.example/a.png' },
    'https://gw.example/rel': { status: 301, location: '/img' },
    'https://gw.example/evil': { status: 302, location: 'http://169.254.169.254/latest' },
    'https://gw.example/loop': { status: 302, location: 'https://gw.example/loop' },
    'https://gw.example/big': { body: 'x'.repeat(2000), len: 2000 },
    'https://gw.example/nolen': { body: 'x'.repeat(2000) },
    'https://gw.example/404': { status: 404, body: '' },
  };
  const deps = { request: fakeRequest(routes, calls), lookup: () => {} };
  const fp = (u, o) => fetchPublic(u, { max: 1000, timeout: 500, ...o }, deps).then(r => ({ ok: true, r }), e => ({ ok: false, m: e.message }));
  const f1 = await fp('https://gw.example/img');
  ok(f1.ok && f1.r.buf.toString() === 'PNGDATA' && f1.r.type === 'image/png' && calls.includes('https://cdn.example/a.png'), 'safe-fetch: перенаправлення шлюзу на CDN (як у Irys) виконується');
  ok((await fp('https://gw.example/rel')).ok, 'safe-fetch: відносне перенаправлення обробляється');
  const f3 = await fp('https://gw.example/evil');
  ok(!f3.ok && !calls.some(u => u.includes('169.254')), 'safe-fetch: перенаправлення на http або локальну адресу відхиляється без запиту');
  ok(/too many redirects/.test((await fp('https://gw.example/loop')).m), 'safe-fetch: петля перенаправлень обривається після 3 кроків');
  ok(/too large/.test((await fp('https://gw.example/big')).m) && /too large/.test((await fp('https://gw.example/nolen')).m), 'safe-fetch: ліміт розміру діє і за Content-Length, і за фактичним обсягом');
  ok(/HTTP 404/.test((await fp('https://gw.example/404')).m) && !(await fp('https://unknown.example/x')).ok, 'safe-fetch: помилки HTTP і мережі повертаються як помилки');

  // --- підказка ?ext= та довільний https лише за налаштуванням ---
  const tx = 'w6yRWA20UgNKa-dSa-KpFKUD79mFNNS_rVxG1nXzedI';
  ok(meta.resolveUri(`https://gateway.irys.xyz/${tx}?ext=png`).urls[0] === `https://arweave.net/${tx}` || meta.resolveUri(`https://gateway.irys.xyz/${tx}?ext=png`).urls.includes(`https://gateway.irys.xyz/${tx}`), 'nft-meta: адреса зображення Irys із ?ext=png приймається');
  ok(meta.resolveUri(`https://gateway.irys.xyz/${tx}?x=1`) === null && meta.resolveUri(`https://gateway.irys.xyz/${tx}?ext=png&a=b`) === null, 'nft-meta: інші параметри запиту відхиляються');
  ok(meta.resolveUri('https://example.com/meta.json') === null && meta.resolveUri('https://example.com/meta.json', { allowHttps: false }) === null && meta.resolveUri('https://example.com/meta.json', { allowHttps: true }).https === 'https://example.com/meta.json', 'nft-meta: довільний https дозволений лише з налаштуванням allowHttps');
  ok(meta.resolveUri('http://example.com/a', { allowHttps: true }) === null && meta.resolveUri('file:///x', { allowHttps: true }) === null && meta.resolveUri('javascript:1', { allowHttps: true }) === null, 'nft-meta: навіть із allowHttps не-https відхиляється');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  let seen = '';
  const injected = async (u) => { seen = u; return { buf: png, type: 'image/png' }; };
  const img1 = await meta.loadImage('https://example.com/a.png', { allowHttps: true, fetchPublic: injected });
  const img2 = await meta.loadImage('https://example.com/a.png', { allowHttps: false, fetchPublic: async () => { seen = 'НЕ МАЛО БУТИ'; return { buf: png, type: 'image/png' }; } });
  ok(img1.startsWith('data:image/png;base64,') && seen === 'https://example.com/a.png' && img2 === '' && seen !== 'НЕ МАЛО БУТИ', 'nft-meta: довільний https завантажується захищеним шляхом лише за дозволом; без дозволу запиту немає');

  // --- галерея NFT Solana ---
  const S = require('../../src/solana');
  const helpers = { RpcError: RpcErr, isSafeRpc: () => true, clip: (x, n) => String(x).slice(0, n), unauthorized: (m) => new Error(m) };
  class FakeWallet {}
  require('../../src/wallet-solana').install(FakeWallet, helpers);
  const w = new FakeWallet();
  const mints = Array.from({ length: 30 }, (_, i) => S.deriveAccount(Buffer.alloc(64, i + 1), 0).address).sort();
  const coin = S.deriveAccount(Buffer.alloc(64, 99), 0).address;
  const balances = new Map(mints.map(m => [m, { mint: m, raw: 1n, decimals: 0, program: 'SPL Token' }]));
  balances.set(coin, { mint: coin, raw: 5_000_000n, decimals: 6, program: 'SPL Token' });
  balances.set('MultiSupply11111111111111111111111111111111', { mint: 'MultiSupply11111111111111111111111111111111', raw: 2n, decimals: 0, program: 'SPL Token' });
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>';
  const dataJson = (o) => 'data:application/json;base64,' + Buffer.from(JSON.stringify(o)).toString('base64');
  const uriOf = (m, i) => (i % 5 === 0 ? 'https://example.com/' + m + '.json' : (i % 5 === 1 ? '' : dataJson({ name: 'Cat ' + i + '\u202E', image: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64') })));
  w.isViewSol = () => true;
  w.solCluster = () => 'mainnet-beta';
  w.ctx = { cfg: () => ({ walletNftAnyHost: false }) };
  w._solBalancesByMint = async () => balances;
  w._solMetadata = async (cluster, list) => new Map(list.map(m => [m, { name: 'NFT ' + mints.indexOf(m), symbol: 'GFAM', uri: uriOf(m, mints.indexOf(m)) }]));
  const p1 = await w.solNfts('addr', { offset: 0, limit: 24 });
  const p2 = await w.solNfts('addr', { offset: 24, limit: 24 });
  ok(p1.total === 30 && p1.items.length === 24 && p2.items.length === 6 && p1.items[0].mint === mints[0] && p2.items[0].mint === mints[24] && !p1.items.some(i => i.mint === coin), 'sol-nft: галерея розбита на сторінки по 24, відсортована, звичайні токени й токени з кількома одиницями не входять');
  ok(p1.items[0].hasUri === true && p1.items[1].hasUri === false && p1.items[0].name === 'NFT 0', 'sol-nft: ознака наявності адреси метаданих і назва з ланцюга');
  ok((await w.solNfts('addr', { offset: -5, limit: 9999 })).limit === 48 && (await w.solNfts('addr', { offset: 'x', limit: 0 })).offset === 0, 'sol-nft: зміщення й розмір сторінки обмежуються');
  w.isViewSol = () => false;
  const foreign = await w.solNfts('x').then(() => 'ok', e => e.message);
  w.isViewSol = () => true;
  ok(/Невідомий рахунок/.test(foreign), 'sol-nft: чужу адресу гаманець не опитує');
  const m2 = await w.solNftMeta('addr', mints[2]);
  ok(m2.status === 'ok' && m2.name === 'Cat 2' && /^data:image\/svg\+xml;base64,/.test(m2.image), 'sol-nft: метадані з ончейн-даних — назва очищена, зображення як data:-URL');
  const m0 = await w.solNftMeta('addr', mints[0]);
  ok(m0.status === 'external' && m0.image === '' && m0.name === '', 'sol-nft: метадані на довільному https без дозволу не завантажуються (статус external)');
  const noUri = await w.solNftMeta('addr', mints[1]).then(() => 'ok', e => e.message);
  const unknownMint = await w.solNftMeta('addr', 'Zzz1111111111111111111111111111111111111111').then(() => 'ok', e => e.message);
  ok(/Спершу відкрийте список/.test(noUri) && /Спершу відкрийте список/.test(unknownMint), 'sol-nft: адресу метаданих беремо лише зі списку, який гаманець прочитав сам, — не від сторінки');
  const cached = await w.solNftMeta('addr', mints[2]);
  ok(cached === m2, 'sol-nft: повторний запит метаданих береться з кешу');

  // --- запасні вузли EVM: відмова вузла (JSON-RPC «Internal error») → наступний; revert — результат, а не відмова ---
  const http = require('http');
  const E = require('ethers');
  const { FailoverProvider } = require('../../src/rpc-failover');
  const hits = { bad: 0, good: 0, rev: 0 };
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', d => { b += d; });
    req.on('end', () => {
      const j = JSON.parse(b); const node = req.url.slice(1); hits[node]++;
      res.setHeader('content-type', 'application/json');
      const out = (o) => res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, ...o }));
      if (j.method === 'eth_chainId') return out({ result: '0x1' });
      if (node === 'bad') return out({ error: { code: -32603, message: 'Internal error' } });
      if (j.method === 'eth_call') return out({ error: { code: 3, message: 'execution reverted' } });
      return out({ result: '0x10' });
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const net = E.Network.from(1);
  const fpv = new FailoverProvider([base + '/bad', base + '/good'], net, { timeout: 2000 });
  const bn = await fpv.getBlockNumber();
  ok(bn === 16 && hits.bad >= 1 && hits.good >= 1 && fpv.activeUrl === base + '/good', 'failover: вузол відповів «Internal error» — запит іде на наступний, робочий вузол стає першим');
  const before = hits.bad;
  const fpv2 = new FailoverProvider([base + '/rev', base + '/bad'], net, { timeout: 2000 });
  const rv = await fpv2.call({ to: '0x0000000000000000000000000000000000000001', data: '0x' }).then(() => 'ok', e => e.code || e.message);
  ok(/CALL_EXCEPTION/.test(String(rv)) && hits.bad === before, 'failover: revert контракту — це результат виконання, запасні вузли не опитуються');
  const allBad = new FailoverProvider([base + '/bad', base + '/bad'], net, { timeout: 2000 });
  const ab = await allBad.getBlockNumber().then(() => 'ok', e => String(e.message || e.code));
  ok(ab !== 'ok' && /Internal error|coalesce|SERVER_ERROR|UNKNOWN_ERROR/i.test(ab), 'failover: якщо відмовили всі вузли — повертається помилка вузла, а не зависання');
  srv.closeAllConnections(); srv.close();
}

module.exports = { nftSourcesTests };
