'use strict';
const { t: tr } = require('./i18n');
// Вбудований EVM-гаманець (EIP-1193 / EIP-6963). Фраза відновлення зберігається всередині зашифрованого сховища паролів
// (AES-256-GCM + scrypt + DPAPI); приватні ключі виводяться лише на мить підпису й ніколи не кешуються.
// Кожен підпис і транзакція потребують явного підтвердження у довіреному вікні браузера, яке сторінка підробити не може.
const {
  Mnemonic, HDNodeWallet, JsonRpcProvider, Network, formatEther, getAddress, isAddress, isHexString,
  hexlify, getBytes, TypedDataEncoder, randomBytes, toUtf8String, MaxUint256, Interface,
} = require('ethers');

const BUILTIN_NETWORKS = [
  { chainId: 1, name: 'Ethereum', symbol: 'ETH', rpc: 'https://ethereum-rpc.publicnode.com', explorer: 'https://etherscan.io' },
  { chainId: 10, name: 'Optimism', symbol: 'ETH', rpc: 'https://mainnet.optimism.io', explorer: 'https://optimistic.etherscan.io' },
  { chainId: 56, name: 'BNB Smart Chain', symbol: 'BNB', rpc: 'https://bsc-dataseed.binance.org', explorer: 'https://bscscan.com' },
  { chainId: 137, name: 'Polygon', symbol: 'POL', rpc: 'https://polygon-bor-rpc.publicnode.com', explorer: 'https://polygonscan.com' },
  { chainId: 8453, name: 'Base', symbol: 'ETH', rpc: 'https://mainnet.base.org', explorer: 'https://basescan.org' },
  { chainId: 42161, name: 'Arbitrum One', symbol: 'ETH', rpc: 'https://arb1.arbitrum.io/rpc', explorer: 'https://arbiscan.io' },
  { chainId: 43114, name: 'Avalanche C-Chain', symbol: 'AVAX', rpc: 'https://api.avax.network/ext/bc/C/rpc', explorer: 'https://snowtrace.io' },
  { chainId: 11155111, name: 'Sepolia (тестова)', symbol: 'ETH', rpc: 'https://ethereum-sepolia-rpc.publicnode.com', explorer: 'https://sepolia.etherscan.io' },
];

// Лише читання — проксуємо до RPC вибраної мережі
const READ_METHODS = new Set([
  'eth_call', 'eth_blockNumber', 'eth_getBalance', 'eth_getCode', 'eth_getLogs', 'eth_getTransactionByHash', 'eth_getTransactionReceipt',
  'eth_getTransactionCount', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory',
  'eth_estimateGas', 'eth_getStorageAt', 'eth_getBlockTransactionCountByNumber', 'eth_getBlockTransactionCountByHash',
]);

class RpcError extends Error {
  constructor(code, message, data) { super(message); this.code = code; this.data = data; }
}
const rejected = () => new RpcError(4001, 'Користувач відхилив запит');
const unauthorized = (m) => new RpcError(4100, m || 'Сайт не підключено до гаманця');

const clip = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n) + '…' : s; };
const hexChain = (id) => '0x' + Number(id).toString(16);

function isSafeRpc(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'));
  } catch { return false; }
}

// Розшифровка типових викликів контрактів і попередження (захист від drainer-ів)
const IFACE = new Interface([
  'function approve(address spender, uint256 amount)',
  'function increaseAllowance(address spender, uint256 added)',
  'function setApprovalForAll(address operator, bool approved)',
  'function transfer(address to, uint256 amount)',
  'function transferFrom(address from, address to, uint256 amount)',
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
  'function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)',
]);
function describeCall(data) {
  const out = { lines: [], warnings: [] };
  if (!data || data === '0x') return out;
  let parsed = null;
  try { parsed = IFACE.parseTransaction({ data }); } catch { /* невідомий метод */ }
  if (!parsed) {
    out.lines.push(['Виклик контракту', `невідомий метод ${data.slice(0, 10)} (${(data.length - 2) / 2} байт даних)`]);
    out.warnings.push('Невідомий виклик контракту: підтверджуйте лише якщо довіряєте сайту.');
    return out;
  }
  const a = parsed.args;
  switch (parsed.name) {
    case 'approve':
    case 'increaseAllowance': {
      const amount = a[1];
      const unlimited = amount >= (MaxUint256 >> 1n);
      out.lines.push(['Дія', 'Дозвіл витрачати токени'], ['Отримувач дозволу', getAddress(a[0])], ['Сума дозволу', unlimited ? 'НЕОБМЕЖЕНО' : `${amount.toString()} (у мінімальних одиницях)`]);
      if (unlimited) out.warnings.push('Необмежений дозвіл: цей адрес зможе витратити ВСІ ваші токени цього типу, доки ви не скасуєте дозвіл.');
      if (amount === 0n) out.lines.push(['Примітка', 'Нульова сума — це скасування дозволу']);
      break;
    }
    case 'setApprovalForAll':
      out.lines.push(['Дія', a[1] ? 'Дати доступ до ВСІХ NFT колекції' : 'Скасувати доступ до NFT колекції'], ['Оператор', getAddress(a[0])]);
      if (a[1]) out.warnings.push('Оператор зможе забрати ВСІ ваші NFT цієї колекції. Шахраї часто використовують саме цей виклик.');
      break;
    case 'transfer': out.lines.push(['Дія', 'Переказ токенів'], ['Отримувач', getAddress(a[0])], ['Кількість', `${a[1].toString()} (у мінімальних одиницях)`]); break;
    case 'transferFrom':
    case 'safeTransferFrom':
      out.lines.push(['Дія', 'Переказ токена/NFT'], ['Від', getAddress(a[0])], ['Кому', getAddress(a[1])], ['Токен/кількість', a[2].toString()]);
      break;
    default: break;
  }
  return out;
}

class Wallet {
  constructor(ctx, { allowInsecureRpc = false } = {}) {
    this.ctx = ctx;
    this.providers = new Map();
    this.rate = new Map();
    this.allowInsecureRpc = allowInsecureRpc;
  }

  get vault() { return this.ctx.vault; }
  exists() { return !!this.ctx.cfg().walletEnabled; }
  injectEnabled() { return this.exists() && this.ctx.cfg().walletInject !== false; }
  unlocked() { return this.vault.status() === 'unlocked'; }

  section() {
    if (!this.unlocked()) throw unauthorized('Гаманець заблоковано — розблокуйте сховище паролів');
    return this.vault.section('wallet', { mnemonic: null, addresses: [], connections: {}, networks: [], rpc: {}, activeChain: 1, log: [] });
  }
  data() { const s = this.section(); return s.mnemonic ? s : null; }

  // ---------- мережі ----------
  networks() {
    const custom = this.unlocked() ? (this.section().networks || []) : [];
    const rpc = this.unlocked() ? (this.section().rpc || {}) : {};
    return [...BUILTIN_NETWORKS, ...custom].map(n => ({ ...n, rpc: rpc[n.chainId] || n.rpc, builtin: BUILTIN_NETWORKS.some(b => b.chainId === n.chainId) }));
  }
  network(chainId) { return this.networks().find(n => n.chainId === Number(chainId)) || null; }
  activeChain() { return this.unlocked() && this.data() ? this.section().activeChain : (this.ctx.cfg().walletChain || 1); }
  chainOf(origin) {
    if (this.unlocked() && this.data()) {
      const c = this.section().connections[origin];
      if (c && c.chainId) return c.chainId;
    }
    return this.activeChain();
  }

  provider(chainId) {
    const net = this.network(chainId);
    if (!net) throw new RpcError(4902, 'Невідома мережа');
    if (!this.allowInsecureRpc && !isSafeRpc(net.rpc)) throw new RpcError(-32603, 'Небезпечна адреса RPC');
    const key = chainId + '|' + net.rpc;
    let p = this.providers.get(key);
    if (!p) {
      const n = Network.from(chainId);
      p = new JsonRpcProvider(net.rpc, n, { staticNetwork: n, batchMaxCount: 1 });
      this.providers.set(key, p);
    }
    return p;
  }

  // ---------- керування гаманцем (зі сторінки w3ir://wallet) ----------
  _store(phrase) {
    const s = this.section();
    s.mnemonic = phrase;
    s.addresses = [this._derive(phrase, 0).address];
    this.vault.persist();
    this.ctx.cfg().walletEnabled = true;
    this.ctx.settingsStore.save();
    this.ctx.pushAll();
  }
  _derive(phrase, i) { return HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(phrase), `m/44'/60'/0'/0/${i}`); }

  create() {
    if (this.exists() && this.data()) throw new Error('Гаманець уже створено.');
    const phrase = Mnemonic.fromEntropy(randomBytes(16)).phrase;
    this._store(phrase);
    return phrase;
  }

  importPhrase(text) {
    const phrase = String(text || '').trim().toLowerCase().split(/\s+/).join(' ');
    if (![12, 15, 18, 21, 24].includes(phrase.split(' ').length) || !Mnemonic.isValidMnemonic(phrase)) throw new Error('Некоректна фраза відновлення (перевірте слова та порядок).');
    if (this.exists() && this.data()) throw new Error('Гаманець уже існує. Спершу видаліть його.');
    this._store(phrase);
  }

  addAccount() {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    if (s.addresses.length >= 10) throw new Error('Максимум 10 рахунків.');
    s.addresses.push(this._derive(s.mnemonic, s.addresses.length).address);
    this.vault.persist();
    return s.addresses;
  }

  reveal() { const s = this.data(); if (!s) throw new Error('Гаманець не створено'); return s.mnemonic; }

  remove() {
    const s = this.section();
    s.mnemonic = null; s.addresses = []; s.connections = {}; s.log = [];
    this.vault.persist();
    this.ctx.cfg().walletEnabled = false;
    this.ctx.settingsStore.save();
    this.providers.clear();
    this.ctx.pushAll();
  }

  info() {
    const s = this.data();
    if (!s) return { exists: false };
    return {
      exists: true, accounts: s.addresses, activeChain: s.activeChain,
      networks: this.networks(), connections: Object.entries(s.connections).map(([origin, c]) => ({ origin, accounts: c.accounts, chainId: c.chainId })),
      log: s.log.slice(-100).reverse(),
    };
  }

  setChain(id) {
    const s = this.data();
    if (!s || !this.network(id)) throw new Error('Невідома мережа');
    s.activeChain = Number(id);
    this.vault.persist();
    this.ctx.cfg().walletChain = Number(id);
    this.ctx.settingsStore.save();
  }

  setRpc(id, url) {
    const s = this.data();
    if (!s || !this.network(id)) throw new Error('Невідома мережа');
    url = String(url || '').trim();
    if (url && !isSafeRpc(url)) throw new Error('RPC має бути https:// (або localhost).');
    if (url) s.rpc[id] = url; else delete s.rpc[id];
    this.vault.persist();
    this.providers.clear();
  }

  async balances() {
    const s = this.data();
    if (!s) return [];
    const chain = s.activeChain;
    const net = this.network(chain);
    const p = this.provider(chain);
    return Promise.all(s.addresses.map(async (a) => {
      try { return { address: a, balance: formatEther(await Promise.race([p.getBalance(a), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))])), symbol: net.symbol }; }
      catch { return { address: a, balance: null, symbol: net.symbol }; }
    }));
  }

  disconnectSite(origin) {
    const s = this.data();
    if (s && s.connections[origin]) { delete s.connections[origin]; this.vault.persist(); this.emit(origin, 'accountsChanged', []); }
  }

  log(entry) {
    try {
      const s = this.data();
      if (!s) return;
      s.log.push({ t: Date.now(), ...entry });
      if (s.log.length > 200) s.log.splice(0, s.log.length - 200);
      this.vault.persist();
    } catch { /* журнал необов'язковий */ }
  }

  // ---------- події для сторінок ----------
  emit(origin, ev, data) {
    const origin2 = (u) => { try { return new URL(u).origin; } catch { return ''; } };
    for (const w of this.ctx.windows) {
      for (const t of w.tabs) {
        if (t.sleep) continue;
        const wc = t.view.webContents;
        if (origin2(wc.getURL()) === origin) { try { wc.send('wallet:event', ev, data); } catch { /* ignore */ } }
      }
    }
  }

  onVaultChange() {
    // при блокуванні сайти бачать порожній список рахунків, при розблокуванні — знову підключені
    try {
      const unlocked = this.unlocked();
      const conns = this._lastConns || {};
      if (!unlocked) {
        for (const origin of Object.keys(conns)) this.emit(origin, 'accountsChanged', []);
      } else if (this.data()) {
        const cur = this.section().connections;
        for (const [origin, c] of Object.entries(cur)) this.emit(origin, 'accountsChanged', c.accounts);
      }
      if (unlocked && this.data()) this._lastConns = JSON.parse(JSON.stringify(this.section().connections));
    } catch { /* ignore */ }
  }

  // ---------- запити від сторінок ----------
  throttle(origin) {
    const now = Date.now();
    const r = this.rate.get(origin) || { t: now, n: 0 };
    if (now - r.t > 1000) { r.t = now; r.n = 0; }
    r.n++;
    this.rate.set(origin, r);
    if (r.n > 40) throw new RpcError(-32005, 'Забагато запитів');
  }

  async request(win, tab, origin, req) {
    this.throttle(origin);
    if (!req || typeof req.method !== 'string' || req.method.length > 64) throw new RpcError(-32600, 'Некоректний запит');
    const method = req.method;
    let params = req.params === undefined ? [] : req.params;
    if (!Array.isArray(params)) params = params && typeof params === 'object' ? [params] : [];
    if (JSON.stringify(params).length > 262144) throw new RpcError(-32602, 'Запит надто великий');
    if (!this.exists()) {
      if (method === 'eth_chainId') return hexChain(this.activeChain());
      if (method === 'eth_accounts') return [];
      win.toast('Створіть гаманець у W3IR: меню → Гаманець');
      throw unauthorized('Гаманець не створено');
    }
    const sameTab = () => win.tabs.includes(tab) && (() => { try { return new URL(tab.view.webContents.getURL()).origin === origin; } catch { return false; } })();

    switch (method) {
      case 'eth_chainId': return hexChain(this.chainOf(origin));
      case 'net_version': return String(this.chainOf(origin));
      case 'web3_clientVersion': return 'W3IR-Wallet/1.0';
      case 'eth_accounts': return this.accountsFor(origin);
      case 'eth_requestAccounts': return this.requestAccounts(win, origin, sameTab);
      case 'wallet_getPermissions': return this.accountsFor(origin).length ? [{ parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: this.accountsFor(origin) }] }] : [];
      case 'wallet_requestPermissions': { await this.requestAccounts(win, origin, sameTab); return [{ parentCapability: 'eth_accounts' }]; }
      case 'wallet_switchEthereumChain': return this.switchChain(win, origin, params[0], sameTab);
      case 'wallet_addEthereumChain': return this.addChain(win, origin, params[0], sameTab);
      case 'wallet_watchAsset': {
        const a = params[0] && params[0].options ? params[0].options : {};
        const ok = await this.approve(win, origin, sameTab, {
          kind: 'asset', title: tr('Додати токен'), lines: [['Символ', clip(a.symbol, 20)], ['Контракт', clip(a.address, 60)]],
          warnings: ['Сайт просить показати токен у гаманці. Це не дає йому доступу до коштів.'],
        });
        return ok;
      }
      case 'personal_sign': return this.personalSign(win, origin, params, sameTab);
      case 'eth_signTypedData_v4': case 'eth_signTypedData': return this.signTyped(win, origin, params, sameTab);
      case 'eth_sendTransaction': return this.sendTransaction(win, origin, params[0], sameTab);
      case 'eth_sign': throw new RpcError(4200, 'eth_sign вимкнено з міркувань безпеки (дозволяє підписати довільні дані)');
      case 'eth_signTransaction': case 'eth_subscribe': case 'eth_unsubscribe': throw new RpcError(4200, 'Метод не підтримується');
      default:
        if (READ_METHODS.has(method)) {
          try { return await this.provider(this.chainOf(origin)).send(method, params); }
          catch (e) { throw e instanceof RpcError ? e : new RpcError(e.code || -32603, clip(e.shortMessage || e.message, 300)); }
        }
        throw new RpcError(4200, `Метод не підтримується: ${clip(method, 40)}`);
    }
  }

  accountsFor(origin) {
    if (!this.unlocked() || !this.data()) return [];
    const c = this.section().connections[origin];
    return c ? c.accounts.slice() : [];
  }

  // Показ підтвердження у довіреному вікні; повертає true/кидає 4001
  async approve(win, origin, sameTab, spec) {
    const th = this.ctx.threats && this.ctx.cfg().safeBrowsing !== false ? this.ctx.threats.check(origin) : null;
    if (th && th.severity === 'listed') throw new RpcError(4100, 'Сайт у списку шахрайських ресурсів — гаманець не взаємодіє з ним');
    if (th) spec = { ...spec, danger: true, warnings: ['⚠ ' + th.reason, ...(spec.warnings || [])] };
    const r = await win.requestApproval({ ...spec, origin });
    if (!r.approved) throw rejected();
    if (!sameTab()) throw new RpcError(4001, 'Сторінку закрито або змінено під час підтвердження');
    return true;
  }

  async requestAccounts(win, origin, sameTab) {
    const have = this.accountsFor(origin);
    if (have.length) return have;
    await this.approve(win, origin, sameTab, {
      kind: 'connect', title: tr('Підключення до сайту'),
      lines: [['Сайт отримає', 'доступ до адреси вашого рахунку та право пропонувати транзакції'], ['Рахунок', this.unlocked() ? this.section().addresses[0] : 'буде показано після розблокування'], ['Мережа', (this.network(this.activeChain()) || {}).name || String(this.activeChain())]],
      warnings: ['Сайт не зможе нічого підписати без вашого окремого підтвердження.'],
    });
    const s = this.section();
    s.connections[origin] = { accounts: [s.addresses[0]], chainId: s.activeChain, since: Date.now() };
    this.vault.persist();
    this.log({ origin, action: 'Підключення' });
    this.emit(origin, 'accountsChanged', s.connections[origin].accounts);
    return s.connections[origin].accounts.slice();
  }

  async switchChain(win, origin, p, sameTab) {
    const id = p && p.chainId ? Number(p.chainId) : NaN;
    if (!Number.isInteger(id)) throw new RpcError(-32602, 'Некоректний chainId');
    const net = this.network(id);
    if (!net) throw new RpcError(4902, 'Мережа не додана до гаманця');
    if (this.chainOf(origin) === id) return null;
    await this.approve(win, origin, sameTab, { kind: 'switch', title: tr('Зміна мережі'), lines: [['Нова мережа', `${net.name} (chainId ${id})`]], warnings: [] });
    const s = this.section();
    if (s.connections[origin]) s.connections[origin].chainId = id;
    this.vault.persist();
    this.emit(origin, 'chainChanged', hexChain(id));
    return null;
  }

  async addChain(win, origin, p, sameTab) {
    if (!p || typeof p !== 'object') throw new RpcError(-32602, 'Некоректні параметри');
    const id = Number(p.chainId);
    const rpc = Array.isArray(p.rpcUrls) ? p.rpcUrls.find(u => typeof u === 'string' && (this.allowInsecureRpc ? true : isSafeRpc(u))) : null;
    const sym = p.nativeCurrency && typeof p.nativeCurrency.symbol === 'string' ? p.nativeCurrency.symbol : '';
    const name = typeof p.chainName === 'string' ? p.chainName.replace(/[\u0000-\u001f]/g, ' ').slice(0, 60) : '';
    if (!Number.isInteger(id) || id <= 0 || id > 2 ** 53 || !rpc || !/^[A-Za-z0-9]{2,8}$/.test(sym) || !name) throw new RpcError(-32602, 'Некоректні параметри мережі (потрібні chainId, https rpcUrls, symbol, chainName)');
    const existing = this.network(id);
    if (existing) return this.switchChain(win, origin, { chainId: hexChain(id) }, sameTab);
    const explorer = Array.isArray(p.blockExplorerUrls) && typeof p.blockExplorerUrls[0] === 'string' && /^https:\/\//.test(p.blockExplorerUrls[0]) ? p.blockExplorerUrls[0].slice(0, 200) : '';
    await this.approve(win, origin, sameTab, {
      kind: 'addChain', title: tr('Додати мережу'),
      lines: [['Назва', name], ['chainId', String(id)], ['Валюта', sym], ['RPC', clip(rpc, 120)]],
      warnings: ['Через RPC-сервер мережі проходять усі ваші запити (адреси, баланси). Додавайте мережі лише з надійних джерел.'],
    });
    const s = this.section();
    s.networks.push({ chainId: id, name, symbol: sym, rpc, explorer });
    if (s.connections[origin]) s.connections[origin].chainId = id;
    this.vault.persist();
    this.emit(origin, 'chainChanged', hexChain(id));
    return null;
  }

  requireConnected(origin, address) {
    const acc = this.accountsFor(origin);
    if (!acc.length) throw unauthorized();
    if (address) {
      if (!isAddress(address)) throw new RpcError(-32602, 'Некоректна адреса');
      const a = getAddress(address);
      if (!acc.includes(a)) throw unauthorized('Рахунок не підключено до цього сайту');
      return a;
    }
    return acc[0];
  }

  signerFor(address) {
    const s = this.section();
    const i = s.addresses.indexOf(address);
    if (i < 0) throw unauthorized('Невідомий рахунок');
    return this._derive(s.mnemonic, i);
  }

  async personalSign(win, origin, params, sameTab) {
    let [msg, addr] = params;
    if (typeof msg === 'string' && isAddress(msg) && typeof addr === 'string' && !isAddress(addr)) [msg, addr] = [addr, msg];
    const a = this.requireConnected(origin, addr);
    if (typeof msg !== 'string') throw new RpcError(-32602, 'Некоректне повідомлення');
    let bytes;
    if (isHexString(msg)) bytes = getBytes(msg); else bytes = new TextEncoder().encode(msg);
    if (bytes.length > 10000) throw new RpcError(-32602, 'Повідомлення надто велике');
    let text = null;
    try { const t = toUtf8String(bytes); if (/^[\P{C}\n\r\t]*$/u.test(t)) text = t; } catch { /* не текст */ }
    await this.approve(win, origin, sameTab, {
      kind: 'sign', title: tr('Підпис повідомлення'),
      lines: [['Рахунок', a], ['Повідомлення', text !== null ? clip(text, 1500) : hexlify(bytes).slice(0, 300)]],
      warnings: text === null ? ['Дані нечитабельні: підписуйте лише якщо повністю довіряєте сайту.'] : [],
    });
    const sig = await this.signerFor(a).signMessage(bytes);
    this.log({ origin, action: 'Підпис повідомлення' });
    return sig;
  }

  async signTyped(win, origin, params, sameTab) {
    let [addr, data] = params;
    if (typeof addr !== 'string' || !isAddress(addr)) [addr, data] = [data, addr];
    const a = this.requireConnected(origin, addr);
    let td;
    try { td = typeof data === 'string' ? JSON.parse(data) : data; } catch { throw new RpcError(-32602, 'Некоректні типізовані дані'); }
    if (!td || typeof td !== 'object' || !td.types || !td.domain || !td.message || typeof td.primaryType !== 'string') throw new RpcError(-32602, 'Некоректні типізовані дані');
    const types = { ...td.types };
    delete types.EIP712Domain;
    const chain = this.chainOf(origin);
    if (td.domain.chainId !== undefined && Number(td.domain.chainId) !== chain) throw new RpcError(-32602, `chainId у даних (${td.domain.chainId}) не збігається з поточною мережею (${chain})`);
    try { TypedDataEncoder.hash(td.domain, types, td.message); } catch (e) { throw new RpcError(-32602, `Дані не відповідають типам: ${clip(e.message, 120)}`); }
    const warnings = [];
    if (/permit|order|seaport|delegat|approval|listing/i.test(td.primaryType + JSON.stringify(Object.keys(types)))) warnings.push('Цей підпис може дозволити витрату ваших токенів або продаж NFT БЕЗ окремої транзакції. Підписуйте лише на довірених сайтах.');
    await this.approve(win, origin, sameTab, {
      kind: 'typed', title: tr('Підпис структурованих даних'), danger: warnings.length > 0,
      lines: [['Рахунок', a], ['Тип', clip(td.primaryType, 80)], ['Контракт (verifyingContract)', clip(td.domain.verifyingContract || '—', 60)], ['Мережа', String(chain)], ['Дані', clip(JSON.stringify(td.message, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1), 2500)]],
      warnings,
    });
    const sig = await this.signerFor(a).signTypedData(td.domain, types, td.message);
    this.log({ origin, action: `Підпис ${td.primaryType}` });
    return sig;
  }

  async sendTransaction(win, origin, tx, sameTab) {
    if (!tx || typeof tx !== 'object') throw new RpcError(-32602, 'Некоректна транзакція');
    const from = this.requireConnected(origin, tx.from);
    const chain = this.chainOf(origin);
    if (tx.chainId !== undefined && Number(tx.chainId) !== chain) throw new RpcError(-32602, 'chainId транзакції не збігається з поточною мережею');
    const net = this.network(chain);
    const num = (v, name) => {
      if (v === undefined || v === null) return undefined;
      if (typeof v === 'string' && /^0x[0-9a-fA-F]*$/.test(v)) return BigInt(v === '0x' ? '0x0' : v);
      if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
      throw new RpcError(-32602, `Некоректне поле ${name}`);
    };
    const to = tx.to ? (isAddress(tx.to) ? getAddress(tx.to) : (() => { throw new RpcError(-32602, 'Некоректна адреса отримувача'); })()) : null;
    const data = tx.data || tx.input || '0x';
    if (typeof data !== 'string' || !isHexString(data) || data.length > 200000) throw new RpcError(-32602, 'Некоректні дані транзакції');
    const value = num(tx.value, 'value') || 0n;
    const req = { from, to, value, data, chainId: chain };
    const gas = num(tx.gas || tx.gasLimit, 'gas');
    if (gas) req.gasLimit = gas;
    for (const k of ['gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas']) { const v = num(tx[k], k); if (v !== undefined) req[k] = v; }
    const nonce = num(tx.nonce, 'nonce');
    if (nonce !== undefined) req.nonce = Number(nonce);

    const signer = this.signerFor(from).connect(this.provider(chain));
    let populated;
    try { populated = await signer.populateTransaction(req); }
    catch (e) { throw new RpcError(-32000, `Не вдалося підготувати транзакцію (можливо, вона завершиться помилкою): ${clip(e.shortMessage || e.message, 200)}`); }
    const fee = (populated.maxFeePerGas || populated.gasPrice || 0n) * (populated.gasLimit || 0n);
    const desc = describeCall(data);
    const warnings = [...desc.warnings];
    if (!to) warnings.push('Створення нового контракту.');
    if (fee > 10n ** 18n) warnings.push('Дуже висока комісія за газ.');
    const lines = [
      ['Мережа', `${net.name} (${chain})`], ['Від', from], ['Кому', to || 'новий контракт'],
      ['Сума', `${formatEther(value)} ${net.symbol}`], ...desc.lines,
      ['Ліміт газу', String(populated.gasLimit)], ['Макс. комісія', `${formatEther(fee)} ${net.symbol}`], ['Макс. разом', `${formatEther(fee + value)} ${net.symbol}`],
    ];
    await this.approve(win, origin, sameTab, { kind: 'tx', title: tr('Підтвердження транзакції'), danger: warnings.some(w => /Необмежений|ВСІ/.test(w)), lines, warnings });
    let hash;
    try {
      const signed = await signer.signTransaction(populated);
      hash = (await signer.provider.broadcastTransaction(signed)).hash;
    } catch (e) { throw new RpcError(-32000, `Не вдалося надіслати транзакцію: ${clip(e.shortMessage || e.message, 200)}`); }
    this.log({ origin, action: `Транзакція ${formatEther(value)} ${net.symbol}`, hash, chainId: chain });
    return hash;
  }
}

module.exports = { Wallet, RpcError, BUILTIN_NETWORKS, describeCall, hexChain, isSafeRpc };
