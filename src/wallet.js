// @ts-check
'use strict';
const { FailoverProvider } = require('./rpc-failover');

/**
 * @typedef {Object} EvmNetwork
 * @property {number} chainId
 * @property {string} name
 * @property {string} symbol
 * @property {string} rpc
 * @property {string[]} [rpcFallback]
 * @property {string} [explorer]
 *
 * @typedef {Object} EvmAccount
 * @property {string} address
 * @property {string} name
 * @property {number} index
 * @property {boolean} [imported]
 * @property {boolean} [viewOnly]
 */
// Вбудований EVM-гаманець (EIP-1193 / EIP-6963). Фраза відновлення зберігається всередині зашифрованого сховища паролів
// (AES-256-GCM + scrypt + DPAPI); приватні ключі виводяться лише на мить підпису й ніколи не кешуються.
// Кожен підпис і транзакція потребують явного підтвердження у довіреному вікні браузера, яке сторінка підробити не може.
const {
  Mnemonic, HDNodeWallet, JsonRpcProvider, Network, formatEther, getAddress, isAddress,
  randomBytes, MaxUint256, Interface, parseUnits, formatUnits,
} = require('ethers');

const BUILTIN_NETWORKS = [
  { chainId: 1, name: 'Ethereum', symbol: 'ETH', rpc: 'https://ethereum-rpc.publicnode.com', rpcFallback: ['https://1rpc.io/eth', 'https://eth.drpc.org', 'https://rpc.mevblocker.io'], explorer: 'https://etherscan.io' },
  { chainId: 10, name: 'Optimism', symbol: 'ETH', rpc: 'https://mainnet.optimism.io', explorer: 'https://optimistic.etherscan.io' },
  { chainId: 56, name: 'BNB Smart Chain', symbol: 'BNB', rpc: 'https://bsc-dataseed.binance.org', explorer: 'https://bscscan.com' },
  { chainId: 137, name: 'Polygon', symbol: 'POL', rpc: 'https://polygon-bor-rpc.publicnode.com', rpcFallback: ['https://1rpc.io/matic', 'https://polygon.drpc.org'], explorer: 'https://polygonscan.com' },
  { chainId: 8453, name: 'Base', symbol: 'ETH', rpc: 'https://mainnet.base.org', explorer: 'https://basescan.org' },
  { chainId: 42161, name: 'Arbitrum One', symbol: 'ETH', rpc: 'https://arb1.arbitrum.io/rpc', explorer: 'https://arbiscan.io' },
  { chainId: 43114, name: 'Avalanche C-Chain', symbol: 'AVAX', rpc: 'https://api.avax.network/ext/bc/C/rpc', explorer: 'https://snowtrace.io' },
  { chainId: 11155111, name: 'Sepolia (тестова)', symbol: 'ETH', rpc: 'https://ethereum-sepolia-rpc.publicnode.com', rpcFallback: ['https://1rpc.io/sepolia', 'https://sepolia.drpc.org'], explorer: 'https://sepolia.etherscan.io' },
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
  // «Прихований» гаманець: дані лишаються у сховищі, але гаманця немає ні в меню, ні на стартовій сторінці й панелі, сайти його не бачать,
  // а сторінка гаманця показує лише кнопку «Показати» (потрібен майстер-пароль)
  hidden() { return this.ctx.cfg().walletHidden === true; }
  // Через скільки після останнього введення майстер-пароля гаманець знову його просить для підтверджень (2, 5, 10 або 15 хв; типово 2)
  reauthMs() { const m = Number(this.ctx.cfg().walletReauthMinutes); return ([2, 5, 10, 15].includes(m) ? m : 2) * 60000; }
  injectEnabled() { return this.exists() && !this.hidden() && this.ctx.cfg().walletInject !== false; }
  setHidden(on) {
    const cfg = this.ctx.cfg();
    if (!!on === (cfg.walletHidden === true)) return false;
    cfg.walletHidden = !!on;
    this.ctx.settingsStore.save();
    // сайти одразу перестають бачити рахунки (як при блокуванні сховища); при показі підключення повертаються
    try {
      if (on) {
        for (const origin of Object.keys(this._lastConns || {})) this.emit(origin, 'accountsChanged', []);
        for (const origin of Object.keys(this._lastSolConns || {})) this.emit(origin, 'sol:disconnect', null);
      } else this.onVaultChange();
    } catch { /* ignore */ }
    this.ctx.pushAll();
    return true;
  }
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
    if (!s.policy) s.policy = { siteDays: 30 }; // новий гаманець: сайти, якими не користуються 30 днів, відключаються (змінюється в режимах обережності)
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
      try { return { address: a, balance: formatEther(await Promise.race([p.getBalance(a), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 15000))])), symbol: net.symbol }; }
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
      if (entry && entry.hash) this.watchTx(entry); // сповіщення про результат транзакції
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
require('./wallet-dapp').install(Wallet, { RpcError, rejected, unauthorized, clip, hexChain, isSafeRpc, READ_METHODS, describeCall });
require('./wallet-safety').install(Wallet, { RpcError, unauthorized });
require('./wallet-approvals').install(Wallet, { RpcError, clip, unauthorized });
require('./wallet-history-evm').install(Wallet, { RpcError, clip, unauthorized });
require('./wallet-portfolio').install(Wallet, { unauthorized });
require('./wallet-simulate').install(Wallet, { clip });
require('./wallet-watch').install(Wallet);

module.exports = { Wallet, RpcError, EVM_PATHS, BUILTIN_NETWORKS, describeCall, hexChain, isSafeRpc };
