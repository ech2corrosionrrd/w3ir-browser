'use strict';
// Історія рахунку EVM з журналів подій: вхідні й вихідні перекази ERC-20 і ERC-721 за останній проміжок блоків. Без індексатора
// повної історії не отримати: публічні RPC обмежують діапазон журналів, а переказ основної монети подій не залишає — тому показується
// наближена історія токенів, а для основної монети — власний журнал гаманця (зі статусами). Адреса рахунку йде лише вашим вузлам RPC.
const { getAddress, zeroPadValue, id: topicId, formatUnits } = require('ethers');

const T_TRANSFER = topicId('Transfer(address,address,uint256)');
const MAX_ITEMS = 60;
const MAX_TOKENS = 12;
const MAX_BLOCK_TIMES = 20;

function install(Wallet, { RpcError, clip, unauthorized }) {
  const proto = Wallet.prototype;
  const timed = (p, ms = 15000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
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
    for (const it of items) {
      it.time = times.get(it.block) || 0;
      if (it.kind === 'erc20') {
        const info = infos.get(it.token);
        if (info) { it.symbol = info.symbol; it.decimals = info.decimals; it.amount = formatUnits(it.raw, info.decimals); }
      }
      delete it.index;
    }
    return { chainId, items, scanned: Math.min(blocks, head + 1), partial };
  };
}

module.exports = { install, T_TRANSFER };
