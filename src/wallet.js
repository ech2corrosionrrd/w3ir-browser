'use strict';
const { t: tr } = require('./i18n');
const { FailoverProvider } = require('./rpc-failover');
const guard = require('./wallet-signguard');
// Вбудований EVM-гаманець (EIP-1193 / EIP-6963). Фраза відновлення зберігається всередині зашифрованого сховища паролів
// (AES-256-GCM + scrypt + DPAPI); приватні ключі виводяться лише на мить підпису й ніколи не кешуються.
// Кожен підпис і транзакція потребують явного підтвердження у довіреному вікні браузера, яке сторінка підробити не може.
const {
  Mnemonic, HDNodeWallet, JsonRpcProvider, Network, formatEther, getAddress, isAddress, isHexString,
  hexlify, getBytes, TypedDataEncoder, randomBytes, toUtf8String, MaxUint256, Interface, parseUnits, formatUnits, Wallet: EthWallet,
} = require('ethers');

const BUILTIN_NETWORKS = [
  { chainId: 1, name: 'Ethereum', symbol: 'ETH', rpc: 'https://ethereum-rpc.publicnode.com', rpcFallback: ['https://cloudflare-eth.com', 'https://1rpc.io/eth', 'https://eth.drpc.org'], explorer: 'https://etherscan.io' },
  { chainId: 10, name: 'Optimism', symbol: 'ETH', rpc: 'https://mainnet.optimism.io', explorer: 'https://optimistic.etherscan.io' },
  { chainId: 56, name: 'BNB Smart Chain', symbol: 'BNB', rpc: 'https://bsc-dataseed.binance.org', explorer: 'https://bscscan.com' },
  { chainId: 137, name: 'Polygon', symbol: 'POL', rpc: 'https://polygon-bor-rpc.publicnode.com', rpcFallback: ['https://1rpc.io/matic', 'https://polygon.drpc.org'], explorer: 'https://polygonscan.com' },
  { chainId: 8453, name: 'Base', symbol: 'ETH', rpc: 'https://mainnet.base.org', explorer: 'https://basescan.org' },
  { chainId: 42161, name: 'Arbitrum One', symbol: 'ETH', rpc: 'https://arb1.arbitrum.io/rpc', explorer: 'https://arbiscan.io' },
  { chainId: 43114, name: 'Avalanche C-Chain', symbol: 'AVAX', rpc: 'https://api.avax.network/ext/bc/C/rpc', explorer: 'https://snowtrace.io' },
  { chainId: 11155111, name: 'Sepolia (тестова)', symbol: 'ETH', rpc: 'https://ethereum-sepolia-rpc.publicnode.com', rpcFallback: ['https://1rpc.io/sepolia'], explorer: 'https://sepolia.etherscan.io' },
];

// Шляхи деривації EVM: standard — m/44'/60'/0'/0/i (MetaMask, Trezor, Ledger у MetaMask); ledgerLive — m/44'/60'/i'/0/0; legacy — m/44'/60'/0'/i (старі MEW/Ledger)
const EVM_PATHS = { standard: (i) => `m/44'/60'/0'/0/${i}`, ledgerLive: (i) => `m/44'/60'/${i}'/0/0`, legacy: (i) => `m/44'/60'/0'/${i}` };

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
  'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)',
]);
// ti — дані токена ({ symbol, decimals }) з ланцюга: тоді суми показуються у людському вигляді
function describeCall(data, ti) {
  const out = { lines: [], warnings: [], token: false };
  const human = (v) => (ti ? `${formatUnits(v, ti.decimals)} ${ti.symbol}` : `${v.toString()} (у мінімальних одиницях)`);
  if (!data || data === '0x') return out;
  let parsed = null;
  try { parsed = IFACE.parseTransaction({ data }); } catch { /* невідомий метод */ }
  if (!parsed) {
    out.lines.push(['Виклик контракту', `невідомий метод ${data.slice(0, 10)} (${(data.length - 2) / 2} байт даних)`]);
    out.warnings.push('Невідомий виклик контракту: підтверджуйте лише якщо довіряєте сайту.');
    return out;
  }
  try {
  const a = parsed.args;
  switch (parsed.name) {
    case 'approve':
    case 'increaseAllowance': {
      out.token = true;
      const amount = a[1];
      const unlimited = amount >= (MaxUint256 >> 1n);
      out.lines.push(['Дія', 'Дозвіл витрачати токени'], ['Отримувач дозволу', getAddress(a[0])], ['Сума дозволу', unlimited ? 'НЕОБМЕЖЕНО' : human(amount)]);
      if (unlimited) out.warnings.push('Необмежений дозвіл: цей адрес зможе витратити ВСІ ваші токени цього типу, доки ви не скасуєте дозвіл.');
      if (amount === 0n) out.lines.push(['Примітка', 'Нульова сума — це скасування дозволу']);
      break;
    }
    case 'setApprovalForAll':
      out.lines.push(['Дія', a[1] ? 'Дати доступ до ВСІХ NFT колекції' : 'Скасувати доступ до NFT колекції'], ['Оператор', getAddress(a[0])]);
      if (a[1]) out.warnings.push('Оператор зможе забрати ВСІ ваші NFT цієї колекції. Шахраї часто використовують саме цей виклик.');
      break;
    case 'transfer': out.token = true; out.lines.push(['Дія', 'Переказ токенів'], ['Отримувач', getAddress(a[0])], ['Кількість', human(a[1])]); break;
    case 'transferFrom':
    case 'safeTransferFrom':
      out.token = parsed.name === 'transferFrom';
      out.lines.push(['Дія', 'Переказ токена/NFT'], ['Від', getAddress(a[0])], ['Кому', getAddress(a[1])], ['Токен/кількість', ti && parsed.name === 'transferFrom' ? human(a[2]) : a[2].toString()]);
      break;
    default: break;
  }
  } catch {
    // спотворені дані (наприклад, ненульові старші байти адреси): показуємо як невідомий виклик, а не падаємо
    out.lines.length = 0;
    out.token = false;
    out.lines.push(['Виклик контракту', `спотворені дані методу ${data.slice(0, 10)}`]);
    out.warnings.push('Дані виклику спотворені й не відповідають відомому формату. Підтверджуйте лише якщо повністю довіряєте сайту.');
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
    return this.vault.section('wallet', { mnemonic: null, addresses: [], connections: {}, networks: [], rpc: {}, activeChain: 1, log: [], names: [], recipients: [] });
  }
  data() { const s = this.section(); return s.mnemonic ? s : null; }

  // ---------- мережі ----------
  networks() {
    const custom = this.unlocked() ? (this.section().networks || []) : [];
    const rpc = this.unlocked() ? (this.section().rpc || {}) : {};
    return [...BUILTIN_NETWORKS, ...custom].map(n => ({ ...n, rpc: rpc[n.chainId] || n.rpc, rpcFallback: rpc[n.chainId] ? [] : (n.rpcFallback || []), builtin: BUILTIN_NETWORKS.some(b => b.chainId === n.chainId) }));
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
      const backups = (net.rpcFallback || []).filter(u => this.allowInsecureRpc || isSafeRpc(u));
      p = backups.length ? new FailoverProvider([net.rpc, ...backups], n) : new JsonRpcProvider(net.rpc, n, { staticNetwork: n, batchMaxCount: 1 });
      this.providers.set(key, p);
    }
    return p;
  }

  // ---------- керування гаманцем (зі сторінки w3ir://wallet) ----------
  _store(phrase, opts = {}) {
    const s = this.section();
    s.mnemonic = phrase;
    s.passphrase = opts.passphrase || '';
    s.evmPath = opts.evmPath || 'standard';
    s.solPath = opts.solPath || 'phantom';
    s.solAddresses = [];
    s.addresses = [this._derive(phrase, 0).address];
    this.vault.persist();
    this.ctx.cfg().walletEnabled = true;
    this.ctx.settingsStore.save();
    this.ctx.pushAll();
  }
  // Фраза-пароль (25-те слово BIP39) і шлях деривації обираються під час імпорту; для наявних гаманців — стандартні (m/44'/60'/0'/0/i, без пароля)
  _derive(phrase, i, o) {
    const s = this.data() || {};
    const pass = o && o.passphrase !== undefined ? o.passphrase : (s.passphrase || '');
    const kind = (o && o.evmPath) || s.evmPath || 'standard';
    return HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(phrase, pass), EVM_PATHS[kind](i));
  }
  // Перевірка обраних параметрів імпорту (без збереження)
  _checkImportOpts(opts = {}) {
    const passphrase = opts.passphrase === undefined || opts.passphrase === null ? '' : String(opts.passphrase);
    if (passphrase.length > 128) throw new Error('Фраза-пароль завелика (до 128 символів).');
    const evmPath = opts.evmPath || 'standard', solPath = opts.solPath || 'phantom';
    if (!EVM_PATHS[evmPath]) throw new Error('Невідомий шлях деривації EVM.');
    if (!require('./solana').SOL_PATHS[solPath]) throw new Error('Невідомий шлях деривації Solana.');
    return { passphrase, evmPath, solPath };
  }
  _checkPhrase(text) {
    const phrase = String(text || '').trim().toLowerCase().split(/\s+/).join(' ');
    if (![12, 15, 18, 21, 24].includes(phrase.split(' ').length) || !Mnemonic.isValidMnemonic(phrase)) throw new Error('Некоректна фраза відновлення (перевірте слова та порядок).');
    return phrase;
  }
  // Перші адреси за обраними параметрами — щоб звірити з іншим гаманцем до імпорту (нічого не зберігається)
  previewDerivation(text, opts, count = 3) {
    const phrase = this._checkPhrase(text);
    const o = this._checkImportOpts(opts);
    const S = require('./solana');
    const seed = Buffer.from(Mnemonic.fromPhrase(phrase, o.passphrase).computeSeed().slice(2), 'hex');
    const evm = [], sol = [];
    for (let i = 0; i < count; i++) {
      evm.push(HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(phrase, o.passphrase), EVM_PATHS[o.evmPath](i)).address);
      sol.push(S.deriveAccount(seed, i, o.solPath).address);
    }
    return { evm, sol };
  }

  create() {
    if (this.exists() && this.data()) throw new Error('Гаманець уже створено.');
    const phrase = Mnemonic.fromEntropy(randomBytes(16)).phrase;
    this._store(phrase);
    return phrase;
  }

  importPhrase(text, opts) {
    const phrase = this._checkPhrase(text);
    const o = this._checkImportOpts(opts);
    if (this.exists() && this.data()) throw new Error('Гаманець уже існує. Спершу видаліть його.');
    this._store(phrase, o);
    this.section().backupConfirmedAt = Date.now();
    this.vault.persist();
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
  revealPassphrase() { const s = this.data(); if (!s) throw new Error('Гаманець не створено'); return s.passphrase || ''; }

  remove() {
    const s = this.section();
    s.mnemonic = null; s.addresses = []; s.connections = {}; s.log = [];
    s.solAddresses = []; s.solConnections = {}; s.pending = []; s.contacts = []; s.tokens = {}; s.names = []; s.recipients = []; s.imported = []; s.watch = [];
    s.backupConfirmedAt = 0; s.approvalsSeen = {}; s.nfts = {}; s.nftHidden = {};
    s.passphrase = ''; s.evmPath = 'standard'; s.solPath = 'phantom';
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
      networks: this.networks(), connections: Object.entries(s.connections).map(([origin, c]) => ({ origin, accounts: c.accounts, chainId: c.chainId })), dapp: { evm: this.dappIndex('evm'), sol: this.dappIndex('sol') },
      log: s.log.slice(-100).reverse(), sol: this.solInfo(), names: s.addresses.map((_, i) => (s.names || [])[i] || ''), imported: this.importedAccounts(), watch: this.watchAccounts(), policy: this.getPolicy(), backup: this.backupInfo(), derivation: { evmPath: s.evmPath || 'standard', solPath: s.solPath || 'phantom', passphrase: !!s.passphrase },
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
    return Promise.all([...this.ownEvm(), ...this.watchAddrs('evm')].map(async (a) => {
      try { return { address: a, balance: formatEther(await Promise.race([p.getBalance(a), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))])), symbol: net.symbol }; }
      catch { return { address: a, balance: null, symbol: net.symbol }; }
    }));
  }

  disconnectSite(origin) {
    const s = this.data();
    if (s && s.connections[origin]) { delete s.connections[origin]; this.vault.persist(); this.emit(origin, 'accountsChanged', []); }
    this.solDisconnectSite(origin);
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
        for (const origin of Object.keys(this._lastSolConns || {})) this.emit(origin, 'sol:disconnect', null);
      } else if (this.data()) {
        const cur = this.section().connections;
        for (const [origin, c] of Object.entries(cur)) this.emit(origin, 'accountsChanged', c.accounts);
      }
      this.snapConns();
    } catch { /* ignore */ }
  }

  // Знімок підключень: після блокування сховища дані вже недоступні, а сайтам треба повідомити про відключення
  snapConns() {
    if (this.unlocked() && this.data()) {
      this._lastConns = JSON.parse(JSON.stringify(this.section().connections));
      this._lastSolConns = JSON.parse(JSON.stringify(this.section().solConnections || {}));
    }
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
    this.expireSites();
    this.touchSite(origin);
    const sameTab = () => win.tabs.includes(tab) && (() => { try { return new URL(tab.view.webContents.getURL()).origin === origin; } catch { return false; } })();
    if (method.startsWith('solana_')) return this.solRequest(win, tab, origin, method, params[0], sameTab);

    const blocked = guard.rejectReason(method);
    if (blocked) throw new RpcError(4200, blocked);
    switch (method) {
      case 'wallet_getCapabilities': return {};
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
    return c ? c.accounts.filter(a => this.isOwnEvm(a)) : [];
  }

  // Показ підтвердження у довіреному вікні; повертає true/кидає 4001
  async approve(win, origin, sameTab, spec) {
    const th = this.ctx.threats && this.ctx.cfg().safeBrowsing !== false ? this.ctx.threats.check(origin) : null;
    if (th && th.severity === 'listed') throw new RpcError(4100, 'Сайт у списку шахрайських ресурсів — гаманець не взаємодіє з ним');
    if (th) spec = { ...spec, danger: true, warnings: ['⚠ ' + th.reason, ...(spec.warnings || [])] };
    const r = await win.requestApproval({ ...spec, origin });
    if (!r.approved) throw rejected();
    if (!sameTab()) throw new RpcError(4001, 'Сторінку закрито або змінено під час підтвердження');
    return r;
  }

  async requestAccounts(win, origin, sameTab) {
    const have = this.accountsFor(origin);
    if (have.length) return have;
    // Рахунків кілька — користувач вибирає, яким підключитися (за замовчуванням — типовий для сайтів)
    const def = this.unlocked() ? this.dappIndex('evm') : 0;
    const options = this.unlocked() ? this.dappChoices('evm') : [];
    const choose = options.length > 1;
    const ap = await this.approve(win, origin, sameTab, {
      kind: 'connect', title: tr('Підключення до сайту'),
      lines: [['Сайт отримає', 'доступ до адреси вашого рахунку та право пропонувати транзакції'], ...(choose ? [] : [['Рахунок', this.unlocked() ? this.evmAccount(def) : 'буде показано після розблокування']]), ['Мережа', (this.network(this.activeChain()) || {}).name || String(this.activeChain())]],
      ...(choose ? { choice: { label: 'Рахунок для сайту', options, value: String(def) } } : {}),
      warnings: ['Сайт не зможе нічого підписати без вашого окремого підтвердження.'],
    });
    const s = this.section();
    s.connections[origin] = { accounts: [this.evmAccount(choose ? this.pickChoice(ap, options, def) : def)], chainId: s.activeChain, since: Date.now() };
    this.vault.persist();
    this.log({ origin, action: 'Підключення' });
    this.snapConns();
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
    if (i < 0) {
      const secret = this._importedSecret(address, 'evm'); // імпортований за приватним ключем
      if (!secret) throw unauthorized('Невідомий рахунок');
      return new EthWallet(secret);
    }
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
    const siwe = text !== null ? guard.checkSiwe(text, { origin, account: a, chainId: this.chainOf(origin) }) : null;
    await this.approve(win, origin, sameTab, {
      kind: 'sign', title: siwe ? tr('Вхід через Ethereum (SIWE)') : tr('Підпис повідомлення'), danger: !!(siwe && siwe.danger),
      lines: [['Рахунок', a], ...(siwe ? siwe.lines : []), ['Повідомлення', text !== null ? clip(text, 1500) : hexlify(bytes).slice(0, 300)]],
      warnings: [...(text === null ? ['Дані нечитабельні: підписуйте лише якщо повністю довіряєте сайту.'] : []), ...(siwe ? siwe.warnings : [])],
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
    // розшифровка дозволів: отримувач — контракт чи звичайний рахунок, токен і сума, термін, власник
    const isContract = new Map(), tokens = new Map();
    const quick = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
    try {
      const prov = this.provider(chain);
      await Promise.all([
        ...guard.permitSpenders(td).map(async (sp) => { try { const c = await quick(prov.getCode(sp), 5000); isContract.set(sp, !!c && c !== '0x'); } catch { /* невідомо */ } }),
        ...guard.permitTokens(td).map(async (t) => { try { const i = await quick(this.tokenInfo(chain, t), 5000); tokens.set(t, { symbol: i.symbol, decimals: i.decimals }); } catch { /* не ERC-20 */ } }),
      ]);
    } catch { /* RPC недоступний: розшифровка без перевірки отримувача */ }
    const g = guard.describeTyped({ ...td, types }, { account: a, isContract, tokens });
    if (g) warnings.push(...g.warnings);
    await this.approve(win, origin, sameTab, {
      kind: 'typed', title: tr('Підпис структурованих даних'), danger: warnings.length > 0 || !!(g && g.danger),
      lines: [['Рахунок', a], ...(g ? g.lines : []), ['Тип', clip(td.primaryType, 80)], ['Контракт (verifyingContract)', clip(td.domain.verifyingContract || '—', 60)], ['Мережа', String(chain)], ['Дані', clip(JSON.stringify(td.message, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1), 2500)]],
      warnings,
    });
    const sig = await this.signerFor(a).signTypedData(td.domain, types, td.message);
    this.log({ origin, action: `Підпис ${td.primaryType}` });
    return sig;
  }

  // opts.internal — переказ із самої сторінки гаманця (відправник — власний рахунок, а не підключений сайт);
  // opts.warnings/danger — додаткові попередження про отримувача
  async sendTransaction(win, origin, tx, sameTab, opts = {}) {
    if (!tx || typeof tx !== 'object') throw new RpcError(-32602, 'Некоректна транзакція');
    if (guard.hasDelegation(tx)) throw new RpcError(4200, 'Транзакції з делегуванням рахунку (EIP-7702) вимкнено: вони віддають контроль над рахунком коду контракту.');
    const from = opts.internal ? getAddress(tx.from) : this.requireConnected(origin, tx.from);
    if (opts.internal && !this.isOwnEvm(from)) throw unauthorized('Невідомий рахунок');
    const chain = opts.internal ? this.activeChain() : this.chainOf(origin);
    if (tx.chainId !== undefined && Number(tx.chainId) !== chain) throw new RpcError(-32602, 'chainId транзакції не збігається з поточною мережею');
    const net = this.network(chain);
    try {
      const del = guard.delegateOf(await Promise.race([this.provider(chain).getCode(from), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]));
      if (del) opts = { ...opts, danger: true, warnings: [...(opts.warnings || []), `Ваш рахунок делеговано контракту ${del} (EIP-7702): цей контракт керує виконанням транзакцій рахунку. Якщо ви цього не робили — рахунок скомпрометовано, не підтверджуйте.`] };
    } catch { /* RPC недоступний: перевірку пропущено */ }
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
    this.applySpeed(populated, opts.speed);
    const fee = (populated.maxFeePerGas || populated.gasPrice || 0n) * (populated.gasLimit || 0n);
    let desc = describeCall(data);
    let ti = null;
    if (desc.token && to && !opts.summary) {
      try { ti = await this.tokenInfo(chain, to); desc = describeCall(data, ti); } catch { /* не схоже на ERC-20 або RPC недоступний */ }
    }
    const warnings = [...desc.warnings, ...(opts.warnings || [])];
    if (!to) warnings.push('Створення нового контракту.');
    if (fee > 10n ** 18n) warnings.push('Дуже висока комісія за газ.');
    // симуляція виклику контракту на вузлі RPC: рух активів, дозволи, помилка виконання (якщо вузол це підтримує)
    let simInfo = { lines: [], warnings: [], danger: false };
    if (to && data !== '0x') {
      simInfo = await this.describeSimulation(chain, await this.simulateEvm(chain, { from, to, value, data }), { symbol: net.symbol });
      warnings.push(...simInfo.warnings);
    }
    const lines = [
      ...(opts.summary || []),
      ['Мережа', `${net.name} (${chain})`], ['Від', from], ['Кому', to || 'новий контракт'],
      ...(ti ? [['Токен', `${ti.symbol}${ti.name ? ' — ' + ti.name : ''}`]] : []),
      ['Сума', `${formatEther(value)} ${net.symbol}`], ...(opts.summary ? [] : desc.lines),
      ...(opts.speed && opts.speed !== 'standard' ? [['Швидкість комісії', opts.speed === 'fast' ? 'швидко (комісія вища)' : 'повільно (комісія нижча, підтвердження може затягнутись)']] : []),
      ...simInfo.lines,
      ['Ліміт газу', String(populated.gasLimit)], ['Макс. комісія', `${formatEther(fee)} ${net.symbol}`], ['Макс. разом', `${formatEther(fee + value)} ${net.symbol}`],
    ];
    await this.approve(win, origin, sameTab, { kind: 'tx', title: tr('Підтвердження транзакції'), danger: !!opts.danger || simInfo.danger || warnings.some(w => /Необмежений|ВСІ/.test(w)), lines, warnings, ...(opts.delay ? { delay: opts.delay } : {}) });
    let hash;
    try {
      const signed = await signer.signTransaction(populated);
      hash = (await signer.provider.broadcastTransaction(signed)).hash;
    } catch (e) { throw new RpcError(-32000, `Не вдалося надіслати транзакцію: ${clip(e.shortMessage || e.message, 200)}`); }
    this.trackPending(hash, chain, populated);
    this.log({ origin, action: opts.action || `Транзакція ${formatEther(value)} ${net.symbol}`, hash, chainId: chain });
    return hash;
  }

  // ---------- імена рахунків, переказ із гаманця, перевірка отримувача ----------
  rename(index, name) {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    index = Number(index);
    const clean = String(name == null ? '' : name).replace(/[\u0000-\u001f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '').trim().slice(0, 32);
    if (Number.isInteger(index) && index >= 5000) {
      const a = this._watch()[index - 5000];
      if (!a) throw new Error('Невідомий рахунок');
      a.name = clean;
      this.vault.persist();
      return clean;
    }
    if (Number.isInteger(index) && index >= 1000) {
      const a = this._imported()[index - 1000];
      if (!a) throw new Error('Невідомий рахунок');
      a.name = clean;
      this.vault.persist();
      return clean;
    }
    if (!Number.isInteger(index) || index < 0 || index >= s.addresses.length) throw new Error('Невідомий рахунок');
    s.names = s.names || [];
    while (s.names.length < s.addresses.length) s.names.push('');
    s.names[index] = clean;
    this.vault.persist();
    return clean;
  }

  rememberRecipient(addr) {
    const s = this.data();
    if (!s) return;
    s.recipients = s.recipients || [];
    if (!s.recipients.includes(addr)) { s.recipients.push(addr); if (s.recipients.length > 200) s.recipients.shift(); this.vault.persist(); }
  }

  // Попередження про отримувача: власний рахунок, нова адреса, схожа на відому адреса (address poisoning)
  recipientWarnings(to, own) {
    const s = this.section();
    const sameCase = (a) => (a.startsWith('0x') ? a.toLowerCase() : a);
    const toN = sameCase(to);
    const contacts = (s.contacts || []).map(c => c.address);
    const known = [...own, ...(s.recipients || []), ...contacts].map(sameCase);
    const warnings = [];
    let danger = false;
    if (own.map(sameCase).includes(toN)) warnings.push('Отримувач — один із ваших власних рахунків.');
    else {
      const used = [...(s.recipients || []), ...contacts].map(sameCase).includes(toN);
      if (!used) warnings.push('Ви ще не надсилали на цю адресу. Перевірте її символ за символом.');
      const pre = toN.startsWith('0x') ? 6 : 4;
      const twin = known.find(k => k !== toN && k.slice(0, pre) === toN.slice(0, pre) && k.slice(-4) === toN.slice(-4));
      if (twin) {
        warnings.push(`Адреса дуже схожа на відому вам адресу ${twin}, але не збігається з нею: це типовий прийом підміни адрес (address poisoning). Звірте всі символи.`);
        danger = true;
      }
    }
    // адреса, скопійована в цьому браузері, відрізняється від отримувача — можлива підміна в буфері обміну
    const cb = this.ctx.clipGuard && this.ctx.clipGuard.check(to);
    if (cb && cb.status === 'changed') {
      warnings.push(`Ви скопіювали в браузері адресу ${cb.copied}, а отримувач — ${to}. Якщо ви копіювали адресу отримувача, її могла підмінити шкідлива програма в буфері обміну: перевірте адресу.`);
      if (cb.similar) danger = true;
    }
    return { warnings, danger };
  }

  // Переказ основної валюти активної EVM-мережі зі сторінки гаманця (підтвердження — у довіреному вікні)
  async sendNative(win, sameTab, { index, to, amount, speed }) {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    const from = this.evmAccount(index);
    if (typeof to !== 'string' || !isAddress(to)) throw new RpcError(-32602, 'Некоректна адреса отримувача (або неправильна контрольна сума регістру).');
    const toAddr = getAddress(to);
    if (typeof amount !== 'string' || !/^\d{1,30}(\.\d{1,18})?$/.test(amount)) throw new RpcError(-32602, 'Некоректна сума.');
    const value = parseUnits(amount, 18);
    if (value <= 0n) throw new RpcError(-32602, 'Сума має бути більшою за нуль.');
    const rw = this.recipientWarnings(toAddr, this.ownEvm());
    const gate = await this.policyGate({ to: toAddr, chain: 'evm', amount });
    const warnings = [...rw.warnings, ...gate.warnings];
    const danger = rw.danger || gate.danger;
    try {
      const code = await Promise.race([this.provider(this.activeChain()).getCode(toAddr), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 6000))]);
      if (code && code !== '0x') warnings.push('Отримувач — смарт-контракт: простий переказ на контракт може бути втрачений безповоротно, якщо він не призначений приймати кошти.');
    } catch { /* RPC недоступний: перевірку пропущено */ }
    const hash = await this.sendTransaction(win, 'w3ir://wallet', { from, to: toAddr, value: '0x' + value.toString(16) }, sameTab, { internal: true, warnings, danger, speed, delay: gate.delay });
    this.rememberRecipient(toAddr);
    return hash;
  }
}

require('./wallet-solana').install(Wallet, { RpcError, isSafeRpc, clip, unauthorized });
require('./wallet-evm-tokens').install(Wallet, { RpcError, clip, unauthorized });
require('./wallet-evm-nft').install(Wallet, { RpcError, clip, unauthorized });
require('./wallet-extras').install(Wallet, { RpcError, clip, unauthorized });
require('./wallet-import').install(Wallet, { RpcError, unauthorized });
require('./wallet-safety').install(Wallet, { RpcError, unauthorized });
require('./wallet-approvals').install(Wallet, { RpcError, clip, unauthorized });
require('./wallet-portfolio').install(Wallet, { unauthorized });
require('./wallet-simulate').install(Wallet, { clip });

module.exports = { Wallet, RpcError, EVM_PATHS, BUILTIN_NETWORKS, describeCall, hexChain, isSafeRpc };
