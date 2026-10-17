'use strict';
// Додаткові можливості гаманця EVM: очікувані транзакції (прискорення й скасування), скасування дозволів токенів,
// адресна книга та ENS. Усі дії, що підписують, проходять те саме підтвердження в довіреному вікні, що й решта.
const { getAddress, isAddress, formatUnits, MaxUint256, Interface, namehash, ZeroAddress } = require('ethers');
const S = require('./solana');
const { injectionClean } = require('./token-text');
const { Prices, NATIVE_ID, PLATFORM } = require('./prices');

const ALLOWANCE = new Interface(['function allowance(address owner, address spender) view returns (uint256)', 'function approve(address spender, uint256 amount) returns (bool)']);
const MAX_PENDING = 20;
const MAX_CONTACTS = 100;
const ENS_RE = /^(?:[a-z0-9-]{1,63}\.)+eth$/;
// Реєстр ENS (однаковий в усіх мережах, де він є): resolver(node) -> addr(node). Універсальний резолвер ethers 6.17 на живій мережі
// повертає ResolverNotFound, тому запитуємо реєстр напряму (без CCIP-read: лише ончейн-імена .eth)
const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
const ENS_IFACE = new Interface(['function resolver(bytes32) view returns (address)', 'function addr(bytes32) view returns (address)']);
const FEE_FACTORS = { low: 85n, standard: 100n, fast: 150n };

function install(Wallet, { RpcError, clip, unauthorized }) {
  const proto = Wallet.prototype;
  // Орієнтовні ціни в USD (лише показ). Вимкнено налаштуванням walletPrices; тестові мережі й Devnet без цін
  proto.priceInfo = async function ({ chain, tokens }) {
    if (this.ctx.cfg().walletPrices === false) return { enabled: false, native: null, tokens: {} };
    this._prices = this._prices || new Prices();
    const list = Array.isArray(tokens) ? tokens.slice(0, 50).filter(x => typeof x === 'string') : [];
    if (chain === 'sol') {
      if (this.solCluster() !== 'mainnet-beta') return { enabled: true, native: null, tokens: {} };
      const [native, toks] = await Promise.all([this._prices.native('solana'), this._prices.tokens('solana', list)]);
      return { enabled: true, native, tokens: toks };
    }
    const chainId = this.activeChain();
    const [native, toks] = await Promise.all([NATIVE_ID[chainId] ? this._prices.native(NATIVE_ID[chainId]) : null, PLATFORM[chainId] ? this._prices.tokens(PLATFORM[chainId], list) : {}]);
    return { enabled: true, native, tokens: toks };
  };

  const timed = (p, ms = 8000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

  // ---------- швидкість комісії ----------
  proto.applySpeed = function (populated, speed) {
    const f = FEE_FACTORS[speed || 'standard'];
    if (f === undefined) throw new RpcError(-32602, 'Невідомий рівень швидкості комісії.');
    if (f === 100n) return;
    if (populated.maxFeePerGas) {
      populated.maxFeePerGas = populated.maxFeePerGas * f / 100n;
      if (populated.maxPriorityFeePerGas) populated.maxPriorityFeePerGas = populated.maxPriorityFeePerGas * f / 100n;
      if (populated.maxPriorityFeePerGas > populated.maxFeePerGas) populated.maxPriorityFeePerGas = populated.maxFeePerGas;
    } else if (populated.gasPrice) populated.gasPrice = populated.gasPrice * f / 100n;
  };

  // ---------- очікувані транзакції ----------
  proto.trackPending = function (hash, chainId, populated) {
    try {
      const s = this.data();
      if (!s) return;
      s.pending = s.pending || [];
      s.pending.push({
        hash, chainId, from: populated.from, nonce: Number(populated.nonce), to: populated.to || null, value: String(populated.value || 0n), data: populated.data || '0x',
        gasLimit: String(populated.gasLimit || 21000n), type: Number(populated.type || 0),
        maxFeePerGas: populated.maxFeePerGas ? String(populated.maxFeePerGas) : '', maxPriorityFeePerGas: populated.maxPriorityFeePerGas ? String(populated.maxPriorityFeePerGas) : '',
        gasPrice: populated.gasPrice ? String(populated.gasPrice) : '', t: Date.now(),
      });
      while (s.pending.length > MAX_PENDING) s.pending.shift();
      this.vault.persist();
    } catch { /* відстеження необов'язкове */ }
  };

  // Список справді очікуваних: підтверджені (nonce використано) прибираються
  proto.evmPending = async function () {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    const out = [];
    const keep = [];
    for (const p of s.pending || []) {
      let latest = null;
      try { latest = await timed(this.provider(p.chainId).getTransactionCount(p.from, 'latest'), 6000); } catch { /* мережа недоступна: лишаємо запис */ }
      if (latest !== null && latest > p.nonce) continue;
      keep.push(p);
      out.push({ hash: p.hash, chainId: p.chainId, nonce: p.nonce, to: p.to, value: p.value, since: p.t, from: p.from });
    }
    if (keep.length !== (s.pending || []).length) { s.pending = keep; this.vault.persist(); }
    return out;
  };

  const bump = (x) => (x * 125n) / 100n + 1n; // заміна в мемпулі потребує підвищення мінімум на 10 %

  // mode: 'speedup' (та сама транзакція з вищою комісією) | 'cancel' (нульовий переказ собі з тим самим nonce)
  proto.replacePending = async function (win, sameTab, { hash, mode }) {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    if (mode !== 'speedup' && mode !== 'cancel') throw new RpcError(-32602, 'Невідома дія.');
    const p = (s.pending || []).find(x => x.hash === hash);
    if (!p) throw new RpcError(-32602, 'Транзакцію не знайдено серед очікуваних.');
    if (!this.isOwnEvm(p.from) || !this.network(p.chainId)) throw new RpcError(-32602, 'Рахунок або мережу транзакції більше не підтримується.');
    const provider = this.provider(p.chainId);
    let latest;
    try { latest = await timed(provider.getTransactionCount(p.from, 'latest'), 8000); } catch (e) { throw new RpcError(-32000, `Не вдалося перевірити nonce: ${clip(e.message, 160)}`); }
    if (latest > p.nonce) { s.pending = s.pending.filter(x => x !== p); this.vault.persist(); throw new RpcError(-32602, 'Транзакція вже підтверджена або замінена.'); }
    const net = this.network(p.chainId);
    const req = { from: p.from, nonce: p.nonce, chainId: p.chainId, type: p.type };
    if (mode === 'cancel') Object.assign(req, { to: p.from, value: 0n, data: '0x', gasLimit: 21000n });
    else Object.assign(req, { to: p.to, value: BigInt(p.value), data: p.data, gasLimit: BigInt(p.gasLimit) });
    if (p.maxFeePerGas) { req.maxFeePerGas = bump(BigInt(p.maxFeePerGas)); req.maxPriorityFeePerGas = bump(BigInt(p.maxPriorityFeePerGas || '0')); }
    else req.gasPrice = bump(BigInt(p.gasPrice || '0'));
    const signer = this.signerFor(p.from).connect(provider);
    let populated;
    try { populated = await signer.populateTransaction(req); } catch (e) { throw new RpcError(-32000, `Не вдалося підготувати заміну: ${clip(e.shortMessage || e.message, 200)}`); }
    const fee = (populated.maxFeePerGas || populated.gasPrice || 0n) * (populated.gasLimit || 0n);
    const lines = [
      ['Дія', mode === 'cancel' ? 'Скасування: заміна нульовим переказом собі' : 'Прискорення: та сама транзакція з вищою комісією'],
      ['Мережа', `${net.name} (${p.chainId})`], ['Nonce', String(p.nonce)], ['Початкова транзакція', p.hash], ['Від', p.from],
      ...(mode === 'speedup' ? [['Кому', p.to || 'новий контракт'], ['Сума', `${formatUnits(BigInt(p.value), 18)} ${net.symbol}`]] : []),
      ['Нова макс. комісія', `${formatUnits(fee, 18)} ${net.symbol}`],
    ];
    const warnings = ['Якщо початкова транзакція встигне підтвердитися раніше, заміну мережа відхилить (кошти не втрачаються).'];
    if (mode === 'cancel') warnings.push('Скасування не гарантоване: воно спрацює, лише якщо заміна потрапить у блок раніше за початкову транзакцію.');
    await this.approve(win, 'w3ir://wallet', sameTab, { kind: 'tx', title: mode === 'cancel' ? 'Скасування транзакції' : 'Прискорення транзакції', lines, warnings });
    let newHash;
    try {
      const signed = await signer.signTransaction(populated);
      newHash = (await provider.broadcastTransaction(signed)).hash;
    } catch (e) { throw new RpcError(-32000, `Не вдалося надіслати заміну: ${clip(e.shortMessage || e.message, 200)}`); }
    s.pending = s.pending.filter(x => x !== p);
    this.trackPending(newHash, p.chainId, populated);
    this.log({ origin: 'w3ir://wallet', action: mode === 'cancel' ? 'Скасування транзакції' : 'Прискорення транзакції', hash: newHash, chainId: p.chainId });
    return newHash;
  };

  // ---------- скасування дозволу токена ----------
  proto.revokeAllowance = async function (win, sameTab, { index, token, spender }) {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    const owner = this.evmAccount(index);
    if (typeof token !== 'string' || !isAddress(token) || typeof spender !== 'string' || !isAddress(spender)) throw new RpcError(-32602, 'Некоректна адреса токена або адреса, якій видано дозвіл.');
    const chainId = this.activeChain();
    const info = await this.tokenInfo(chainId, token);
    const spenderAddr = getAddress(spender);
    let current;
    try { current = ALLOWANCE.decodeFunctionResult('allowance', await this._ethCall(chainId, info.address, ALLOWANCE.encodeFunctionData('allowance', [owner, spenderAddr])))[0]; }
    catch (e) { throw new RpcError(-32000, `Не вдалося прочитати дозвіл: ${clip(e.shortMessage || e.message, 160)}`); }
    if (current === 0n) throw new RpcError(-32602, 'Цей дозвіл уже нульовий: скасовувати нічого.');
    const unlimited = current >= (MaxUint256 >> 1n);
    const summary = [['Дія', 'Скасування дозволу витрачати токени (approve 0)'], ['Токен', `${info.symbol}${info.name ? ' — ' + info.name : ''} (${info.address})`], ['Кому видано дозвіл', spenderAddr], ['Поточний дозвіл', unlimited ? 'НЕОБМЕЖЕНО' : `${formatUnits(current, info.decimals)} ${info.symbol}`]];
    return this.sendTransaction(win, 'w3ir://wallet', { from: owner, to: info.address, data: ALLOWANCE.encodeFunctionData('approve', [spenderAddr, 0n]) }, sameTab, { internal: true, summary, action: `Скасування дозволу ${info.symbol}` });
  };

  // ---------- адресна книга ----------
  const cleanName = (name) => injectionClean(name, 32);
  proto.contacts = function () {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    return (s.contacts || []).map(c => ({ name: c.name, address: c.address, chain: c.chain }));
  };
  proto.addContact = function (name, address) {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    const n = cleanName(name);
    if (!n) throw new RpcError(-32602, 'Вкажіть назву контакту.');
    let addr, chain;
    if (typeof address === 'string' && isAddress(address)) { addr = getAddress(address); chain = 'evm'; }
    else if (typeof address === 'string' && S.isAddress(address)) { addr = address; chain = 'sol'; }
    else throw new RpcError(-32602, 'Некоректна адреса контакту.');
    s.contacts = s.contacts || [];
    const existing = s.contacts.find(c => c.address === addr);
    if (existing) existing.name = n;
    else {
      if (s.contacts.length >= MAX_CONTACTS) throw new RpcError(-32602, `Не більше ${MAX_CONTACTS} контактів.`);
      s.contacts.push({ name: n, address: addr, chain });
    }
    this.vault.persist();
    return { name: n, address: addr, chain };
  };
  proto.removeContact = function (address) {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    const before = (s.contacts || []).length;
    s.contacts = (s.contacts || []).filter(c => c.address !== address);
    if (s.contacts.length !== before) this.vault.persist();
    return s.contacts.length !== before;
  };

  // ---------- ENS ----------
  // Лише ASCII-імена .eth (латиниця, цифри, дефіс): кирилиця й схожі символи не проходять, тож підміна символів неможлива
  proto.resolveName = async function (name) {
    const n = String(name == null ? '' : name).trim().toLowerCase();
    if (/\.sol$/.test(n)) return this.resolveSolName(n); // Solana Name Service
    if (!ENS_RE.test(n) || n.length > 100) throw new RpcError(-32602, 'Підтримуються лише ASCII-імена ENS у зоні .eth (латиниця, цифри, дефіс).');
    let addr;
    try {
      if (this.ensResolver) addr = await this.ensResolver(n);
      else {
        const node = namehash(n);
        const resolver = ENS_IFACE.decodeFunctionResult('resolver', await this._ethCall(1, ENS_REGISTRY, ENS_IFACE.encodeFunctionData('resolver', [node])))[0];
        if (resolver === ZeroAddress) addr = null;
        else {
          const a = ENS_IFACE.decodeFunctionResult('addr', await this._ethCall(1, resolver, ENS_IFACE.encodeFunctionData('addr', [node])))[0];
          addr = a === ZeroAddress ? null : a;
        }
      }
    } catch (e) { throw new RpcError(-32000, `Не вдалося розв’язати ім’я: ${clip(e.message, 160)}`); }
    if (!addr || !isAddress(addr)) throw new RpcError(-32602, 'Це ім’я не зареєстровано або не вказує на адресу.');
    return getAddress(addr);
  };
}

module.exports = { install, FEE_FACTORS, ALLOWANCE };
