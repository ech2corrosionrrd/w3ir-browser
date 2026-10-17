'use strict';
// NFT на EVM (ERC-721/1155), безпечне завантаження метаданих і зображень, ціни в USD. Без Electron-вікон: модуль
// встановлюється на облегшений клас-замінник гаманця, а мережа — локальний мок RPC.
const http = require('http');
const E = require('ethers');
const { ok } = require('../lib');

class RpcErr extends Error { constructor(code, msg) { super(msg); this.code = code; } }

async function nftTests() {
  const nft = require('../../src/wallet-evm-nft');
  const meta = require('../../src/nft-meta');
  const { Prices } = require('../../src/prices');
  const { FailoverProvider } = require('../../src/rpc-failover');
  const coder = E.AbiCoder.defaultAbiCoder();
  const I721 = nft.ERC721, I1155 = nft.ERC1155;
  const owner = E.getAddress('0x00000000000000000000000000000000000000a1');
  const other = E.getAddress('0x00000000000000000000000000000000000000b2');
  const C721 = E.getAddress('0x0000000000000000000000000000000000000c01');
  const C1155 = E.getAddress('0x0000000000000000000000000000000000000c02');
  const CPLAIN = E.getAddress('0x0000000000000000000000000000000000000c03');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>';
  const jsonUri = (o) => 'data:application/json;base64,' + Buffer.from(JSON.stringify(o)).toString('base64');
  const contracts = {
    [C721.toLowerCase()]: { supports: ['0x80ac58cd'], owners: { 1: owner, 2: other, 3: owner }, symbol: 'COOL', uris: {
      1: jsonUri({ name: 'Cool #1\u202E', image: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64') }),
      2: 'https://evil.example/2.json',
      3: jsonUri({ name: 'Page', image: jsonUri({ x: 1 }) }) } },
    [C1155.toLowerCase()]: { supports: ['0xd9b67a26'], balances: { [owner + '|7']: 3n }, uri: jsonUri({ name: 'Item {id}' }) },
    [CPLAIN.toLowerCase()]: { supports: [] },
  };
  let logs = [];
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
          case 'eth_getCode': return r(String(j.params[0]).toLowerCase() === C721.toLowerCase() ? '0x6080' : '0x');
          case 'eth_getLogs': {
            if (failLogs) return { jsonrpc: '2.0', id: j.id, error: { code: -32005, message: 'query returned more than 10000 results' } };
            const f = j.params[0];
            return r(logs.filter(l => l.topics[0] === f.topics[0]).map((l, i) => ({ blockNumber: '0x10', blockHash: '0x' + '11'.repeat(32), transactionIndex: '0x0', transactionHash: '0x' + '22'.repeat(32), logIndex: '0x' + i.toString(16), removed: false, ...l })));
          }
          case 'eth_call': {
            const { to, data } = j.params[0];
            const c = contracts[String(to).toLowerCase()];
            if (!c) return revert;
            const sel = String(data).slice(0, 10);
            const sig = (i, n) => i.getFunction(n).selector;
            if (sel === sig(I721, 'supportsInterface')) return r(coder.encode(['bool'], [c.supports.includes(coder.decode(['bytes4'], '0x' + data.slice(10))[0])]));
            if (sel === sig(I721, 'ownerOf')) { const id = coder.decode(['uint256'], '0x' + data.slice(10))[0]; return c.owners && c.owners[id] ? r(coder.encode(['address'], [c.owners[id]])) : revert; }
            if (sel === sig(I721, 'tokenURI')) { const id = coder.decode(['uint256'], '0x' + data.slice(10))[0]; return c.uris && c.uris[id] ? r(coder.encode(['string'], [c.uris[id]])) : revert; }
            if (sel === sig(I721, 'symbol')) return c.symbol ? r(coder.encode(['string'], [c.symbol])) : revert;
            if (sel === sig(I721, 'name')) return revert;
            if (sel === sig(I1155, 'balanceOf')) { const [a, id] = coder.decode(['address', 'uint256'], '0x' + data.slice(10)); return r(coder.encode(['uint256'], [(c.balances && c.balances[E.getAddress(a) + '|' + id]) || 0n])); }
            if (sel === sig(I1155, 'uri')) return c.uri ? r(coder.encode(['string'], [c.uri])) : revert;
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
    constructor() {
      this.s = { nfts: {}, nftHidden: {} };
      this.p = new FailoverProvider([url], net, { timeout: 4000 });
      this.sent = [];
      this.vault = { persist() {} };
    }
    section() { return this.s; }
    data() { return this.s; }
    evmAccount() { return owner; }
    evmView() { return owner; }
    async policyGate() { return { warnings: [], delay: 0, danger: false }; }
    activeChain() { return 1; }
    provider() { return this.p; }
    _ethCall(chainId, to, data) { return this.p.call({ to, data }); }
    network() { return { name: 'Test', chainId: 1 }; }
    recipientWarnings() { return { warnings: [], danger: false }; }
    ownEvm() { return [owner]; }
    rememberRecipient() {}
    async sendTransaction(win, origin, tx, sameTab, opts) { this.sent.push({ tx, opts }); return '0x' + 'ab'.repeat(32); }
  }
  nft.install(FakeWallet, { RpcError: RpcErr, clip: (s, n) => String(s).slice(0, n), unauthorized: (m) => new Error(m) });
  const w = new FakeWallet();
  const fails = async (fn) => { try { await fn(); return ''; } catch (e) { return e.message; } };

  // --- додавання ---
  const a1 = await w.addNft(C721, '1');
  await w.addNft(C721, '3');
  await w.addNft(C721, '2');
  const a7 = await w.addNft(C1155, '7');
  ok(a1.standard === 'erc721' && a7.standard === 'erc1155' && w.s.nfts[1].length === 4, 'nft: ERC-721 і ERC-1155 розпізнаються за ERC-165 і зберігаються');
  ok((await w.addNft(C721, '1')).id === '1' && w.s.nfts[1].length === 4, 'nft: повторне додавання не дублює');
  ok(/не схоже на NFT/.test(await fails(() => w.addNft(CPLAIN, '1'))) && /не схоже на NFT/.test(await fails(() => w.addNft(E.getAddress('0x0000000000000000000000000000000000000dd0'), '1'))), 'nft: адреса, що не є NFT-контрактом, відхиляється');
  ok(/немає/.test(await fails(() => w.addNft(C721, '999'))) && /id токена/.test(await fails(() => w.addNft(C721, 'abc'))) && /id токена/.test(await fails(() => w.addNft(C721, String(2n ** 256n)))) && /адрес/.test(await fails(() => w.addNft('0x123', '1'))), 'nft: неіснуючий токен, некоректний id і адреса відхиляються');

  // --- показ: лише власні, метадані лише з безпечних джерел ---
  const list = await w.evmNfts(0);
  const it1 = list.items.find(x => x.id === '1'), it2 = list.items.find(x => x.id === '2'), it3 = list.items.find(x => x.id === '3'), it7 = list.items.find(x => x.id === '7');
  ok(list.items.length === 3 && !it2, 'nft: чужий токен (той самий контракт) не показується');
  ok(it1 && it1.name === 'Cool #1' && it1.collection === 'COOL' && /^data:image\/svg\+xml;base64,/.test(it1.image) && it1.amount === '1' && it1.metadata === 'ok', 'nft: назва очищена від керівних символів, зображення з ончейн-даних, колекція з контракту');
  ok(it3 && it3.image === '' && it3.name === 'Page', 'nft: поле image з не-зображенням ігнорується');
  ok(it7 && it7.standard === 'erc1155' && it7.amount === '3' && it7.name === 'Item {id}', 'nft: ERC-1155 — кількість з balanceOf, шаблон {id} підставляється лише в адресу метаданих');
  // зовнішній https не відкривається (метадані 'external')
  const extOwner = { ...contracts[C721.toLowerCase()].owners }; contracts[C721.toLowerCase()].owners[2] = owner;
  const ext = (await w.evmNfts(0)).items.find(x => x.id === '2');
  contracts[C721.toLowerCase()].owners = extOwner;
  ok(ext && ext.metadata === 'external' && ext.image === '' && ext.name === '', 'nft: метадані на довільному https не завантажуються (приватність)');

  // --- видалення й пошук ---
  ok(w.removeNft(C721, '3') === true && !w.s.nfts[1].some(x => x.id === '3') && w.s.nftHidden[1].includes(`${C721}|3`), 'nft: «Прибрати» видаляє зі списку й запам’ятовує як приховане');
  const tpad = (a) => E.zeroPadValue(a, 32);
  const tid = (n) => E.zeroPadValue(E.toBeHex(n), 32);
  logs = [
    { address: C721, topics: [E.id('Transfer(address,address,uint256)'), tpad(other), tpad(owner), tid(3)], data: '0x' },
    { address: C721, topics: [E.id('Transfer(address,address,uint256)'), tpad(other), tpad(owner), tid(2)], data: '0x' }, // належить іншому
    { address: C721, topics: [E.id('Transfer(address,address,uint256)'), tpad(other), tpad(owner)], data: coder.encode(['uint256'], [5n]) }, // це ERC-20
    { address: C1155, topics: [E.id('TransferSingle(address,address,address,uint256,uint256)'), tpad(other), tpad(other), tpad(owner)], data: coder.encode(['uint256', 'uint256'], [7n, 1n]) },
  ];
  const before = w.s.nfts[1].length;
  const d1 = await w.discoverNfts(0, { blocks: 4000, chunk: 2000 });
  ok(d1.added === 0 && w.s.nfts[1].length === before, 'nft: пошук не повертає приховані, чужі, ERC-20 і вже збережені токени');
  w.s.nftHidden[1] = [];
  const d2 = await w.discoverNfts(0, { blocks: 4000, chunk: 2000 });
  ok(d2.added === 1 && w.s.nfts[1].some(x => x.id === '3') && w.s.nfts[1].filter(x => x.id === '2').length === 1 && w.s.nfts[1].filter(x => x.id === '7').length === 1 && !d2.partial, 'nft: пошук додає лише токени, які контракт підтверджує як ваші');
  failLogs = true; // інший діапазон, щоб не потрапити в кеш запитів ethers (250 мс)
  const d3 = await w.discoverNfts(0, { blocks: 3000, chunk: 1500 });
  failLogs = false;
  ok(d3.partial === true && d3.added === 0, 'nft: обмеження RPC на журнали дає «неповний» результат, а не збій');

  // --- переказ ---
  const bad = E.getAddress('0x00000000000000000000000000000000000000cc');
  ok(/нульова/.test(await fails(() => w.sendNft(null, null, { index: 0, contract: C721, tokenId: '1', to: E.ZeroAddress }))) && /контракту самого NFT/.test(await fails(() => w.sendNft(null, null, { index: 0, contract: C721, tokenId: '1', to: C721 }))) && /той самий/.test(await fails(() => w.sendNft(null, null, { index: 0, contract: C721, tokenId: '1', to: owner }))) && /адреса отримувача/.test(await fails(() => w.sendNft(null, null, { index: 0, contract: C721, tokenId: '1', to: 'нісенітниця' }))), 'nft: переказ на нульову адресу, на контракт NFT, на себе й некоректну адресу відхиляється');
  ok(/не належить/.test(await fails(() => w.sendNft(null, null, { index: 0, contract: C721, tokenId: '2', to: bad }))) && w.sent.length === 0, 'nft: чужий токен надіслати не можна (перевірка власності контрактом)');
  const h1 = await w.sendNft(null, null, { index: 0, contract: C721, tokenId: '1', to: bad });
  const tx1 = w.sent[0];
  const dec1 = I721.parseTransaction({ data: tx1.tx.data });
  ok(h1 === '0x' + 'ab'.repeat(32) && tx1.tx.to === C721 && tx1.tx.from === owner && dec1.name === 'safeTransferFrom' && dec1.args[0] === owner && dec1.args[1] === bad && dec1.args[2] === 1n && tx1.opts.internal === true && tx1.opts.summary.some(l => l[0] === 'Отримувач' && l[1] === bad), 'nft: ERC-721 переказ будує safeTransferFrom(власник, отримувач, id) із підтвердженням');
  ok(tx1.tx.value === undefined && !tx1.opts.warnings.some(x => /контракт/.test(x)), 'nft: звичайний отримувач без попередження про контракт, без суми ETH');
  ok(/Недостатньо/.test(await fails(() => w.sendNft(null, null, { index: 0, contract: C1155, tokenId: '7', to: bad, amount: '4' }))) && /Кількість/.test(await fails(() => w.sendNft(null, null, { index: 0, contract: C1155, tokenId: '7', to: bad, amount: '0' }))), 'nft: ERC-1155 — кількість більша за баланс чи нульова відхиляється');
  await w.sendNft(null, null, { index: 0, contract: C1155, tokenId: '7', to: C721, amount: '2' });
  const tx2 = w.sent[1];
  const dec2 = I1155.parseTransaction({ data: tx2.tx.data });
  ok(dec2.name === 'safeTransferFrom' && dec2.args[2] === 7n && dec2.args[3] === 2n && dec2.args[1] === C721 && tx2.opts.warnings.some(x => /смарт-контракт/.test(x)), 'nft: ERC-1155 переказ — id і кількість у даних, попередження про отримувача-контракт');

  // --- безпечне джерело метаданих ---
  const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
  ok(meta.resolveUri('ipfs://' + cid + '/1.json').urls[0] === 'https://ipfs.io/ipfs/' + cid + '/1.json' && meta.resolveUri('ar://' + 'a'.repeat(43)).urls[0] === 'https://arweave.net/' + 'a'.repeat(43), 'nft-meta: ipfs:// та ar:// ведуть на шлюзи');
  ok(['https://evil.example/' + cid, 'https://example.com/meta.json', 'ipfs://' + cid + '/../x', 'ipfs://' + cid + '?a=1', 'file:///C:/x', 'javascript:alert(1)', 'http://ipfs.io/ipfs/' + cid].every(u => meta.resolveUri(u) === null), 'nft-meta: довільні хости, обхід шляху, запити, file: і javascript: відхиляються');
  let fetched = 0;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const mk = (buf, type = 'image/png', status = 200) => async () => { fetched++; return { ok: status === 200, status, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? type : null) }, arrayBuffer: async () => buf }; };
  ok((await meta.loadImage('ipfs://' + cid, { fetchImpl: mk(png) })).startsWith('data:image/png;base64,'), 'nft-meta: PNG із шлюзу віддається як data:-URL');
  ok(await meta.loadImage('ipfs://' + cid, { fetchImpl: mk(Buffer.from('<html><script>alert(1)</script></html>'), 'image/png') }) === '', 'nft-meta: тип визначається за вмістом: HTML під виглядом image/png відкидається');
  ok(await meta.loadImage('ipfs://' + cid, { fetchImpl: mk(Buffer.alloc(500 * 1024, 1)) }).catch(() => 'err') !== '' && await meta.loadImage('data:image/png;base64,' + Buffer.alloc(500 * 1024, 1).toString('base64')) === '', 'nft-meta: завеликі зображення відхиляються');
  const before2 = fetched;
  ok(await meta.loadImage('https://evil.example/a.png', { fetchImpl: mk(png) }) === '' && fetched === before2, 'nft-meta: заборонений хост навіть не запитується');
  ok(await meta.loadImage('ipfs://' + cid, { fetchImpl: async () => { throw new Error('net'); } }).then(() => 'noerr', () => 'err') === 'err', 'nft-meta: мережева помилка шлюзу дає помилку, а не підміну');

  // --- ціни ---
  let calls = 0, reply = null, clock = 0;
  const pf = async (u) => { calls++; if (reply instanceof Error) throw reply; return { ok: true, status: 200, text: async () => JSON.stringify(reply), _u: u }; };
  const pr = new Prices({ fetchImpl: pf, now: () => clock });
  reply = { ethereum: { usd: 3100.5 } };
  ok(await pr.native('ethereum') === 3100.5 && await pr.native('ethereum') === 3100.5 && calls === 1, 'prices: ціна нативної монети, повторний запит береться з кешу');
  clock += 190000;
  reply = { ethereum: { usd: 3200 } };
  ok(await pr.native('ethereum') === 3200 && calls === 2, 'prices: після спливу кешу ціна оновлюється');
  const usdc = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  reply = { [usdc.toLowerCase()]: { usd: 1.0002 }, ['0x' + 'ab'.repeat(20)]: { usd: -5 } };
  const tk = await pr.tokens('ethereum', [usdc, '0x' + 'ab'.repeat(20), 'не-адреса']);
  ok(tk[usdc] === 1.0002 && Object.keys(tk).length === 1, 'prices: токени за адресою контракту; від’ємні й сміттєві значення відкидаються');
  for (const bad2 of [NaN, 0, -1, 1e15, '5', null, { x: 1 }]) { clock += 200000; reply = { bitcoin: { usd: bad2 } }; if (await pr.native('bitcoin') !== null) { ok(false, 'prices: некоректна відповідь прийнята: ' + JSON.stringify(bad2)); } }
  ok(await pr.native('Evil/../x') === null && await pr.tokens('../x', [usdc]).then(o => Object.keys(o).length === 0), 'prices: ідентифікатори перевіряються (без ін’єкції в URL)');
  clock += 200000; reply = new Error('net'); calls = 0;
  ok(await pr.native('solana') === null && await pr.native('solana') === null && calls === 1, 'prices: помилка мережі дає null і коротко кешується (без засипання запитами)');
  require('../../src/wallet-extras').install(FakeWallet, { RpcError: RpcErr, clip: (s) => s, unauthorized: (m) => new Error(m) });
  const w2 = new FakeWallet();
  w2.ctx = { cfg: () => ({ walletPrices: false }) };
  ok((await w2.priceInfo({ chain: 'evm', tokens: [usdc] })).enabled === false, 'prices: вимкнено в налаштуваннях — жодних запитів і цін');
  w2.ctx = { cfg: () => ({ walletPrices: true }) };
  w2.solCluster = () => 'devnet';
  ok((await w2.priceInfo({ chain: 'sol', tokens: [] })).native === null, 'prices: тестові мережі Solana без цін');

  server.closeAllConnections(); server.close();
}

module.exports = { nftTests };
