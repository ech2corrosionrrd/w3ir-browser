'use strict';
// Unit-тести безпеки гаманця (політики переказів, адресна книга, перевірка фрази) без Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const safety = require(path.join(__dirname, '..', '..', 'src', 'wallet-safety.js'));

class RpcError extends Error {
  constructor(code, message, data) { super(message); this.code = code; this.data = data; }
}
const unauthorized = (m) => new RpcError(4100, m || 'Не авторизовано');

function createMockWallet(initialData = {}) {
  class MockWallet {
    constructor() {
      this._data = {
        policy: { ...safety.DEFAULT_POLICY },
        contacts: [],
        connections: {},
        solConnections: {},
        mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        addresses: ['0x1111111111111111111111111111111111111111'],
        backupConfirmedAt: 0,
        ...initialData,
      };
      this.vault = {
        persist: () => { this._persisted = true; },
      };
      this._disconnected = [];
    }
    data() { return this._data; }
    unlocked() { return !!this._data; }
    ownEvm() { return ['0x1111111111111111111111111111111111111111']; }
    ownSol() { return ['11111111111111111111111111111111']; }
    priceInfo({ chain, tokens }) {
      if (chain === 999) return Promise.resolve({ enabled: false });
      return Promise.resolve({
        enabled: true,
        native: 2500, // $2500 per ETH
        tokens: { '0xUSDC': 1.0 },
      });
    }
    disconnectSite(origin) {
      this._disconnected.push(origin);
      if (this._data.connections) delete this._data.connections[origin];
      if (this._data.solConnections) delete this._data.solConnections[origin];
    }
    _imported() { return []; }
    revealKey() { return '0xprivkey'; }
    exists() { return !!this._data; }
    importPhrase(phrase) {
      this._data = {
        policy: { ...safety.DEFAULT_POLICY },
        contacts: [],
        connections: {},
        solConnections: {},
        mnemonic: phrase,
        addresses: ['0x1111111111111111111111111111111111111111'],
        names: ['Основний'],
        backupConfirmedAt: 0,
      };
    }
    addAccount() {
      this._data.addresses.push('0x2222222222222222222222222222222222222222');
      this._data.names.push('Рахунок ' + this._data.addresses.length);
    }
    addContact(name, address) {
      this._data.contacts.push({ name, address });
    }
    importKey(key, name) {
      this._data.importedKeys = this._data.importedKeys || [];
      this._data.importedKeys.push({ key, name });
    }
  }

  safety.install(MockWallet, { RpcError, unauthorized });
  return new MockWallet();
}

test('wallet-safety: getPolicy та setPolicy валідація', () => {
  const w = createMockWallet();

  // Початкова політика за замовчуванням
  const p0 = w.getPolicy();
  assert.equal(p0.contactsOnly, false);
  assert.equal(p0.confirmUsd, 0);
  assert.equal(p0.maxUsd, 0);
  assert.equal(p0.siteDays, 0);

  // Оновлення валідними значеннями
  const p1 = w.setPolicy({ contactsOnly: true, confirmUsd: 500, maxUsd: 2000, siteDays: 30 });
  assert.equal(p1.contactsOnly, true);
  assert.equal(p1.confirmUsd, 500);
  assert.equal(p1.maxUsd, 2000);
  assert.equal(p1.siteDays, 30);
  assert.equal(w._persisted, true);

  // Валідація: confirmUsd > maxUsd
  assert.throws(() => w.setPolicy({ confirmUsd: 3000 }), /не може перевищувати ліміт/);

  // Валідація: некоректні типи та межі
  assert.throws(() => w.setPolicy({ maxUsd: -10 }), /Некоректне значення/);
  assert.throws(() => w.setPolicy({ siteDays: 3.5 }), /Некоректне значення/); // має бути integer
  assert.throws(() => w.setPolicy({ siteDays: 400 }), /Некоректне значення/); // max 365
});

test('wallet-safety: usdValue розрахунок', async () => {
  const w = createMockWallet();

  // Нативна монета: 2 ETH * $2500 = $5000
  const v1 = await w.usdValue(1, null, '2');
  assert.equal(v1, 5000);

  // Токен USDC: 100 * $1 = $100
  const v2 = await w.usdValue(1, '0xUSDC', '100');
  assert.equal(v2, 100);

  // Ціни вимкнено або невідомий токен
  const v3 = await w.usdValue(999, null, '1');
  assert.equal(v3, null);

  const v4 = await w.usdValue(1, '0xUNKNOWN', '10');
  assert.equal(v4, null);
});

test('wallet-safety: policyGate з режимом contactsOnly', async () => {
  const w = createMockWallet();
  w.setPolicy({ contactsOnly: true });

  // Переказ на власну адресу EVM дозволено
  const resOwn = await w.policyGate({ to: '0x1111111111111111111111111111111111111111', chain: 1, amount: '1' });
  assert.equal(resOwn.danger, false);

  // Переказ на збережений контакт дозволено
  w.data().contacts.push({ name: 'Bob', address: '0x2222222222222222222222222222222222222222' });
  const resContact = await w.policyGate({ to: '0x2222222222222222222222222222222222222222', chain: 1, amount: '1' });
  assert.equal(resContact.danger, false);

  // Переказ на невідому адресу заборонено з помилкою
  await assert.rejects(
    () => w.policyGate({ to: '0x9999999999999999999999999999999999999999', chain: 1, amount: '1' }),
    /Увімкнено режим «лише адресна книга»/
  );
});

test('wallet-safety: policyGate з лімітами maxUsd та confirmUsd', async () => {
  const w = createMockWallet();
  // Поріг затримки $1000, абсолютний ліміт $5000
  w.setPolicy({ confirmUsd: 1000, maxUsd: 5000 });

  // Мала сума: 0.1 ETH ($250) -> без попереджень і затримок
  const r1 = await w.policyGate({ to: '0x1111111111111111111111111111111111111111', chain: 1, amount: '0.1' });
  assert.equal(r1.danger, false);
  assert.equal(r1.delay, 0);

  // Велика сума: 1 ETH ($2500) -> затримка 5 секунд і попередження
  const r2 = await w.policyGate({ to: '0x1111111111111111111111111111111111111111', chain: 1, amount: '1' });
  assert.equal(r2.danger, true);
  assert.equal(r2.delay, 5);
  assert.ok(r2.warnings.some(w => w.includes('Велика сума')));

  // Перевищення ліміту: 3 ETH ($7500 > $5000) -> відхилення
  await assert.rejects(
    () => w.policyGate({ to: '0x1111111111111111111111111111111111111111', chain: 1, amount: '3' }),
    /Перевищено ліміт 5000 USD/
  );

  // NFT переказ не обмежується за сумою
  const rNft = await w.policyGate({ to: '0x1111111111111111111111111111111111111111', chain: 1, nft: true });
  assert.equal(rNft.danger, false);
});

test('wallet-safety: expireSites автовідключення старих підключень', () => {
  const w = createMockWallet();
  w.setPolicy({ siteDays: 7 });

  const now = Date.now();
  const dayMs = 86400000;

  w.data().connections = {
    'https://active.example': { last: now - dayMs },
    'https://stale.example': { last: now - 8 * dayMs },
  };

  const expired = w.expireSites();
  assert.equal(expired, 1);
  assert.ok(w._disconnected.includes('https://stale.example'));
  assert.equal(w.data().connections['https://active.example'] !== undefined, true);
});

test('wallet-safety: backupQuiz та backupCheck перевірка запису фрази', () => {
  const w = createMockWallet();
  assert.equal(w.backupInfo().confirmed, false);

  // Отримуємо вікторину
  const quiz = w.backupQuiz();
  assert.equal(quiz.positions.length, 3);
  quiz.positions.forEach(p => assert.ok(p >= 1 && p <= 12));

  // Фраза: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  // Перші 11 слів — 'abandon', 12-е слово — 'about'
  const allWords = w.data().mnemonic.split(' ');
  const correctAnswers = quiz.positions.map(p => allWords[p - 1]);

  // Неправильні відповіді
  const wrongAnswers = ['wrong', 'words', 'test'];
  assert.equal(w.backupCheck(wrongAnswers), false);
  assert.equal(w.backupInfo().confirmed, false);

  // Правильні відповіді
  assert.equal(w.backupCheck(correctAnswers), true);
  assert.equal(w.backupInfo().confirmed, true);
});

test('wallet-safety: touchSite оновлює час активності сайту', () => {
  const w = createMockWallet();
  const origin = 'https://app.uniswap.org';
  w.data().connections[origin] = { since: 1000, last: 1000 };
  w.data().solConnections[origin] = { since: 1000, last: 1000 };

  w.touchSite(origin);
  assert.ok(w.data().connections[origin].last > 1000);
  assert.ok(w.data().solConnections[origin].last > 1000);
});

test('wallet-safety: backupExport та backupImport повний цикл збереження й відновлення', () => {
  const w1 = createMockWallet();
  w1.data().contacts.push({ name: 'Alice', address: '0x1111111111111111111111111111111111111111' });
  const pwd = 'ExportPassword123!';

  // Експорт резервної копії
  const exported = w1.backupExport(pwd);
  assert.ok(Buffer.isBuffer(exported));

  // Спроба імпорту коли гаманець вже існує -> помилка
  assert.throws(() => w1.backupImport(exported, pwd), /Гаманець уже існує/);

  // Створюємо порожній гаманець (не ініціалізований)
  const w2 = createMockWallet();
  w2._data = null; // гаманця ще немає
  assert.equal(w2.exists(), false);

  // Успішний імпорт
  const res = w2.backupImport(exported, pwd);
  assert.ok(res.accounts >= 1);
  assert.equal(res.contacts, 1);
  assert.equal(w2.data().mnemonic, w1.data().mnemonic);
  assert.ok(w2.backupInfo().confirmed);
});

