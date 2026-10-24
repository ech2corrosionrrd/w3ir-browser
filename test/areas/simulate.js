'use strict';
// Симуляція транзакцій EVM (eth_simulateV1): розбір подій, опис для підтвердження, перебір вузлів. Мок RPC без вікон Electron.
const http = require('http');
const E = require('ethers');
const { ok } = require('../lib');

async function simulateTests() {
  const { parseSimulation, revertReason, checkSourcify, ETH_PSEUDO } = require('../../src/wallet-simulate');
  const { FailoverProvider } = require('../../src/rpc-failover');
  const coder = E.AbiCoder.defaultAbiCoder();
  const owner = E.getAddress('0x00000000000000000000000000000000000000a1');
  const other = E.getAddress('0x00000000000000000000000000000000000000b2');
  const spender = E.getAddress('0x00000000000000000000000000000000000000c3');
  const TOKEN = E.getAddress('0x00000000000000000000000000000000000000d4');
  const NFT = E.getAddress('0x00000000000000000000000000000000000000d5');
  const pad = (a) => E.zeroPadValue(a, 32);
  const T_TR = E.id('Transfer(address,address,uint256)'), T_AP = E.id('Approval(address,address,uint256)'), T_APALL = E.id('ApprovalForAll(address,address,bool)');
  const I1155 = new E.Interface(['event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)', 'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)']);
  const enc1155 = (name, args) => I1155.encodeEventLog(I1155.getEvent(name), args);
  const wrap = (call) => [{ calls: [call] }];
  const okCall = (logs) => ({ status: '0x1', gasUsed: '0x5208', returnData: '0x', logs });

  // --- розбір подій ---
  const logs = [
    { address: ETH_PSEUDO, topics: [T_TR, pad(owner), pad(other)], data: coder.encode(['uint256'], [10n ** 18n]) },
    { address: TOKEN, topics: [T_TR, pad(owner), pad(other)], data: coder.encode(['uint256'], [5_000_000n]) },
    { address: TOKEN, topics: [T_TR, pad(other), pad(owner)], data: coder.encode(['uint256'], [7n]) },
    { address: NFT, topics: [T_TR, pad(other), pad(owner), E.zeroPadValue('0x09', 32)], data: '0x' },
    { address: NFT, topics: [T_TR, pad(owner), pad(other), E.zeroPadValue('0x0a', 32)], data: '0x' },
    { address: TOKEN, topics: [T_TR, pad(other), pad(spender)], data: coder.encode(['uint256'], [99n]) }, // чужий переказ
    { address: TOKEN, topics: [T_AP, pad(owner), pad(spender)], data: coder.encode(['uint256'], [2n ** 256n - 1n]) },
    { address: TOKEN, topics: [T_AP, pad(other), pad(spender)], data: coder.encode(['uint256'], [1n]) }, // чужий дозвіл
    { address: NFT, topics: [T_APALL, pad(owner), pad(spender)], data: coder.encode(['bool'], [true]) },
    { address: NFT, ...enc1155('TransferSingle', [spender, owner, other, 3n, 2n]) },
    { address: NFT, ...enc1155('TransferBatch', [spender, other, owner, [4n, 5n], [1n, 6n]]) },
    { address: TOKEN, topics: [T_TR, pad(owner), pad(owner)], data: coder.encode(['uint256'], [1n]) }, // собі: не рух
  ];
  const sim = parseSimulation(wrap(okCall(logs)), owner);
  ok(sim.ok && sim.gasUsed === 21000n && sim.out.length === 4 && sim.inn.length === 4 && sim.approvals.length === 2, 'sim: події Transfer (ETH, ERC-20, ERC-721, ERC-1155), чужі й власні-собі переказів не рахуються; дозволи лише від вашого рахунку');
  ok(sim.out[0].kind === 'native' && sim.out[0].value === 10n ** 18n && sim.out[1].kind === 'erc20' && sim.out[1].value === 5_000_000n && sim.out[2].kind === 'nft721' && sim.out[2].id === 10n && sim.out[3].kind === 'nft1155' && sim.out[3].value === 2n, 'sim: з рахунку — ETH, токен, NFT-721 і NFT-1155 з правильними сумами й id');
  ok(sim.inn.filter(x => x.kind === 'nft1155').length === 2 && sim.inn.find(x => x.kind === 'nft721').id === 9n, 'sim: на рахунок — NFT-721 і пакетний переказ 1155 розкладено поелементно');
  ok(sim.approvals[0].kind === 'erc20' && sim.approvals[0].value === 2n ** 256n - 1n && sim.approvals[1].kind === 'all' && sim.approvals[1].approved === true, 'sim: видані дозволи — необмежений ERC-20 і доступ до всіх NFT');
  // помилка виконання
  const errData = new E.Interface(['function Error(string)']).encodeFunctionData('Error', ['ERC20: balance too low']);
  const bad = parseSimulation(wrap({ status: '0x0', gasUsed: '0x1', returnData: errData, logs: [] }), owner);
  ok(bad.ok === false && bad.error === 'ERC20: balance too low' && revertReason('0x4e487b71' + coder.encode(['uint256'], [0x11n]).slice(2)) === 'Panic(0x11)' && revertReason('0x') === '', 'sim: причина помилки виконання (Error(string), Panic) розбирається');
  ok((() => { try { parseSimulation([], owner); return false; } catch { return true; } })() && (() => { try { parseSimulation(null, owner); return false; } catch { return true; } })(), 'sim: порожня чи сміттєва відповідь вузла — виняток (симуляції немає), а не вигадані дані');
  const junk = parseSimulation(wrap(okCall([{ address: TOKEN, topics: [T_TR, 'сміття', pad(owner)], data: '0x' }, { address: 'не адреса', topics: [], data: '0x' }, null && {}].filter(Boolean))), owner);
  ok(junk.ok && junk.out.length === 0 && junk.inn.length === 0, 'sim: пошкоджені записи журналу пропускаються');

  // --- опис для підтвердження + перебір вузлів на моку ---
  let mode = 'ok';
  const hits = { a: 0, b: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const j = JSON.parse(body); const node = req.url.slice(1); hits[node]++;
      res.setHeader('content-type', 'application/json');
      const r = (result) => res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result }));
      const err = (code, message) => res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, error: { code, message } }));
      if (j.method === 'eth_chainId') return r('0x1');
      if (j.method !== 'eth_simulateV1') return err(-32601, 'no ' + j.method);
      if (node === 'a') return err(-32601, 'Method not found'); // перший вузол не підтримує симуляцію
      const c = j.params[0].blockStateCalls[0].calls[0];
      if (!/^0x([1-9a-f][0-9a-f]*|0)$/.test(c.value)) return err(-32602, 'hex number with leading zeros'); // суворий вузол
      if (mode === 'revert') return r(wrap({ status: '0x0', gasUsed: '0x1', returnData: errData, logs: [] }));
      r(wrap(okCall(logs)));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const net = E.Network.from(1);
  class FakeWallet {
    constructor(urls) { this.p = new FailoverProvider(urls, net, { timeout: 3000 }); }
    provider() { return this.p; }
    async tokenInfo(chainId, a) { if (a === TOKEN) return { symbol: 'TKN', decimals: 6 }; throw new Error('no'); }
  }
  require('../../src/wallet-simulate').install(FakeWallet, { clip: (s, n) => String(s).slice(0, n) });
  const w = new FakeWallet([url + '/a', url + '/b']);
  const s1 = await w.simulateEvm(1, { from: owner, to: spender, value: 10n ** 18n, data: '0x1234' });
  ok(s1 && s1.ok && hits.a >= 1 && hits.b >= 1 && s1.out.length === 4, 'sim: вузол без eth_simulateV1 пропускається, симуляція виконується на наступному; значення без ведучих нулів');
  const d1 = await w.describeSimulation(1, s1, { symbol: 'ETH' });
  const L = (k) => (d1.lines.find(l => l[0] === k) || [])[1] || '';
  ok(L('Симуляція') === 'виклик виконується успішно' && /1\.0 ETH/.test(L('З вашого рахунку піде')) && /5\.0 TKN/.test(L('З вашого рахунку піде')) && /NFT #10/.test(L('З вашого рахунку піде')) && /7\.0e-?\d*|0\.000007 TKN/.test(L('На ваш рахунок прийде')) && d1.danger === true, 'sim: опис — успіх, що піде й що прийде з символами токенів; небезпека через необмежений дозвіл і доступ до всіх NFT');
  ok(d1.lines.filter(l => l[0] === 'Дозвіл').length === 2 && d1.lines.some(l => /НЕОБМЕЖЕНО/.test(l[1])) && d1.lines.some(l => /ДОСТУП до ВСІХ NFT/.test(l[1])) && d1.warnings.some(x => /необмежений дозвіл/.test(x)) && d1.warnings.some(x => /ВСІХ ваших NFT/.test(x)), 'sim: видані дозволи показані в рядках і попередженнях');
  mode = 'revert';
  const s2 = await w.simulateEvm(1, { from: owner, to: spender, value: 0n, data: '0x1234' });
  const d2 = await w.describeSimulation(1, s2, { symbol: 'ETH' });
  ok(s2.ok === false && d2.danger === true && d2.lines.some(l => l[0] === 'Симуляція' && /ПОМИЛКА/.test(l[1]) && /balance too low/.test(l[1])) && d2.warnings.some(x => /завершиться помилкою/.test(x)), 'sim: помилка виконання — небезпека з причиною');
  const wDead = new FakeWallet([url + '/a']);
  const s3 = await wDead.simulateEvm(1, { from: owner, to: spender, value: 0n, data: '0x1234' });
  const d3 = await wDead.describeSimulation(1, s3, { symbol: 'ETH' });
  ok(s3 === null && d3.danger === false && d3.warnings.length === 1 && /Симуляцію не виконано/.test(d3.warnings[0]) && d3.lines.some(l => l[0] === 'Симуляція' && /недоступна/.test(l[1])), 'sim: жоден вузол не підтримує метод — «недоступна» з попередженням, без блокування і без небезпеки');
  const noOut = await w.describeSimulation(1, { ok: true, out: [{ kind: 'native', value: 5n }], inn: [], approvals: [], gasUsed: null }, { symbol: 'ETH' });
  ok(noOut.warnings.some(x => /нічого не прийде/.test(x)), 'sim: якщо активи йдуть, а нічого не повертається — попередження');
  const none = await w.describeSimulation(1, { ok: true, out: [], inn: [], approvals: [], gasUsed: null }, { symbol: 'ETH' });
  ok(none.lines.some(l => l[0] === 'Рух активів') && none.warnings.length === 0, 'sim: без руху активів — спокійний рядок без попереджень');

  const sfOk = await checkSourcify(1, TOKEN, async () => ({ ok: true, json: async () => ({ match: 'exact_match', compilation: { name: 'USD Coin' } }) }));
  ok(sfOk.verified === true && sfOk.match === 'exact_match' && sfOk.name === 'USD Coin', 'sim: Sourcify v2 розпізнає верифікований контракт');
  const sfNo = await checkSourcify(1, other, async () => ({ ok: false, status: 404 }));
  ok(sfNo.verified === false && sfNo.match === 'none', 'sim: Sourcify v2 повертає verified=false для неверифікованого контракту');
  ok(w.isFirstInteraction(other) === true && w.isFirstInteraction('0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD') === false, 'sim: isFirstInteraction відрізняє нові контракти від відомих роутерів');

  server.closeAllConnections(); server.close();
}

module.exports = { simulateTests };
