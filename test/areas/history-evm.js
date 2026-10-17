'use strict';
// Історія EVM з журналів Transfer: ERC-20 і ERC-721, напрям, назви токенів, час блоків, межі діапазону: підставний RPC.
const http = require('http');
const E = require('ethers');
const { ok } = require('../lib');

class RpcErr extends Error { constructor(code, msg) { super(msg); this.code = code; } }

async function historyEvmTests() {
  const { FailoverProvider } = require('../../src/rpc-failover');
  const coder = E.AbiCoder.defaultAbiCoder();
  const owner = E.getAddress('0x00000000000000000000000000000000000000a1');
  const PEER = E.getAddress('0x00000000000000000000000000000000000000b2');
  const TOKEN = E.getAddress('0x00000000000000000000000000000000000000c1');
  const COLL = E.getAddress('0x00000000000000000000000000000000000000c3');
  const T = E.id('Transfer(address,address,uint256)');
  const pad = (a) => E.zeroPadValue(a, 32);
  const id7 = E.zeroPadValue('0x07', 32);
  const h = (n) => '0x' + n.toString(16).padStart(64, '0');
  const logsAll = [
    { address: TOKEN, topics: [T, pad(owner), pad(PEER)], data: coder.encode(['uint256'], [2500000n]), block: 9000, tx: h(1) },
    { address: TOKEN, topics: [T, pad(PEER), pad(owner)], data: coder.encode(['uint256'], [7000000n]), block: 9500, tx: h(2) },
    { address: COLL, topics: [T, pad(PEER), pad(owner), id7], data: '0x', block: 9800, tx: h(3) },
    { address: TOKEN, topics: [T, pad(PEER), pad(PEER)], data: coder.encode(['uint256'], [1n]), block: 9900, tx: h(4) }, // чужий переказ
  ];
  let failLogs = false;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const one = (j) => {
        const r = (result) => ({ jsonrpc: '2.0', id: j.id, result });
        switch (j.method) {
          case 'eth_chainId': return r('0x1');
          case 'eth_blockNumber': return r('0x2710');
          case 'eth_getBlockByNumber': return r({ number: j.params[0], hash: '0x' + '22'.repeat(32), parentHash: '0x' + '33'.repeat(32), timestamp: '0x' + (1700000000 + parseInt(j.params[0], 16)).toString(16), nonce: '0x0000000000000000', difficulty: '0x0', gasLimit: '0x1', gasUsed: '0x0', miner: E.ZeroAddress, extraData: '0x', transactions: [], baseFeePerGas: '0x1' });
          case 'eth_getLogs': {
            if (failLogs) return { jsonrpc: '2.0', id: j.id, error: { code: -32005, message: 'too many results' } };
            const f = j.params[0];
            const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
            const match = (l) => l.block >= from && l.block <= to && l.topics[0] === f.topics[0] && (f.topics[1] === undefined || f.topics[1] === null || l.topics[1] === f.topics[1]) && (f.topics[2] === undefined || f.topics[2] === null || l.topics[2] === f.topics[2]);
            return r(logsAll.filter(match).map((l, i) => ({ blockNumber: '0x' + l.block.toString(16), blockHash: '0x' + '11'.repeat(32), transactionIndex: '0x0', transactionHash: l.tx, logIndex: '0x' + i.toString(16), removed: false, address: l.address.toLowerCase(), topics: l.topics, data: l.data })));
          }
          case 'eth_call': {
            const { to, data } = j.params[0];
            const sel = String(data).slice(0, 10);
            if (E.getAddress(to) === TOKEN) {
              if (sel === '0x313ce567') return r(coder.encode(['uint8'], [6]));
              if (sel === '0x95d89b41') return r(coder.encode(['string'], ['USDC']));
              if (sel === '0x06fdde03') return r(coder.encode(['string'], ['USD Coin']));
            }
            return { jsonrpc: '2.0', id: j.id, error: { code: 3, message: 'execution reverted' } };
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
    constructor() { this.p = new FailoverProvider([url], net, { timeout: 4000 }); }
    data() { return {}; }
    evmView() { return owner; }
    activeChain() { return 1; }
    provider() { return this.p; }
    _ethCall(chainId, to, data) { return this.p.call({ to, data }); }
  }
  const helpers = { RpcError: RpcErr, clip: (s, n) => String(s).slice(0, n), unauthorized: (m) => new Error(m) };
  require('../../src/wallet-evm-tokens').install(FakeWallet, helpers);
  require('../../src/wallet-history-evm').install(FakeWallet, helpers);
  const w = new FakeWallet();

  const r1 = await w.evmHistory(0, { blocks: 10001, chunk: 5000 });
  ok(r1.items.length === 3 && !r1.partial, 'history-evm: знайдено лише перекази, що стосуються рахунку (чужий ігнорується)');
  ok(r1.items[0].kind === 'nft' && r1.items[0].dir === 'in' && r1.items[0].id === '7' && r1.items[0].hash === h(3), 'history-evm: найновіший — вхідний NFT (ERC-721), впорядковано від нових');
  const inc = r1.items.find(x => x.hash === h(2)), out = r1.items.find(x => x.hash === h(1));
  ok(inc && inc.dir === 'in' && inc.peer === PEER && inc.symbol === 'USDC' && inc.amount === '7.0', 'history-evm: вхідний ERC-20 з назвою токена й сумою');
  ok(out && out.dir === 'out' && out.amount === '2.5' && out.time > 0, 'history-evm: вихідний ERC-20 із сумою і часом блоку');
  const r2 = await w.evmHistory(0, { blocks: 100, chunk: 50 });
  ok(r2.items.length === 0 && r2.scanned === 100, 'history-evm: події поза діапазоном блоків не потрапляють');
  failLogs = true;
  await new Promise(r => setTimeout(r, 400)); // кеш запитів ethers (250 мс)
  const r3 = await w.evmHistory(0, { blocks: 9001, chunk: 4500 });
  ok(r3.partial === true && r3.items.length === 0, 'history-evm: відмова вузла на журналах — часткова відповідь без збою');
  failLogs = false;
  server.close();
}

module.exports = { historyEvmTests };
