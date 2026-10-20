'use strict';
// Unit-тести збору історії подій EVM та експорту в CSV без Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { zeroPadValue } = require('ethers');
const history = require(path.join(__dirname, '..', '..', 'src', 'wallet-history-evm.js'));

class RpcError extends Error {
  constructor(code, message, data) { super(message); this.code = code; this.data = data; }
}
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n) + '…' : String(s));
const unauthorized = (m) => new RpcError(4100, m || 'Не авторизовано');

const OWNER = '0x0000000000000000000000000000000000000001';
const CONTACT_ALICE = '0x1111111111111111111111111111111111111111';
const SPAM_TOKEN = '0x1234567890123456789012345678901234567890';
const GOOD_TOKEN = '0x2345678901234567890123456789012345678901';
const NFT_TOKEN = '0x3456789012345678901234567890123456789012';

function createMockHistoryWallet() {
  class MockWallet {
    constructor() {
      this._data = {
        contacts: [{ name: 'Alice', address: CONTACT_ALICE }],
      };
      this._activeChain = 1;
      this._historyCache = new Map();
    }
    data() { return this._data; }
    evmView() { return OWNER; }
    activeChain() { return this._activeChain; }
    network() { return { name: 'Ethereum', symbol: 'ETH' }; }
    _customTokens() { return []; }
    tokenInfo(chainId, tokenAddr) {
      if (tokenAddr.toLowerCase() === SPAM_TOKEN.toLowerCase()) {
        return Promise.resolve({ symbol: 'AIRDROP-CLAIM-IO', name: 'Free Reward Voucher', decimals: 18 });
      }
      return Promise.resolve({ symbol: 'USDC', name: 'USD Coin', decimals: 6 });
    }
    provider() {
      return {
        getBlockNumber: async () => 100,
        getBlock: async () => ({ timestamp: 1729000000 }),
        getLogs: async ({ topics }) => {
          const isOut = topics[1] !== null;
          if (isOut) {
            return [{
              transactionHash: '0xhash_out_1',
              blockNumber: 99,
              index: 0,
              address: GOOD_TOKEN,
              topics: [
                history.T_TRANSFER,
                zeroPadValue(OWNER, 32),
                zeroPadValue(CONTACT_ALICE, 32),
              ],
              data: '0x' + '00'.repeat(31) + '64', // 100 units
            }];
          } else {
            return [
              {
                transactionHash: '0xhash_in_spam',
                blockNumber: 98,
                index: 1,
                address: SPAM_TOKEN,
                topics: [
                  history.T_TRANSFER,
                  zeroPadValue('0x9999999999999999999999999999999999999999', 32),
                  zeroPadValue(OWNER, 32),
                ],
                data: '0x' + '00'.repeat(31) + '01',
              },
              {
                transactionHash: '0xhash_in_nft',
                blockNumber: 97,
                index: 2,
                address: NFT_TOKEN,
                topics: [
                  history.T_TRANSFER,
                  zeroPadValue(CONTACT_ALICE, 32),
                  zeroPadValue(OWNER, 32),
                  zeroPadValue('0x07', 32), // Token ID 7
                ],
                data: '0x',
              },
            ];
          }
        },
      };
    }
  }

  history.install(MockWallet, { RpcError, clip, unauthorized });
  return new MockWallet();
}

test('wallet-history: evmHistory сканує логи й позначає спам-розсилки', async () => {
  const w = createMockHistoryWallet();

  const res = await w.evmHistory(0, { blocks: 10, chunk: 10, parallel: 1 });
  assert.equal(res.chainId, 1);
  assert.equal(res.items.length, 3);

  // Перевіряємо порядок (сортування за спаданням блоків)
  assert.equal(res.items[0].hash, '0xhash_out_1');
  assert.equal(res.items[0].dir, 'out');
  assert.equal(res.items[0].peerName, 'Alice');
  assert.equal(res.items[0].suspicious, false);

  // Спам-токен позначено suspicious = true через назву та невідомого відправника
  const spam = res.items.find(it => it.hash === '0xhash_in_spam');
  assert.ok(spam);
  assert.equal(spam.dir, 'in');
  assert.equal(spam.suspicious, true);

  // NFT розпізнано
  const nft = res.items.find(it => it.hash === '0xhash_in_nft');
  assert.ok(nft);
  assert.equal(nft.kind, 'nft');
  assert.equal(nft.id, '7');
  assert.equal(nft.peerName, 'Alice');
});

test('wallet-history: evmHistoryCsv експортує дані з кешу', async () => {
  const w = createMockHistoryWallet();

  // До запиту історії кеш порожній -> помилка
  assert.throws(() => w.evmHistoryCsv(0), /Спершу відкрийте історію цього рахунку/);

  // Завантажуємо історію
  await w.evmHistory(0, { blocks: 10, chunk: 10 });

  // Тепер експорт працює
  const csv = w.evmHistoryCsv(0);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('Alice'));
  assert.ok(csv.includes('0xhash_out_1'));
  assert.ok(csv.includes('0xhash_in_spam'));
});
