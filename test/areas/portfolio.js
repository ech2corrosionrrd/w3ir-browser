'use strict';
// Огляд портфеля по мережах: облегшений клас-замінник гаманця, мок RPC і підставні ціни.
const http = require('http');
const E = require('ethers');
const { ok } = require('../lib');

async function portfolioTests() {
  const { FailoverProvider } = require('../../src/rpc-failover');
  const { BUILTIN } = require('../../src/wallet-evm-tokens');
  const coder = E.AbiCoder.defaultAbiCoder();
  const owner = E.getAddress('0x00000000000000000000000000000000000000a1');
  const watch = E.getAddress('0x00000000000000000000000000000000000000b2');
  const USDC1 = BUILTIN[1][0][0];
  const SOLOWN = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const SOLMINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
  const balances = { [owner]: 10n ** 18n, [watch]: 2n * 10n ** 18n };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const one = (j) => {
        const r = (result) => ({ jsonrpc: '2.0', id: j.id, result });
        const revert = { jsonrpc: '2.0', id: j.id, error: { code: 3, message: 'execution reverted' } };
        switch (j.method) {
          case 'eth_chainId': return r('0x1');
          case 'eth_getBalance': return r('0x' + (balances[E.getAddress(j.params[0])] || 0n).toString(16));
          case 'eth_call': {
            const { to, data } = j.params[0];
            const sel = String(data).slice(0, 10);
            if (E.getAddress(to) !== E.getAddress(USDC1)) return revert;
            if (sel === '0x70a08231') { const [a] = coder.decode(['address'], '0x' + data.slice(10)); return r(coder.encode(['uint256'], [E.getAddress(a) === owner ? 150_000_000n : 0n])); }
            if (sel === '0x313ce567') return r(coder.encode(['uint8'], [6]));
            if (sel === '0x95d89b41') return r(coder.encode(['string'], ['USDC']));
            if (sel === '0x06fdde03') return r(coder.encode(['string'], ['USD Coin']));
            return revert;
          }
          default: return { jsonrpc: '2.0', id: j.id, error: { code: -32601, message: 'no ' + j.method } };
        }
      };
      const json = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(json) ? json.map(one) : one(json)));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const dead = 'http://127.0.0.1:1';

  let pricesOn = true;
  class FakeWallet {
    constructor() { this.s = { tokens: {} }; this.ctx = { cfg: () => ({ walletPrices: pricesOn }) }; this.pcache = new Map(); }
    section() { return this.s; }
    data() { return this.s; }
    network(id) { return { chainId: id, name: 'Net' + id, symbol: id === 56 ? 'BNB' : (id === 137 ? 'POL' : (id === 43114 ? 'AVAX' : 'ETH')) }; }
    provider(id) {
      if (!this.pcache.has(id)) this.pcache.set(id, new FailoverProvider([id === 56 ? dead : url], E.Network.from(1), { timeout: 1500 }));
      return this.pcache.get(id);
    }
    _ethCall(id, to, data) { return this.provider(id).call({ to, data }); }
    ownEvm() { return [owner]; }
    watchAddrs(chain) { return chain === 'evm' ? [watch] : []; }
    ownSol() { return [SOLOWN]; }
    solCluster() { return 'mainnet-beta'; }
    async solBalances() { return [{ address: SOLOWN, balance: '2', symbol: 'SOL' }]; }
    async solTokens() { return { tokens: [{ mint: SOLMINT, amount: '10', nft: false, symbol: 'USDT' }, { mint: 'NFTmint111111111111111111111111111111111111', amount: '1', nft: true, symbol: '' }] }; }
  }
  const helpers = { RpcError: Error, clip: (s, n) => String(s).slice(0, n), unauthorized: (m) => new Error(m) };
  require('../../src/wallet-evm-tokens').install(FakeWallet, helpers);
  require('../../src/wallet-portfolio').install(FakeWallet, helpers);
  const w = new FakeWallet();
  let priceCalls = 0;
  w._prices = {
    native: async (id) => { priceCalls++; return ({ ethereum: 2000, binancecoin: 500, 'polygon-ecosystem-token': 0.1, 'avalanche-2': 10, solana: 100 })[id] || null; },
    tokens: async (platform, addrs) => { priceCalls++; const o = {}; for (const a of addrs) { if (platform === 'ethereum' && a === E.getAddress(USDC1)) o[a] = 1; if (platform === 'solana' && a === SOLMINT) o[a] = 1; } return o; },
  };

  const pf = await w.portfolio();
  const eth = pf.chains.find(c => c.chainId === 1), bnb = pf.chains.find(c => c.chainId === 56), pol = pf.chains.find(c => c.chainId === 137);
  ok(pf.chains.length === 7 && eth && bnb && pol && pf.pricesOn === true, 'portfolio: усі сім основних мереж EVM і Solana в огляді');
  const ethOwn = eth.rows.find(r => !r.watch);
  ok(ethOwn.native.amount === '1.0' && ethOwn.native.usd === 2000 && ethOwn.tokens.length === 1 && ethOwn.tokens[0].symbol === 'USDC' && ethOwn.tokens[0].amount === '150.0' && ethOwn.tokens[0].usd === 150 && eth.usd === 2150, 'portfolio: нативна монета й токени в USD на рахунку (ETH 1 × 2000 + USDC 150)');
  ok(bnb.error === 'мережа не відповідає' && bnb.usd === 0 && pol.usd === 0.1 && pf.chains.filter(c => !c.error).length === 6, 'portfolio: недоступна мережа позначається помилкою й не ламає решту');
  ok(pf.sol.usd === 210 && pf.sol.rows[0].tokens.length === 1 && pf.sol.rows[0].tokens[0].usd === 10, 'portfolio: Solana — SOL і токени (NFT не рахуються)');
  const expectedEvm = 2150 + 2000 * 3 + 0.1 + 10; // ETH-мережі (1 з USDC, 10, 8453, 42161), POL, AVAX; BNB недоступна
  ok(Math.abs(pf.total - (expectedEvm + 210)) < 1e-6, 'portfolio: загальна сума = сума по доступних мережах і Solana');
  ok(Math.abs(pf.watchTotal - 2 * (2000 * 4 + 0.1 + 10)) < 1e-6 && !eth.rows.find(r => r.watch).tokens.length, 'portfolio: рахунок лише для перегляду враховано окремо й не входить у загальну суму');
  const calls1 = priceCalls;
  const again = await w.portfolio();
  ok(again === pf && priceCalls === calls1, 'portfolio: повторний запит у межах хвилини береться з кешу');
  const forced = await w.portfolio({ force: true });
  ok(forced !== pf && priceCalls > calls1, 'portfolio: force оновлює дані');
  pricesOn = false;
  const noPrice = await w.portfolio({ force: true });
  ok(noPrice.pricesOn === false && noPrice.total === 0 && noPrice.chains.find(c => c.chainId === 1).rows[0].native.usd === null && noPrice.chains.find(c => c.chainId === 1).rows[0].native.amount === '1.0', 'portfolio: без цін показується лише кількість, підсумок не вигадується');
  pricesOn = true;

  server.closeAllConnections(); server.close();
}

module.exports = { portfolioTests };
