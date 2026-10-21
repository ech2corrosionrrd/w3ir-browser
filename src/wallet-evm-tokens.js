'use strict';
// Токени ERC-20 у гаманці: баланси, додавання власних токенів, переказ. Метадані (symbol, decimals) завжди читаються з ланцюга:
// вбудований список — лише підказка, яку підтверджує сам контракт, а не довірений джерело правди.
const { Interface, getAddress, isAddress, formatUnits, parseUnits, toUtf8String, ZeroAddress } = require('ethers');
const { injectionClean } = require('./token-text');

const ERC20 = new Interface([
  'function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)', 'function transfer(address to, uint256 amount) returns (bool)',
]);
const BYTES32 = new Interface(['function name() view returns (bytes32)', 'function symbol() view returns (bytes32)']);

// Звірено зі справжніми мережами (symbol і decimals) — див. test/areas/wallet-tokens.js
const BUILTIN = {
  1: [['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'USDC'], ['0xdAC17F958D2ee523a2206206994597C13D831ec7', 'USDT'], ['0x6B175474E89094C44Da98b954EedeAC495271d0F', 'DAI'], ['0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 'WETH']],
  10: [['0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 'USDC']],
  56: [['0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 'USDC']],
  137: [['0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 'USDC']],
  8453: [['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'USDC']],
  42161: [['0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 'USDC']],
  43114: [['0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', 'USDC']],
  11155111: [['0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', 'USDC']],
};
const MAX_CUSTOM = 40;
const CALL_TIMEOUT = 15000;

function install(Wallet, { RpcError, clip, unauthorized }) {
  const proto = Wallet.prototype;
  const timed = (p, ms = CALL_TIMEOUT) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

  proto._ethCall = function (chainId, to, data) { return timed(this.provider(chainId).call({ to, data })); };

  // symbol/name бувають і bytes32 (старі токени на кшталт MKR)
  async function readText(w, chainId, addr, fn) {
    try { return ERC20.decodeFunctionResult(fn, await w._ethCall(chainId, addr, ERC20.encodeFunctionData(fn)))[0]; }
    catch {
      try { return toUtf8String(BYTES32.decodeFunctionResult(fn, await w._ethCall(chainId, addr, BYTES32.encodeFunctionData(fn)))[0]).replace(/\u0000+$/, ''); } catch { return ''; }
    }
  }

  // Дані токена з ланцюга з кешем; кидає помилку, якщо адреса не схожа на ERC-20
  proto.tokenInfo = async function (chainId, address) {
    const addr = getAddress(address);
    this._tokenCache = this._tokenCache || new Map();
    const key = `${chainId}|${addr}`;
    if (this._tokenCache.has(key)) return this._tokenCache.get(key);
    // decimals, symbol і name читаються паралельно (раніше по черзі: 3 раунди мережі замість одного)
    const [dec, symRaw, nameRaw] = await Promise.all([
      this._ethCall(chainId, addr, ERC20.encodeFunctionData('decimals')).then(r => ({ r }), () => ({ r: null })),
      readText(this, chainId, addr, 'symbol'),
      readText(this, chainId, addr, 'name'),
    ]);
    let decimals;
    try { decimals = Number(ERC20.decodeFunctionResult('decimals', dec.r)[0]); }
    catch { throw new RpcError(-32602, 'Це не схоже на токен ERC-20 у цій мережі (немає decimals).'); }
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new RpcError(-32602, 'Некоректні decimals токена.');
    const symbol = injectionClean(symRaw, 16) || 'ERC20';
    const name = injectionClean(nameRaw, 48);
    const info = { address: addr, symbol, name, decimals };
    this._tokenCache.set(key, info);
    return info;
  };

  // Виявлення токенів ERC-20 за недавніми переказами (історія подій): повертає ті, що ще не у списку, з ненульовим балансом.
  // Нічого не додає сама: користувач вирішує. Токени, усі перекази яких схожі на розсилку, позначаються suspicious і йдуть у кінець списку.
  proto.evmDiscoverTokens = async function (index) {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    const owner = this.evmView(index);
    const chainId = this.activeChain();
    const hist = await this.evmHistory(index, {});
    const known = new Set([...(BUILTIN[chainId] || []).map(([a]) => a), ...this._customTokens(chainId).map(c => c.address)].map(a => String(a).toLowerCase()));
    const cand = new Map();
    for (const it of hist.items) {
      if (it.kind !== 'erc20' || known.has(it.token.toLowerCase())) continue;
      const c = cand.get(it.token) || { address: it.token, allSuspicious: true, last: 0 };
      c.last = Math.max(c.last, it.time || 0, it.block || 0);
      if (!it.suspicious) c.allSuspicious = false; // хоч один не схожий на розсилку (ви відправляли, від контакту...) — не вважаємо спамом
      cand.set(it.token, c);
    }
    const out = [];
    await Promise.all([...cand.values()].slice(0, 24).map(async (c) => {
      try {
        const raw = ERC20.decodeFunctionResult('balanceOf', await this._ethCall(chainId, c.address, ERC20.encodeFunctionData('balanceOf', [owner])))[0];
        if (raw === 0n) return;
        const info = await this.tokenInfo(chainId, c.address);
        out.push({ address: c.address, symbol: info.symbol, name: info.name, decimals: info.decimals, amount: formatUnits(raw, info.decimals), suspicious: c.allSuspicious, last: c.last });
      } catch { /* не токен або вузол недоступний */ }
    }));
    out.sort((a, b) => (Number(a.suspicious) - Number(b.suspicious)) || (b.last - a.last));
    return { tokens: out, scanned: hist.scanned, partial: !!hist.partial };
  };

  proto._customTokens = function (chainId) {
    const s = this.section();
    s.tokens = s.tokens || {};
    return (s.tokens[chainId] = s.tokens[chainId] || []);
  };

  // Баланси токенів рахунку у вибраній мережі: вбудовані (лише ненульові й підтверджені контрактом) і додані користувачем
  proto.evmTokens = async function (index) {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    const owner = this.evmView(index);
    const chainId = this.activeChain();
    const custom = this._customTokens(chainId);
    const entries = [...(BUILTIN[chainId] || []).filter(([a]) => !custom.some(c => c.address === a)).map(([address, symbol]) => ({ address, expect: symbol, custom: false })), ...custom.map(c => ({ ...c, custom: true }))];
    const data = ERC20.encodeFunctionData('balanceOf', [owner]);
    const out = await Promise.all(entries.map(async (e) => {
      try {
        const info = await this.tokenInfo(chainId, e.address);
        if (e.expect && info.symbol !== e.expect) return null; // вбудована адреса не збігається із символом: не показуємо
        const raw = ERC20.decodeFunctionResult('balanceOf', await this._ethCall(chainId, e.address, data))[0];
        if (!e.custom && raw === 0n && e.expect !== 'USDC') return null; // USDC показується завжди (навіть з нульовим балансом)
        return { address: info.address, symbol: info.symbol, name: info.name, decimals: info.decimals, raw: raw.toString(), amount: formatUnits(raw, info.decimals), custom: e.custom };
      } catch { return e.custom ? { address: e.address, symbol: e.symbol, name: e.name || '', decimals: e.decimals, raw: '0', amount: null, custom: true } : null; }
    }));
    return { chainId, tokens: out.filter(Boolean) };
  };

  proto.addToken = async function (address) {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    if (typeof address !== 'string' || !isAddress(address)) throw new RpcError(-32602, 'Некоректна адреса контракту токена.');
    const chainId = this.activeChain();
    const info = await this.tokenInfo(chainId, address);
    const list = this._customTokens(chainId);
    if (list.some(t => t.address === info.address)) return info;
    if (list.length >= MAX_CUSTOM) throw new RpcError(-32602, `Не більше ${MAX_CUSTOM} власних токенів на мережу.`);
    list.push({ address: info.address, symbol: info.symbol, name: info.name, decimals: info.decimals });
    this.vault.persist();
    return info;
  };

  proto.removeToken = function (address) {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    const list = this._customTokens(this.activeChain());
    const i = list.findIndex(t => t.address === address);
    if (i >= 0) { list.splice(i, 1); this.vault.persist(); }
    return i >= 0;
  };

  // Переказ токена ERC-20 зі сторінки гаманця
  proto.sendToken = async function (win, sameTab, { index, token, to, amount, speed }) {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    const owner = this.evmAccount(index);
    if (typeof token !== 'string' || !isAddress(token)) throw new RpcError(-32602, 'Некоректна адреса контракту токена.');
    if (typeof to !== 'string' || !isAddress(to)) throw new RpcError(-32602, 'Некоректна адреса отримувача (або неправильна контрольна сума регістру).');
    const toAddr = getAddress(to);
    const tokenAddr = getAddress(token);
    if (toAddr === ZeroAddress) throw new RpcError(-32602, 'Адреса отримувача нульова: токени було б спалено.');
    if (toAddr === tokenAddr) throw new RpcError(-32602, 'Це адреса контракту самого токена: токени, надіслані на неї, зазвичай втрачаються назавжди.');
    const chainId = this.activeChain();
    const info = await this.tokenInfo(chainId, tokenAddr);
    if (typeof amount !== 'string' || !/^\d{1,30}(\.\d{1,36})?$/.test(amount) || (amount.split('.')[1] || '').length > info.decimals) throw new RpcError(-32602, 'Некоректна сума.');
    const raw = parseUnits(amount, info.decimals);
    if (raw <= 0n) throw new RpcError(-32602, 'Сума має бути більшою за нуль.');
    let balance;
    try { balance = ERC20.decodeFunctionResult('balanceOf', await this._ethCall(chainId, tokenAddr, ERC20.encodeFunctionData('balanceOf', [owner])))[0]; }
    catch (e) { throw new RpcError(-32000, `Не вдалося прочитати баланс токена: ${clip(e.shortMessage || e.message, 160)}`); }
    if (balance < raw) throw new RpcError(-32602, `Недостатньо токенів: на рахунку ${formatUnits(balance, info.decimals)} ${info.symbol}.`);
    const rw = this.recipientWarnings(toAddr, this.ownEvm());
    const gate = await this.policyGate({ to: toAddr, chain: 'evm', token: tokenAddr, amount });
    const warnings = [...rw.warnings, ...gate.warnings];
    const danger = rw.danger || gate.danger;
    try {
      const code = await timed(this.provider(chainId).getCode(toAddr), 6000);
      if (code && code !== '0x') warnings.push('Отримувач — смарт-контракт: токени, надіслані на контракт, який не вміє їх повертати, можуть бути втрачені.');
    } catch { /* RPC недоступний: перевірку пропущено */ }
    const net = this.network(chainId);
    const summary = [['Токен', `${info.symbol}${info.name ? ' — ' + info.name : ''} (${tokenAddr})`], ['Кількість', `${formatUnits(raw, info.decimals)} ${info.symbol}`], ['Отримувач', toAddr], ['Мережа токена', `${net.name} (${chainId})`]];
    const hash = await this.sendTransaction(win, 'w3ir://wallet', { from: owner, to: tokenAddr, data: ERC20.encodeFunctionData('transfer', [toAddr, raw]) }, sameTab, { internal: true, warnings, danger, summary, action: `Переказ ${formatUnits(raw, info.decimals)} ${info.symbol}`, token: true, speed, delay: gate.delay });
    gate.commit();
    this.rememberRecipient(toAddr);
    return hash;
  };
}

module.exports = { install, BUILTIN, ERC20 };
