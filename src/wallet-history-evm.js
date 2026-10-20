'use strict';
// Історія рахунку EVM з журналів подій: вхідні й вихідні перекази ERC-20 і ERC-721 за останній проміжок блоків. Без індексатора
// повної історії не отримати: публічні RPC обмежують діапазон журналів, а переказ основної монети подій не залишає — тому показується
// наближена історія токенів, а для основної монети — власний журнал гаманця (зі статусами). Адреса рахунку йде лише вашим вузлам RPC.
const { getAddress, zeroPadValue, id: topicId, formatUnits } = require('ethers');
const { BUILTIN } = require('./wallet-evm-tokens');

const T_TRANSFER = topicId('Transfer(address,address,uint256)');
const MAX_ITEMS = 60;
const MAX_TOKENS = 12;
const MAX_BLOCK_TIMES = 20;
// Назви токенів-розсилок: посилання, «claim», «reward» тощо — шахраї вставляють їх у назву, щоб заманити на свій сайт
const SPAM_NAME = /https?:|www\.|\.(com|io|net|org|xyz|app|cc|vip|top|ltd|club|site|online|info)\b|t\.me|claim|reward|airdrop|voucher|bonus|gift|visit|free\b/i;

// Клітинка CSV: лапки подвоюються, а початок на = + - @ нейтралізується (назви токенів задають чужі люди: захист від формул у таблицях)
function csvCell(v) {
  let t = String(v === undefined || v === null ? '' : v);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return /[",\n\r;]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}
function toCsv(items, { network = '', tr = (x) => x } = {}) {
  const head = ['Час (UTC)', 'Мережа', 'Напрям', 'Тип', 'Токен/колекція', 'Символ', 'Кількість/ID', 'Контрагент', "Ім'я контакту", 'Підозріле', 'Транзакція'];
  const rows = items.map(it => [
    it.time ? new Date(it.time).toISOString() : '', network, it.dir === 'in' ? tr('Отримано') : tr('Надіслано'), it.kind === 'nft' ? 'NFT' : 'ERC-20',
    it.token, it.symbol || '', it.kind === 'nft' ? it.id : (it.amount !== undefined ? it.amount : it.raw), it.peer, it.peerName || '', it.suspicious ? tr('так') : '', it.hash,
  ]);
  return '\uFEFF' + [head.map(h => tr(h)), ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function install(Wallet, { RpcError, clip, unauthorized }) {
  const proto = Wallet.prototype;
  const timed = (p, ms = 15000) => {
    let t;
    return Promise.race([
      p,
      new Promise((_, rej) => {
        t = setTimeout(() => rej(new Error('timeout')), ms);
        if (t.unref) t.unref();
      }),
    ]).finally(() => { if (t) clearTimeout(t); });
  };
  const topicAddr = (t) => getAddress('0x' + String(t).slice(-40));

  proto.evmHistory = async function (index, { blocks = 60000, chunk = 5000, parallel = 3, maxLogs = 600 } = {}) {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    const owner = this.evmView(index);
    const chainId = this.activeChain();
    const provider = this.provider(chainId);
    let head;
    try { head = await timed(provider.getBlockNumber(), 8000); } catch (e) { throw new RpcError(-32000, `Не вдалося отримати номер блоку: ${clip(e.message, 120)}`); }
    const ownerTopic = zeroPadValue(owner, 32);
    const ranges = [];
    for (let to = head; to > head - blocks && to >= 0; to -= chunk) ranges.push([Math.max(0, to - chunk + 1), to]);
    const found = new Map();
    let partial = false;
    const scan = async ([from, to]) => {
      if (partial || found.size >= maxLogs) return;
      try {
        const [out, inc] = await timed(Promise.all([
          provider.getLogs({ fromBlock: from, toBlock: to, topics: [T_TRANSFER, ownerTopic] }),
          provider.getLogs({ fromBlock: from, toBlock: to, topics: [T_TRANSFER, null, ownerTopic] }),
        ]), 25000);
        for (const [list, dir] of [[out, 'out'], [inc, 'in']]) {
          for (const l of list) {
            if (l.topics.length !== 3 && l.topics.length !== 4) continue; // ERC-20 (3 теми) або ERC-721 (4 теми)
            const nft = l.topics.length === 4;
            const peer = topicAddr(dir === 'out' ? l.topics[2] : l.topics[1]);
            const item = { hash: String(l.transactionHash), block: Number(l.blockNumber), index: Number(l.index), dir, kind: nft ? 'nft' : 'erc20', token: getAddress(l.address), peer };
            if (nft) item.id = BigInt(l.topics[3]).toString();
            else if (/^0x[0-9a-fA-F]{64}$/.test(String(l.data))) item.raw = BigInt(l.data).toString();
            else continue;
            found.set(`${item.hash}|${item.index}`, item);
          }
        }
      } catch { partial = true; }
    };
    for (let i = 0; i < ranges.length && !partial; i += parallel) await Promise.all(ranges.slice(i, i + parallel).map(scan));
    const items = [...found.values()].sort((a, b) => (b.block - a.block) || (b.index - a.index)).slice(0, MAX_ITEMS);

    // назви токенів (лише для тих, що потрапили у вибірку) і час блоків
    const tokens = [...new Set(items.filter(x => x.kind === 'erc20').map(x => x.token))].slice(0, MAX_TOKENS);
    const infos = new Map();
    await Promise.all(tokens.map(async (t) => { try { infos.set(t, await this.tokenInfo(chainId, t)); } catch { /* не схоже на токен */ } }));
    const times = new Map();
    const blockNums = [...new Set(items.map(x => x.block))].slice(0, MAX_BLOCK_TIMES);
    await Promise.all(blockNums.map(async (n) => { try { const b = await timed(provider.getBlock(n), 6000); if (b) times.set(n, Number(b.timestamp) * 1000); } catch { /* час необов'язковий */ } }));
    const names = new Map(((s.contacts || [])).filter(c => c && c.address).map(c => [String(c.address).toLowerCase(), c.name]));
    const known = new Set([...(BUILTIN[chainId] || []).map(([a]) => a), ...((this._customTokens ? this._customTokens(chainId) : []).map(c => c.address))].map(a => String(a).toLowerCase()));
    const sentTokens = new Set(items.filter(x => x.dir === 'out').map(x => x.token));
    for (const it of items) {
      it.time = times.get(it.block) || 0;
      it.peerName = names.get(it.peer.toLowerCase()) || '';
      if (it.kind === 'erc20') {
        const info = infos.get(it.token);
        if (info) { it.symbol = info.symbol; it.decimals = info.decimals; it.amount = formatUnits(it.raw, info.decimals); }
        // розсилка: токен чужий (не вбудований і не доданий вами), прийшов від невідомої адреси, ви його не відправляли — або назва схожа на рекламу
        const label = info ? `${info.symbol} ${info.name}` : '';
        it.suspicious = it.dir === 'in' && ((SPAM_NAME.test(label) && !it.peerName) || (!known.has(it.token.toLowerCase()) && !it.peerName && !sentTokens.has(it.token)));
      } else it.suspicious = false;
      delete it.index;
    }
    this._historyCache = this._historyCache || new Map();
    this._historyCache.set(`${chainId}|${owner}`, { chainId, items });
    return { chainId, items, scanned: Math.min(blocks, head + 1), partial };
  };

  proto.evmHistoryCsv = function (index, tr) {
    const data = this.data();
    if (!data) throw unauthorized('Гаманець не створено');
    const owner = this.evmView(index);
    const chainId = this.activeChain();
    const hit = this._historyCache && this._historyCache.get(`${chainId}|${owner}`);
    if (!hit) throw new RpcError(-32602, 'Спершу відкрийте історію цього рахунку.');
    const net = this.network(chainId);
    return toCsv(hit.items, { network: net ? net.name : String(chainId), tr });
  };
}

// CSV історії для експорту: останній результат пошуку цього рахунку (без повторного сканування)
module.exports = { install, T_TRANSFER, toCsv, csvCell };
