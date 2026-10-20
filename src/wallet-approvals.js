'use strict';
// Список активних дозволів: які адреси можуть витрачати ваші токени ERC-20 (allowance) чи всі NFT колекції (ApprovalForAll).
// Кандидатів знаходимо в журналах Approval/ApprovalForAll за останній проміжок блоків (публічні RPC обмежують діапазон, тож
// пошук наближений), а ПОТОЧНИЙ стан завжди читається з контрактів. Скасування — окрема транзакція з підтвердженням.
const { Interface, getAddress, isAddress, zeroPadValue, id: topicId, MaxUint256, formatUnits, ZeroAddress } = require('ethers');
const { KNOWN_SPENDERS } = require('./wallet-signguard');

const T_APPROVAL = topicId('Approval(address,address,uint256)');
const T_APPROVAL_ALL = topicId('ApprovalForAll(address,address,bool)');
const IFACE = new Interface([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
]);
const MAX_SEEN = 300;
const MAX_LISTED = 60;
const UNLIMITED = MaxUint256 >> 1n;
const LABELS = KNOWN_SPENDERS;

function install(Wallet, { RpcError, clip, unauthorized }) {
  const proto = Wallet.prototype;
  const timed = (p, ms = 15000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  const seenList = (w, chainId) => { const s = w.section(); s.approvalsSeen = s.approvalsSeen || {}; return (s.approvalsSeen[chainId] = s.approvalsSeen[chainId] || []); };
  const topicAddr = (t) => getAddress('0x' + String(t).slice(-40));

  // Пошук кандидатів серед недавніх подій (зберігаються як пари токен/адреса; стан перевіряється окремо)
  proto.scanApprovals = async function (index, { blocks = 120000, chunk = 10000, parallel = 3, maxLogs = 3000 } = {}) {
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
    let partial = false, seen = 0;
    const scan = async ([from, to]) => {
      if (partial || seen >= maxLogs) return;
      try {
        const [a, b] = await timed(Promise.all([
          provider.getLogs({ fromBlock: from, toBlock: to, topics: [T_APPROVAL, ownerTopic] }),
          provider.getLogs({ fromBlock: from, toBlock: to, topics: [T_APPROVAL_ALL, ownerTopic] }),
        ]), 25000);
        for (const l of a) { if (l.topics.length !== 3) continue; seen++; const sp = topicAddr(l.topics[2]); found.set(`erc20|${getAddress(l.address)}|${sp}`, { kind: 'erc20', token: getAddress(l.address), spender: sp }); }
        for (const l of b) { if (l.topics.length !== 3) continue; seen++; const op = topicAddr(l.topics[2]); found.set(`nft|${getAddress(l.address)}|${op}`, { kind: 'nft', token: getAddress(l.address), spender: op }); }
      } catch { partial = true; }
    };
    for (let i = 0; i < ranges.length && !partial; i += parallel) await Promise.all(ranges.slice(i, i + parallel).map(scan));
    const list = seenList(this, chainId);
    let added = 0;
    for (const e of found.values()) {
      if (list.length >= MAX_SEEN) { partial = true; break; }
      if (!list.some(x => x.kind === e.kind && x.token === e.token && x.spender === e.spender)) { list.push(e); added++; }
    }
    if (added) this.vault.persist();
    return { chainId, added, scanned: Math.min(blocks, head + 1), partial, candidates: found.size };
  };

  // Поточні дозволи зі збережених пар: лише ті, що діють зараз
  proto.listApprovals = async function (index, { max = MAX_LISTED } = {}) {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    const owner = this.evmView(index);
    const chainId = this.activeChain();
    const pairs = seenList(this, chainId).slice(0, 200);
    const provider = this.provider(chainId);
    const codeCache = new Map();
    const isContract = async (a) => {
      if (!codeCache.has(a)) codeCache.set(a, timed(provider.getCode(a), 5000).then(c => !!c && c !== '0x', () => null));
      return codeCache.get(a);
    };
    const items = [];
    const check = async (e) => {
      try {
        let item;
        if (e.kind === 'erc20') {
          const cur = IFACE.decodeFunctionResult('allowance', await this._ethCall(chainId, e.token, IFACE.encodeFunctionData('allowance', [owner, e.spender])))[0];
          if (cur === 0n) return;
          const info = await this.tokenInfo(chainId, e.token);
          item = { kind: 'erc20', token: e.token, symbol: info.symbol, name: info.name, decimals: info.decimals, spender: e.spender, raw: cur.toString(), amount: formatUnits(cur, info.decimals), unlimited: cur >= UNLIMITED };
        } else {
          const ok = IFACE.decodeFunctionResult('isApprovedForAll', await this._ethCall(chainId, e.token, IFACE.encodeFunctionData('isApprovedForAll', [owner, e.spender])))[0];
          if (!ok) return;
          item = { kind: 'nft', token: e.token, symbol: '', name: '', decimals: 0, spender: e.spender, raw: '', amount: '', unlimited: true };
        }
        item.label = LABELS.get(e.spender.toLowerCase()) || '';
        item.spenderContract = await isContract(e.spender);
        item.danger = [];
        if (item.unlimited) item.danger.push(e.kind === 'nft' ? 'доступ до ВСІХ NFT колекції' : 'необмежена сума');
        if (item.spenderContract === false) item.danger.push('отримувач — звичайний рахунок, а не контракт');
        items.push(item);
      } catch { /* контракт недоступний або не схожий на токен: пропускаємо */ }
    };
    for (let i = 0; i < pairs.length; i += 8) await Promise.all(pairs.slice(i, i + 8).map(check));
    items.sort((a, b) => (b.danger.length - a.danger.length) || (a.symbol || '').localeCompare(b.symbol || ''));
    return { chainId, items: items.slice(0, max), total: items.length, saved: pairs.length };
  };

  // Скасування: ERC-20 — approve(spender, 0); NFT — setApprovalForAll(operator, false)
  proto.revokeApproval = async function (win, sameTab, { index, kind, token, spender }) {
    if (kind !== 'nft') return this.revokeAllowance(win, sameTab, { index, token, spender });
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    const owner = this.evmAccount(index);
    if (typeof token !== 'string' || !isAddress(token) || typeof spender !== 'string' || !isAddress(spender)) throw new RpcError(-32602, 'Некоректна адреса колекції чи оператора.');
    const chainId = this.activeChain();
    const coll = getAddress(token), op = getAddress(spender);
    if (op === ZeroAddress) throw new RpcError(-32602, 'Некоректна адреса оператора.');
    let on;
    try { on = IFACE.decodeFunctionResult('isApprovedForAll', await this._ethCall(chainId, coll, IFACE.encodeFunctionData('isApprovedForAll', [owner, op])))[0]; }
    catch (e) { throw new RpcError(-32000, `Не вдалося прочитати дозвіл: ${clip(e.shortMessage || e.message, 160)}`); }
    if (!on) throw new RpcError(-32602, 'Цей дозвіл уже не діє: скасовувати нічого.');
    const net = this.network(chainId);
    const summary = [['Дія', 'Скасування доступу до ВСІХ NFT колекції (setApprovalForAll: false)'], ['Колекція', coll], ['Оператор, якому скасовується доступ', op], ['Мережа', `${net.name} (${chainId})`]];
    return this.sendTransaction(win, 'w3ir://wallet', { from: owner, to: coll, data: IFACE.encodeFunctionData('setApprovalForAll', [op, false]) }, sameTab, { internal: true, summary, action: 'Скасування доступу до NFT колекції' });
  };
}

module.exports = { install, IFACE };
