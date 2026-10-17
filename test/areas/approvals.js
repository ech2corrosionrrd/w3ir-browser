'use strict';
// Список активних дозволів (ERC-20 allowance, ApprovalForAll) і їх скасування: облегшений клас-замінник гаманця + мок RPC.
const http = require('http');
const E = require('ethers');
const { ok } = require('../lib');

class RpcErr extends Error { constructor(code, msg) { super(msg); this.code = code; } }

async function approvalsTests() {
  const { FailoverProvider } = require('../../src/rpc-failover');
  const coder = E.AbiCoder.defaultAbiCoder();
  const { IFACE } = require('../../src/wallet-approvals');
  const owner = E.getAddress('0x00000000000000000000000000000000000000a1');
  const TOKEN = E.getAddress('0x00000000000000000000000000000000000000c1');
  const TOKEN2 = E.getAddress('0x00000000000000000000000000000000000000c2');
  const COLL = E.getAddress('0x00000000000000000000000000000000000000c3');
  const DEX = E.getAddress('0x00000000000000000000000000000000000000d1'); // контракт
  const SCAM = E.getAddress('0x00000000000000000000000000000000000000d2'); // звичайний рахунок
  const SAFE = E.getAddress('0x00000000000000000000000000000000000000d3'); // контракт
  const state = { allowance: { [`${TOKEN}|${DEX}`]: 2n ** 256n - 1n, [`${TOKEN}|${SCAM}`]: 500n, [`${TOKEN2}|${SAFE}`]: 0n }, all: { [`${COLL}|${DEX}`]: true, [`${COLL}|${SAFE}`]: false } };
  const T_A = E.id('Approval(address,address,uint256)'), T_ALL = E.id('ApprovalForAll(address,address,bool)');
  const pad = (a) => E.zeroPadValue(a, 32);
  const logsAll = [
    { address: TOKEN, topics: [T_A, pad(owner), pad(DEX)], data: coder.encode(['uint256'], [1n]) },
    { address: TOKEN, topics: [T_A, pad(owner), pad(SCAM)], data: coder.encode(['uint256'], [500n]) },
    { address: TOKEN2, topics: [T_A, pad(owner), pad(SAFE)], data: coder.encode(['uint256'], [0n]) },
    { address: TOKEN, topics: [T_A, pad(owner), pad(SAFE), E.zeroPadValue('0x07', 32)], data: '0x' }, // Approval ERC-721 (4 теми): ігнорується
    { address: COLL, topics: [T_ALL, pad(owner), pad(DEX)], data: coder.encode(['bool'], [true]) },
    { address: COLL, topics: [T_ALL, pad(owner), pad(SAFE)], data: coder.encode(['bool'], [true]) },
  ];
  let failLogs = false;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const one = (j) => {
        const r = (result) => ({ jsonrpc: '2.0', id: j.id, result });
        const revert = { jsonrpc: '2.0', id: j.id, error: { code: 3, message: 'execution reverted' } };
        switch (j.method) {
          case 'eth_chainId': return r('0x1');
          case 'eth_blockNumber': return r('0x2710');
          case 'eth_getCode': return r([DEX, SAFE].map(a => a.toLowerCase()).includes(String(j.params[0]).toLowerCase()) ? '0x6080' : '0x');
          case 'eth_getLogs': {
            if (failLogs) return { jsonrpc: '2.0', id: j.id, error: { code: -32005, message: 'too many results' } };
            const f = j.params[0];
            return r(logsAll.filter(l => l.topics[0] === f.topics[0] && l.topics[1] === f.topics[1]).map((l, i) => ({ blockNumber: '0x10', blockHash: '0x' + '11'.repeat(32), transactionIndex: '0x0', transactionHash: '0x' + '22'.repeat(32), logIndex: '0x' + i.toString(16), removed: false, ...l })));
          }
          case 'eth_call': {
            const { to, data } = j.params[0];
            const t = E.getAddress(to);
            const sel = String(data).slice(0, 10);
            if (sel === IFACE.getFunction('allowance').selector) { const [, sp] = coder.decode(['address', 'address'], '0x' + data.slice(10)); return r(coder.encode(['uint256'], [state.allowance[`${t}|${E.getAddress(sp)}`] || 0n])); }
            if (sel === IFACE.getFunction('isApprovedForAll').selector) { const [, op] = coder.decode(['address', 'address'], '0x' + data.slice(10)); return r(coder.encode(['bool'], [!!state.all[`${t}|${E.getAddress(op)}`]])); }
            if (t === TOKEN || t === TOKEN2) {
              if (sel === '0x313ce567') return r(coder.encode(['uint8'], [6]));
              if (sel === '0x95d89b41') return r(coder.encode(['string'], [t === TOKEN ? 'USDC' : 'DAI']));
              if (sel === '0x06fdde03') return r(coder.encode(['string'], ['Token']));
            }
            return revert;
          }
          default: return { jsonrpc: '2.0', id: j.id, error: { code: -32601, message: 'no ' + j.method } };
        }
      };
      const json = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(json) ? json.map(one) : one(json)));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const net = E.Network.from(1);
  const url = `http://127.0.0.1:${server.address().port}`;

  class FakeWallet {
    constructor() { this.s = {}; this.p = new FailoverProvider([url], net, { timeout: 4000 }); this.sent = []; this.vault = { persist() {} }; }
    section() { return this.s; }
    data() { return this.s; }
    evmAccount() { return owner; }
    evmView() { return owner; }
    activeChain() { return 1; }
    provider() { return this.p; }
    _ethCall(chainId, to, data) { return this.p.call({ to, data }); }
    network() { return { name: 'Test', chainId: 1 }; }
    async sendTransaction(win, origin, tx, sameTab, opts) { this.sent.push({ tx, opts }); return '0x' + 'cd'.repeat(32); }
  }
  const helpers = { RpcError: RpcErr, clip: (s, n) => String(s).slice(0, n), unauthorized: (m) => new Error(m) };
  require('../../src/wallet-evm-tokens').install(FakeWallet, helpers);
  require('../../src/wallet-extras').install(FakeWallet, helpers);
  require('../../src/wallet-approvals').install(FakeWallet, helpers);
  const w = new FakeWallet();
  const fails = async (fn) => { try { await fn(); return ''; } catch (e) { return e.message; } };

  const scan = await w.scanApprovals(0, { blocks: 20000, chunk: 10000 });
  ok(scan.added === 5 && !scan.partial && scan.candidates === 5 && w.s.approvalsSeen[1].length === 5, 'approvals: пошук знаходить дозволи ERC-20 і ApprovalForAll, ігнорує Approval ERC-721 (4 теми)');
  const scan2 = await w.scanApprovals(0, { blocks: 20000, chunk: 10000 });
  ok(scan2.added === 0 && w.s.approvalsSeen[1].length === 5, 'approvals: повторний пошук не дублює записи');
  const list = await w.listApprovals(0);
  const unlimited = list.items.find(x => x.kind === 'erc20' && x.spender === DEX), scam = list.items.find(x => x.kind === 'erc20' && x.spender === SCAM), nftOn = list.items.find(x => x.kind === 'nft' && x.spender === DEX);
  ok(list.total === 3 && unlimited && scam && nftOn && !list.items.some(x => x.spender === SAFE), 'approvals: у списку лише дозволи, що діють зараз (нульовий і вимкнений ApprovalForAll не показуються)');
  ok(unlimited.unlimited === true && unlimited.symbol === 'USDC' && unlimited.decimals === 6 && unlimited.spenderContract === true && unlimited.danger.length === 1 && /необмежена/.test(unlimited.danger[0]), 'approvals: необмежений дозвіл контракту позначено небезпечним із символом токена');
  ok(scam.unlimited === false && scam.amount === '0.0005' && scam.spenderContract === false && scam.danger.some(d => /звичайний рахунок/.test(d)), 'approvals: дозвіл звичайному рахунку позначено небезпечним, сума з урахуванням decimals');
  ok(nftOn.danger.some(d => /ВСІХ NFT/.test(d)) && list.items[0].danger.length >= 1, 'approvals: доступ до всіх NFT позначено небезпечним; небезпечні — угорі списку');
  failLogs = true;
  const scan3 = await w.scanApprovals(0, { blocks: 20000, chunk: 5000 });
  failLogs = false;
  ok(scan3.partial === true && scan3.added === 0, 'approvals: обмеження RPC на журнали дає «неповний» результат, а не збій');

  // скасування
  const h1 = await w.revokeApproval(null, null, { index: 0, kind: 'erc20', token: TOKEN, spender: SCAM });
  const d1 = new E.Interface(['function approve(address,uint256)']).parseTransaction({ data: w.sent[0].tx.data });
  ok(h1 && w.sent[0].tx.to === TOKEN && d1.name === 'approve' && d1.args[0] === SCAM && d1.args[1] === 0n, 'approvals: скасування ERC-20 — approve(отримувач, 0)');
  const h2 = await w.revokeApproval(null, null, { index: 0, kind: 'nft', token: COLL, spender: DEX });
  const d2 = IFACE.parseTransaction({ data: w.sent[1].tx.data });
  ok(h2 && w.sent[1].tx.to === COLL && d2.name === 'setApprovalForAll' && d2.args[0] === DEX && d2.args[1] === false && w.sent[1].opts.summary.some(l => l[0] === 'Колекція' && l[1] === COLL), 'approvals: скасування NFT — setApprovalForAll(оператор, false) із підтвердженням');
  ok(/уже не діє/.test(await fails(() => w.revokeApproval(null, null, { index: 0, kind: 'nft', token: COLL, spender: SAFE }))) && /уже нульовий/.test(await fails(() => w.revokeApproval(null, null, { index: 0, kind: 'erc20', token: TOKEN2, spender: SAFE }))) && w.sent.length === 2, 'approvals: уже скасований дозвіл повторно не скасовується (без транзакції)');
  ok(/Некоректна/.test(await fails(() => w.revokeApproval(null, null, { index: 0, kind: 'nft', token: '0x123', spender: DEX }))) && /Некоректна/.test(await fails(() => w.revokeApproval(null, null, { index: 0, kind: 'nft', token: COLL, spender: 'сміття' }))), 'approvals: некоректні адреси відхиляються');

  server.closeAllConnections(); server.close();
}

module.exports = { approvalsTests };
