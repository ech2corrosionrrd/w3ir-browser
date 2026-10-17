'use strict';
// Симуляція транзакцій EVM до підпису (eth_simulateV1 на вузлі RPC): що піде з вашого рахунку, що прийде, які дозволи видаються
// і чи завершиться виклик помилкою. Вузол — недовірене джерело, тому це підказка в підтвердженні, а не гарантія: якщо вузол
// не підтримує метод (частина публічних RPC) або не відповів, симуляції просто немає й транзакція не блокується.
const { Interface, getAddress, formatEther, formatUnits, MaxUint256 } = require('ethers');

const ETH_PSEUDO = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const T_TRANSFER = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']).getEvent('Transfer').topicHash;
const T_APPROVAL = new Interface(['event Approval(address indexed owner, address indexed spender, uint256 value)']).getEvent('Approval').topicHash;
const T_APPROVAL_ALL = new Interface(['event ApprovalForAll(address indexed owner, address indexed operator, bool approved)']).getEvent('ApprovalForAll').topicHash;
const I1155 = new Interface(['event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)', 'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)']);
const T_SINGLE = I1155.getEvent('TransferSingle').topicHash;
const T_BATCH = I1155.getEvent('TransferBatch').topicHash;
const UNLIMITED = MaxUint256 >> 1n;
const MAX_ITEMS = 12;
const ERROR_SEL = '0x08c379a0', PANIC_SEL = '0x4e487b71';

const addrOf = (topic) => getAddress('0x' + String(topic).slice(-40));
const same = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();

function revertReason(data) {
  try {
    if (typeof data !== 'string' || data.length < 10) return '';
    if (data.startsWith(ERROR_SEL)) return new Interface(['function Error(string)']).decodeFunctionData('Error', data)[0];
    if (data.startsWith(PANIC_SEL)) return `Panic(0x${BigInt('0x' + data.slice(10) || '0').toString(16)})`;
  } catch { /* нестандартна причина */ }
  return '';
}

// Розбір відповіді eth_simulateV1 для рахунку owner → { ok, error, out: [...], inn: [...], approvals: [...], gasUsed }
function parseSimulation(result, owner) {
  const call = result && result[0] && result[0].calls && result[0].calls[0];
  if (!call) throw new Error('empty simulation response');
  const out = [], inn = [], approvals = [];
  const add = (list, item) => { if (list.length < MAX_ITEMS) list.push(item); };
  const failed = call.status === '0x0' || call.status === 0 || !!call.error;
  for (const l of Array.isArray(call.logs) ? call.logs : []) {
    const t = l.topics || [];
    try {
      const contract = getAddress(l.address);
      if (t[0] === T_TRANSFER && t.length === 3) {
        const from = addrOf(t[1]), to = addrOf(t[2]), value = BigInt(l.data || '0x0');
        const native = l.address.toLowerCase() === ETH_PSEUDO;
        const item = native ? { kind: 'native', value } : { kind: 'erc20', token: contract, value };
        if (same(from, owner) && !same(to, owner)) add(out, item);
        else if (same(to, owner) && !same(from, owner)) add(inn, item);
      } else if (t[0] === T_TRANSFER && t.length === 4) {
        const from = addrOf(t[1]), to = addrOf(t[2]), id = BigInt(t[3]);
        const item = { kind: 'nft721', token: contract, id };
        if (same(from, owner) && !same(to, owner)) add(out, item);
        else if (same(to, owner) && !same(from, owner)) add(inn, item);
      } else if (t[0] === T_SINGLE && t.length === 4) {
        const p = I1155.parseLog({ topics: t, data: l.data });
        const item = { kind: 'nft1155', token: contract, id: p.args.id, value: p.args.value };
        if (same(p.args.from, owner) && !same(p.args.to, owner)) add(out, item);
        else if (same(p.args.to, owner) && !same(p.args.from, owner)) add(inn, item);
      } else if (t[0] === T_BATCH && t.length === 4) {
        const p = I1155.parseLog({ topics: t, data: l.data });
        p.args.ids.forEach((id, i) => {
          const item = { kind: 'nft1155', token: contract, id, value: p.args.values[i] };
          if (same(p.args.from, owner) && !same(p.args.to, owner)) add(out, item);
          else if (same(p.args.to, owner) && !same(p.args.from, owner)) add(inn, item);
        });
      } else if (t[0] === T_APPROVAL && t.length === 3 && same(addrOf(t[1]), owner)) {
        add(approvals, { kind: 'erc20', token: contract, spender: addrOf(t[2]), value: BigInt(l.data || '0x0') });
      } else if (t[0] === T_APPROVAL_ALL && t.length === 3 && same(addrOf(t[1]), owner)) {
        add(approvals, { kind: 'all', token: contract, spender: addrOf(t[2]), approved: BigInt(l.data || '0x0') !== 0n });
      }
    } catch { /* пошкоджений запис журналу пропускаємо */ }
  }
  return { ok: !failed, error: failed ? (revertReason(call.returnData) || (call.error && call.error.message) || '') : '', out, inn, approvals, gasUsed: call.gasUsed ? BigInt(call.gasUsed) : null };
}

function install(Wallet, { clip }) {
  const proto = Wallet.prototype;
  const timed = (p, ms = 9000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

  // Повертає розібраний результат або null, якщо жоден вузол не підтримує симуляцію / не відповів.
  // Вузли пробуються по черзі (не всі публічні RPC мають eth_simulateV1), а не лише перший.
  proto.simulateEvm = async function (chainId, { from, to, value, data }) {
    let provider;
    try { provider = this.provider(chainId); } catch { return null; }
    const nodes = provider._nodes ? provider._nodes.map(n => n.p) : [provider];
    const call = { from, to, data, value: '0x' + BigInt(value || 0n).toString(16) }; // без ведучих нулів: суворі вузли їх відхиляють
    for (const node of nodes) {
      try {
        const res = await timed(node.send('eth_simulateV1', [{ blockStateCalls: [{ calls: [call] }], traceTransfers: true, validation: false }, 'latest']), 8000);
        return parseSimulation(res, from);
      } catch { /* вузол не підтримує метод чи не відповів: наступний */ }
    }
    return null;
  };

  // Рядки й попередження для вікна підтвердження
  proto.describeSimulation = async function (chainId, sim, { symbol }) {
    const lines = [], warnings = [];
    let danger = false;
    if (!sim) return { lines: [['Симуляція', 'недоступна на цьому вузлі RPC: перевіряйте дані самі']], warnings, danger };
    const tokenOf = async (a) => { try { return await timed(this.tokenInfo(chainId, a), 5000); } catch { return null; } };
    const fmt = async (it) => {
      if (it.kind === 'native') return `${formatEther(it.value)} ${symbol}`;
      if (it.kind === 'erc20') { const ti = await tokenOf(it.token); return ti ? `${formatUnits(it.value, ti.decimals)} ${ti.symbol} (${clip(it.token, 12)})` : `${it.value} (токен ${it.token})`; }
      if (it.kind === 'nft721') return `NFT #${clip(it.id.toString(), 20)} (${clip(it.token, 12)})`;
      return `NFT #${clip(it.id.toString(), 20)} × ${it.value} (${clip(it.token, 12)})`;
    };
    if (!sim.ok) {
      lines.push(['Симуляція', `ПОМИЛКА: виклик не вдасться${sim.error ? ' (' + clip(sim.error, 120) + ')' : ''}`]);
      warnings.push('Симуляція показує, що транзакція завершиться помилкою: газ буде витрачено даремно. Не підтверджуйте, якщо не розумієте причини.');
      return { lines, warnings, danger: true };
    }
    lines.push(['Симуляція', 'виклик виконується успішно']);
    if (sim.out.length) lines.push(['З вашого рахунку піде', (await Promise.all(sim.out.map(fmt))).join('; ')]);
    if (sim.inn.length) lines.push(['На ваш рахунок прийде', (await Promise.all(sim.inn.map(fmt))).join('; ')]);
    if (!sim.out.length && !sim.inn.length) lines.push(['Рух активів', 'не виявлено (за журналами подій)']);
    if (sim.out.length && !sim.inn.length) warnings.push('За симуляцією з вашого рахунку підуть активи, а нічого не прийде. Підтверджуйте лише якщо це продаж, пожертва чи інша дія, яку ви свідомо робите.');
    for (const a of sim.approvals) {
      if (a.kind === 'all') {
        lines.push(['Дозвіл', a.approved ? `ДОСТУП до ВСІХ NFT колекції ${clip(a.token, 12)} для ${a.spender}` : `скасування доступу до NFT колекції ${clip(a.token, 12)}`]);
        if (a.approved) { warnings.push('Ця транзакція дає доступ до ВСІХ ваших NFT колекції: оператор зможе їх забрати.'); danger = true; }
      } else {
        const unl = a.value >= UNLIMITED;
        const ti = await tokenOf(a.token);
        lines.push(['Дозвіл', `${unl ? 'НЕОБМЕЖЕНО' : (ti ? formatUnits(a.value, ti.decimals) : a.value.toString())} ${ti ? ti.symbol : 'токенів'} для ${a.spender}`]);
        if (unl) { warnings.push('Ця транзакція видає необмежений дозвіл витрачати ваші токени.'); danger = true; }
      }
    }
    return { lines, warnings, danger };
  };
}

module.exports = { install, parseSimulation, revertReason, ETH_PSEUDO };
