'use strict';
// Огляд портфеля по всіх основних мережах: нативні монети й відомі токени (вбудований список і власні) на всіх рахунках,
// у USD за орієнтовними цінами. Лише читання: ліміти мережі незалежні (недоступна мережа не ламає решту), кеш 60 с.
// Рахунки лише для перегляду показуються окремо й не входять до загальної суми.
const { Interface, formatEther, formatUnits } = require('ethers');
const { Prices, NATIVE_ID, PLATFORM } = require('./prices');
const { BUILTIN: BUILTIN_TOKENS } = require('./wallet-evm-tokens');

const BAL = new Interface(['function balanceOf(address) view returns (uint256)']);
const CHAINS = [1, 10, 56, 137, 8453, 42161, 43114];
const TTL = 60000;
const MAX_ADDRS = 30;
const MAX_TOKENS = 12;

function install(Wallet, { unauthorized }) {
  const proto = Wallet.prototype;
  const timed = (p, ms = 15000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

  async function evmChain(w, chainId, addrs, prices) {
    const net = w.network(chainId);
    if (!net) return null;
    const out = { chainId, name: net.name, symbol: net.symbol, rows: [], usd: 0, watchUsd: 0, error: '' };
    let provider;
    try { provider = w.provider(chainId); } catch (e) { out.error = e.message; return out; }
    const custom = ((w.section().tokens || {})[chainId] || []).map(t => ({ address: t.address, expect: '' }));
    const seen = new Set();
    const tokens = [...(BUILTIN_TOKENS[chainId] || []).map(([address, expect]) => ({ address, expect })), ...custom].filter(t => (seen.has(t.address) ? false : seen.add(t.address))).slice(0, MAX_TOKENS);
    let anyOk = false;
    out.rows = await Promise.all(addrs.map(async (a) => {
      const row = { address: a.address, watch: a.watch, native: null, tokens: [] };
      try { row.native = { raw: await timed(provider.getBalance(a.address)) }; anyOk = true; } catch { /* вузол недоступний */ }
      await Promise.all(tokens.map(async (t) => {
        try {
          const raw = BAL.decodeFunctionResult('balanceOf', await w._ethCall(chainId, t.address, BAL.encodeFunctionData('balanceOf', [a.address])))[0];
          if (raw === 0n) return;
          const info = await w.tokenInfo(chainId, t.address);
          if (t.expect && info.symbol !== t.expect) return; // вбудована адреса не збігається із символом: не показуємо
          row.tokens.push({ address: info.address, symbol: info.symbol, raw, decimals: info.decimals });
        } catch { /* токен недоступний у цій мережі */ }
      }));
      return row;
    }));
    if (!anyOk) out.error = 'мережа не відповідає';
    // ціни
    let nativePrice = null, tokenPrices = {};
    if (prices) {
      const held = [...new Set(out.rows.flatMap(r => r.tokens.map(t => t.address)))];
      [nativePrice, tokenPrices] = await Promise.all([NATIVE_ID[chainId] ? prices.native(NATIVE_ID[chainId]) : null, PLATFORM[chainId] && held.length ? prices.tokens(PLATFORM[chainId], held) : {}]);
    }
    for (const r of out.rows) {
      let usd = 0, priced = true;
      if (r.native) {
        const amount = formatEther(r.native.raw);
        r.native = { amount, usd: nativePrice ? Number(amount) * nativePrice : null };
        if (r.native.usd !== null) usd += r.native.usd; else if (Number(amount) > 0) priced = false;
      }
      r.tokens = r.tokens.map((t) => {
        const amount = formatUnits(t.raw, t.decimals);
        const price = tokenPrices[t.address];
        const v = price ? Number(amount) * price : null;
        if (v !== null) usd += v; else priced = false;
        return { address: t.address, symbol: t.symbol, amount, usd: v };
      });
      r.usd = usd; r.priced = priced;
      if (r.watch) out.watchUsd += usd; else out.usd += usd;
    }
    return out;
  }

  async function solPart(w, prices) {
    if (w.solCluster() !== 'mainnet-beta') return { skipped: true, rows: [], usd: 0, watchUsd: 0 };
    const own = new Set(w.ownSol());
    const bals = await w.solBalances().catch(() => []);
    const price = prices ? await prices.native('solana') : null;
    const rows = await Promise.all(bals.slice(0, MAX_ADDRS).map(async (b) => {
      const row = { address: b.address, watch: !own.has(b.address), native: b.balance === null ? null : { amount: b.balance, usd: price ? Number(b.balance) * price : null }, tokens: [] };
      try {
        const r = await w.solTokens(b.address, { maxMints: 30, maxImages: 0 });
        const toks = r.tokens.filter(t => !t.nft);
        const tp = prices && toks.length ? await prices.tokens('solana', toks.map(t => t.mint)) : {};
        row.tokens = toks.map(t => ({ address: t.mint, symbol: t.symbol || t.name || '', amount: t.amount, usd: tp[t.mint] ? Number(t.amount) * tp[t.mint] : null }));
      } catch { /* токени недоступні */ }
      row.usd = (row.native && row.native.usd ? row.native.usd : 0) + row.tokens.reduce((s, t) => s + (t.usd || 0), 0);
      row.priced = (!row.native || row.native.usd !== null || Number(row.native.amount) === 0) && row.tokens.every(t => t.usd !== null);
      return row;
    }));
    return { skipped: false, rows, usd: rows.filter(r => !r.watch).reduce((s, r) => s + r.usd, 0), watchUsd: rows.filter(r => r.watch).reduce((s, r) => s + r.usd, 0) };
  }

  proto.portfolio = async function ({ force = false } = {}) {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    const now = Date.now();
    if (!force && this._pf && now - this._pf.at < TTL) return this._pf.data;
    const addrs = [...this.ownEvm().map(address => ({ address, watch: false })), ...this.watchAddrs('evm').map(address => ({ address, watch: true }))].slice(0, MAX_ADDRS);
    const priceOn = this.ctx.cfg().walletPrices !== false;
    const prices = priceOn ? (this._prices = this._prices || new Prices()) : null;
    const [evm, sol] = await Promise.all([Promise.all(CHAINS.map(c => evmChain(this, c, addrs, prices))), solPart(this, prices)]);
    const chains = evm.filter(Boolean);
    const data = {
      at: now, pricesOn: priceOn, chains, sol,
      total: chains.reduce((t, c) => t + c.usd, 0) + sol.usd,
      watchTotal: chains.reduce((t, c) => t + c.watchUsd, 0) + sol.watchUsd,
    };
    this._pf = { at: now, data };
    return data;
  };
}

module.exports = { install, CHAINS };
