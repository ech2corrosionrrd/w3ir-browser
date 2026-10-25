'use strict';
// Ліміти політики гаманця для транзакцій від сайтів (без Electron): ціна за мережею транзакції, transferFrom / safeTransferFrom,
// токени SPL від сайту, добовий ліміт для кількох переказів в одній транзакції.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { Interface } = require('ethers');
const src = (n) => require(path.join(__dirname, '..', '..', 'src', n));
const safety = src('wallet-safety.js');
const extras = src('wallet-extras.js');
const { describeCall } = src('wallet-evm-core.js');
const S = src('solana.js');

class RpcError extends Error { constructor(code, message) { super(message); this.code = code; } }
const unauthorized = (m) => new RpcError(4100, m || 'Не авторизовано');
const clip = (x, n) => String(x).slice(0, n);

const ME = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const TOKEN_IFACE = new Interface([
  'function transferFrom(address from, address to, uint256 amount)',
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
  'function transfer(address to, uint256 amount)',
]);

// ---- опис викликів: який переказ підпадає під ліміти ----
test('describeCall: transfer і transferFrom позначають суму для лімітів, safeTransferFrom — переказ NFT', () => {
  const t = describeCall(TOKEN_IFACE.encodeFunctionData('transfer', [OTHER, 5n]));
  assert.equal(t.spend.to, OTHER);
  assert.equal(t.spend.from, undefined, 'у transfer відправник — сам підписувач');

  const tf = describeCall(TOKEN_IFACE.encodeFunctionData('transferFrom', [ME, OTHER, 7n]));
  assert.deepEqual({ to: tf.spend.to, amount: tf.spend.amount, from: tf.spend.from }, { to: OTHER, amount: 7n, from: ME });
  assert.equal(tf.nft, undefined);

  const sf = describeCall(TOKEN_IFACE.encodeFunctionData('safeTransferFrom', [ME, OTHER, 9n]));
  assert.equal(sf.spend, undefined, 'tokenId — не сума');
  assert.deepEqual({ to: sf.nft.to, from: sf.nft.from }, { to: OTHER, from: ME });
});

// ---- ціна береться за мережею транзакції ----
function priceWallet() {
  class W {
    constructor() { this.asked = []; this._prices = { native: async (id) => { this.asked.push(id); return { ethereum: 3000, 'polygon-ecosystem-token': 0.5 }[id] || null; }, tokens: async () => ({}) }; }
    get ctx() { return { cfg: () => ({}) }; }
    activeChain() { return 1; }
    solCluster() { return 'mainnet-beta'; }
  }
  extras.install(W, { RpcError, clip, unauthorized });
  return new W();
}

test('priceInfo: ціна нативної монети за мережею транзакції, а не за активною мережею гаманця', async () => {
  const w = priceWallet();
  assert.equal((await w.priceInfo({ chain: 'evm', tokens: [] })).native, 3000, 'без мережі — активна (Ethereum)');
  assert.equal((await w.priceInfo({ chain: 'evm', chainId: 137, tokens: [] })).native, 0.5, 'сайт на Polygon — ціна POL');
  assert.equal((await w.priceInfo({ chain: 'evm', chainId: 'сміття', tokens: [] })).native, 3000, 'нечислова мережа ігнорується');
});

// ---- policyGate: мережа передається в usdValue, кілька переказів рахуються разом ----
function gateWallet() {
  class W {
    constructor() {
      this._data = { policy: { ...safety.DEFAULT_POLICY }, contacts: [], spend: [] };
      this.vault = { persist() {} };
      this.chainsAsked = [];
    }
    data() { return this._data; }
    unlocked() { return true; }
    ownEvm() { return [ME]; }
    ownSol() { return []; }
    priceInfo({ chainId }) { this.chainsAsked.push(chainId); return Promise.resolve({ enabled: true, native: chainId === 137 ? 0.5 : 3000, tokens: { MINT: 1 } }); }
  }
  safety.install(W, { RpcError, unauthorized });
  return new W();
}

test('policyGate: передає мережу транзакції в розрахунок вартості', async () => {
  const w = gateWallet();
  w.setPolicy({ maxUsd: 100 });
  // 1000 POL ≈ 500 USD > 100 — відхиляється за ціною Polygon, а за ціною Ethereum (3000 × 1000) теж, але сума інша
  await assert.rejects(() => w.policyGate({ to: OTHER, chain: 'evm', chainId: 137, amount: '1000' }), /≈ 500\.00 USD/);
  assert.deepEqual(w.chainsAsked, [137]);
  // дешевий переказ на дорогій мережі не виглядає дрібним: 0.1 ETH ≈ 300 USD
  await assert.rejects(() => w.policyGate({ to: OTHER, chain: 'evm', chainId: 1, amount: '0.1' }), /≈ 300\.00 USD/);
});

test('policyGate: кілька переказів в одному підтвердженні враховуються разом у добовому ліміті', async () => {
  const w = gateWallet();
  w.setPolicy({ dailyUsd: 500 });
  const first = await w.policyGate({ to: OTHER, chain: 'sol', token: 'MINT', amount: '300', contacts: false });
  assert.equal(first.usd, 300);
  // другий переказ ще не списаний (commit після підтвердження), але вже враховується через pendingUsd
  await assert.rejects(() => w.policyGate({ to: OTHER, chain: 'sol', token: 'MINT', amount: '300', contacts: false, pendingUsd: first.usd }), /Перевищено добовий ліміт 500 USD.*інші перекази в цій транзакції ≈ 300.00 USD/);
  const ok = await w.policyGate({ to: OTHER, chain: 'sol', token: 'MINT', amount: '150', contacts: false, pendingUsd: first.usd });
  assert.equal(ok.usd, 150);
  first.commit(); ok.commit();
  assert.equal(w.spentUsd(), 450);
});

test('policyGate: невідома вартість не блокує, а попереджає (ціни лише орієнтовні)', async () => {
  const w = gateWallet();
  w.setPolicy({ maxUsd: 10 });
  const r = await w.policyGate({ to: OTHER, chain: 'sol', token: 'unknown', amount: undefined, contacts: false });
  assert.ok(r.warnings.some(x => /не визначено/.test(x)));
  assert.equal(r.usd, null);
});

// ---- Solana: токени від сайту потрапляють в опис для лімітів ----
test('solana describe: токени SPL зі своїх акаунтів повертаються в tokenTransfers', () => {
  const owner = 'Owner1111111111111111111111111111111111111';
  const keys = ['Src', 'MintMint', 'Dest', owner, S.PROGRAMS.TOKEN];
  const checked = Buffer.alloc(10); checked[0] = 12; checked.writeBigUInt64LE(2_500_000n, 1); checked[9] = 6;
  const plain = Buffer.alloc(9); plain[0] = 3; plain.writeBigUInt64LE(77n, 1);
  const parsed = {
    keys, numSigs: 1, unresolved: 0,
    instructions: [
      { programId: S.PROGRAMS.TOKEN, accounts: [0, 1, 2, 3], data: checked },
      { programId: S.PROGRAMS.TOKEN, accounts: [0, 2, 3], data: plain },
    ],
  };
  const d = S.describe(parsed, [owner]);
  assert.equal(d.tokenTransfers.length, 2);
  assert.deepEqual(d.tokenTransfers[0], { mint: 'MintMint', amount: 2_500_000n, decimals: 6 });
  assert.deepEqual(d.tokenTransfers[1], { mint: null, amount: 77n, decimals: null, source: 'Src' }, 'без mint вартість невідома, але відомий токен-акаунт відправника');
  // чужий підписувач — не наш переказ
  assert.equal(S.describe(parsed, ['Someone']).tokenTransfers.length, 0);
});

// ---- сума всієї транзакції: стеля «на один переказ» і пауза ----
test('policyGateMany: стеля й пауза застосовуються до суми всієї транзакції', async () => {
  const w = gateWallet();
  w.setPolicy({ maxUsd: 100, confirmUsd: 0 });
  // дві ноги по 80 проходять стелю поодинці, але разом (160) її перевищують
  await assert.rejects(() => w.policyGateMany([{ token: 'MINT', amount: '80' }, { token: 'MINT', amount: '80' }], { chain: 'sol', contacts: false }), /на одну транзакцію.*160\.00 USD/);
  // одна нога в межах стелі проходить
  const one = await w.policyGateMany([{ token: 'MINT', amount: '80' }], { chain: 'sol', contacts: false });
  assert.equal(one.usd, 80);
  w.setPolicy({ maxUsd: 0, confirmUsd: 100 });
  const two = await w.policyGateMany([{ token: 'MINT', amount: '60' }, { token: 'MINT', amount: '60' }], { chain: 'sol', contacts: false });
  assert.equal(two.delay, 5);
  assert.equal(two.danger, true);
  assert.ok(two.warnings.some(x => /разом ≈ 120\.00 USD/.test(x)));
});

// ---- Solana: mint із токен-акаунта відправника ----
test('_solTokenAccount: mint і decimals із відповіді вузла, сміття відхиляється', async () => {
  class W {}
  require(path.join(__dirname, '..', '..', 'src', 'wallet-solana.js')).install(W, { RpcError, isSafeRpc: () => true, clip, unauthorized });
  const w = new W();
  const MINT = S.PROGRAMS.TOKEN;
  w.solRpc = async () => ({ value: { data: { parsed: { info: { mint: MINT, tokenAmount: { decimals: 6 } } } } } });
  assert.deepEqual(await w._solTokenAccount('mainnet-beta', 'Src'), { mint: MINT, decimals: 6 });
  w.solRpc = async () => ({ value: { data: { parsed: { info: { mint: 'не адреса', tokenAmount: { decimals: 6 } } } } } });
  assert.equal(await w._solTokenAccount('mainnet-beta', 'Src'), null);
  w.solRpc = async () => ({ value: { data: { parsed: { info: { mint: MINT, tokenAmount: { decimals: 99 } } } } } });
  assert.equal(await w._solTokenAccount('mainnet-beta', 'Src'), null);
  w.solRpc = async () => ({ value: null });
  assert.equal(await w._solTokenAccount('mainnet-beta', 'Src'), null);
  w.solRpc = async () => { throw new Error('мережа'); };
  assert.equal(await w._solTokenAccount('mainnet-beta', 'Src'), null);
});

// ---- перевірка імені хоста RPC ----
test('assertPublicRpc: ім\'я, що вказує на непублічну адресу, відхиляється; публічне й локальне — ні', async () => {
  const { assertPublicRpc } = src('rpc-guard.js');
  const res = (list) => async () => list;
  await assert.rejects(() => assertPublicRpc('https://evil-a.example/', res([{ address: '10.0.0.5', family: 4 }])), (e) => e.code === 'ENOTPUBLIC');
  await assert.rejects(() => assertPublicRpc('https://evil-b.example/', res([{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }])), (e) => e.code === 'ENOTPUBLIC', 'достатньо однієї непублічної адреси');
  await assert.rejects(() => assertPublicRpc('https://evil-c.example/', res([{ address: '::1', family: 6 }])), (e) => e.code === 'ENOTPUBLIC');
  await assertPublicRpc('https://good.example/', res([{ address: '93.184.216.34', family: 4 }]));
  await assertPublicRpc('http://localhost:8545/', async () => { throw new Error('не повинно викликатись'); });
  await assertPublicRpc('http://127.0.0.1:8545/', async () => { throw new Error('не повинно викликатись'); });
  await assertPublicRpc('https://unresolved.example/', async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); });
  // публічний результат кешується: повторний запит у межах TTL не резолвить знову
  let calls = 0;
  await assertPublicRpc('https://cached.example/', async () => { calls++; return [{ address: '93.184.216.34' }]; });
  await assertPublicRpc('https://cached.example/', async () => { calls++; return [{ address: '10.1.1.1' }]; });
  assert.equal(calls, 1);
});

// ---- Solana: зміна токенів за симуляцією ----
test('solTokenDeltas: зміна токенів лише зі своїх акаунтів, сміття ігнорується', () => {
  const { solTokenDeltas } = src('wallet-solana.js');
  const me = 'Owner1111111111111111111111111111111111111';
  const mint = S.PROGRAMS.TOKEN;
  const mint2 = S.PROGRAMS.TOKEN22;
  const acc = (owner, m, amount, decimals = 6) => ({ data: { parsed: { info: { owner, mint: m, tokenAmount: { amount: String(amount), decimals } } } } });
  // зменшення, нове надходження (акаунт створюється), закритий акаунт
  const d = solTokenDeltas(
    [acc(me, mint, 5_000_000), null, acc(me, mint2, 700, 0)],
    [acc(me, mint, 2_500_000), acc(me, mint2, 40, 0), null],
    me,
  );
  const by = Object.fromEntries(d.map(x => [x.mint, x.delta]));
  assert.equal(by[mint], -2_500_000n);
  assert.equal(by[mint2], 40n - 700n);
  // зміни на ЧУЖОМУ токен-акаунті й акаунти без змін не показуються
  assert.deepEqual(solTokenDeltas([acc('Someone', mint, 5)], [acc('Someone', mint, 1)], me), []);
  assert.deepEqual(solTokenDeltas([acc(me, mint, 5)], [acc(me, mint, 5)], me), []);
  // недовірені дані: не-адреса mint, нечислова сума, надмірні decimals, відсутні поля
  const bad = [acc(me, 'не-адреса', 5), acc(me, mint, 'abc'), acc(me, mint, 5, 99), { data: {} }, null];
  assert.deepEqual(solTokenDeltas(bad, bad.map(() => acc(me, mint, 1)), me).length <= 1, true);
  assert.deepEqual(solTokenDeltas(bad, bad, me), []);
});
