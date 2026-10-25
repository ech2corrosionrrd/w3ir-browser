// @ts-check
'use strict';
// Чисті структури, константи та допоміжні функції ядра EVM-гаманця (EIP-1193, EIP-1559, деривація, виклики контрактів).
const {
  getAddress, MaxUint256, Interface, formatUnits,
} = require('ethers');

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
const EVM_PATHS = {
  standard: (i) => `m/44'/60'/0'/0/${i}`,
  ledgerLive: (i) => `m/44'/60'/${i}'/0/0`,
  legacy: (i) => `m/44'/60'/0'/${i}`,
};

// Лише читання — проксуємо до RPC вибраної мережі
const READ_METHODS = new Set([
  'eth_call', 'eth_blockNumber', 'eth_getBalance', 'eth_getCode', 'eth_getLogs', 'eth_getTransactionByHash', 'eth_getTransactionReceipt',
  'eth_getTransactionCount', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory',
  'eth_estimateGas', 'eth_getStorageAt', 'eth_getBlockTransactionCountByNumber', 'eth_getBlockTransactionCountByHash',
]);

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

const rejected = () => new RpcError(4001, 'Користувач відхилив запит');
const unauthorized = (m) => new RpcError(4100, m || 'Сайт не підключено до гаманця');

const { isPublicIp } = require('./safe-fetch');

const clip = (s, n) => {
  s = String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
};

const hexChain = (id) => '0x' + Number(id).toString(16);

function isSafeRpc(url) {
  try {
    const u = new URL(url);
    if (u.username || u.password) return false;
    // Локальні вузли розробки на localhost / 127.0.0.1
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1') {
      return u.protocol === 'http:' || u.protocol === 'https:';
    }
    // Зовнішні RPC вимагають суворо https та публічної IP-адреси (захист від SSRF, приватних підмереж та cloud metadata)
    if (u.protocol !== 'https:') return false;
    // Якщо hostname є IP-адресою, перевіряємо публічність безпосередньо
    if (/^(\d+\.){3}\d+$|^\[[0-9a-f:]+\]$/i.test(u.hostname)) {
      return isPublicIp(u.hostname.replace(/^\[|\]$/g, ''));
    }
    return true;
  } catch {
    return false;
  }
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
  try {
    parsed = IFACE.parseTransaction({ data });
  } catch {
    /* невідомий метод */
  }
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
      case 'transfer':
        out.token = true;
        out.lines.push(['Дія', 'Переказ токенів'], ['Отримувач', getAddress(a[0])], ['Кількість', human(a[1])]);
        out.spend = { to: getAddress(a[0]), amount: a[1] };
        break;
      case 'transferFrom':
      case 'safeTransferFrom':
        out.token = parsed.name === 'transferFrom';
        out.lines.push(['Дія', 'Переказ токена/NFT'], ['Від', getAddress(a[0])], ['Кому', getAddress(a[1])], ['Токен/кількість', ti && parsed.name === 'transferFrom' ? human(a[2]) : a.length >= 5 ? `#${a[2]} × ${a[3]}` : a[2].toString()]);
        // Ліміти застосовуються, лише якщо токени йдуть зі СВОГО рахунку (from збігається з відправником транзакції)
        if (parsed.name === 'transferFrom') out.spend = { to: getAddress(a[1]), amount: a[2], from: getAddress(a[0]) };
        else out.nft = { to: getAddress(a[1]), from: getAddress(a[0]) };
        break;
      default:
        break;
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

module.exports = {
  BUILTIN_NETWORKS,
  EVM_PATHS,
  READ_METHODS,
  RpcError,
  rejected,
  unauthorized,
  clip,
  hexChain,
  isSafeRpc,
  IFACE,
  describeCall,
};
