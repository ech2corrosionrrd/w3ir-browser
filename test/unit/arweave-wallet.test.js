'use strict';
// Unit-тести Arweave Wallet (src/wallet-arweave.js) без Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const arWallet = require(path.join(__dirname, '..', '..', 'src', 'wallet-arweave.js'));

test('arweave-wallet: генерація ключів JWK та деривація 43-символьної адреси', () => {
  const jwk = arWallet.generateArweaveJwk();
  assert.equal(jwk.kty, 'RSA');
  assert.equal(jwk.e, 'AQAB');
  assert.ok(typeof jwk.n === 'string' && jwk.n.length > 100);
  assert.ok(typeof jwk.d === 'string' && jwk.d.length > 100);

  const address = arWallet.ownerToAddress(jwk.n);
  assert.equal(typeof address, 'string');
  assert.equal(address.length, 43);
  assert.match(address, /^[a-zA-Z0-9_-]{43}$/);
});

test('arweave-wallet: підпис RSASSA-PSS SHA-256 та валідація підпису', () => {
  const jwk = arWallet.generateArweaveJwk();
  const data = Buffer.from('Повідомлення для перевірки підпису Arweave Permaweb');

  const sig = arWallet.signData(jwk, data);
  assert.ok(Buffer.isBuffer(sig));
  assert.ok(sig.length >= 256);

  // Перевірка справжнього підпису
  const isValid = arWallet.verifySignature(jwk, data, sig);
  assert.equal(isValid, true);

  // Перевірка за публічним модулем n
  const isValidByN = arWallet.verifySignature(jwk.n, data, sig);
  assert.equal(isValidByN, true);

  // Спотворені дані мають не проходити валідацію
  const tamperedData = Buffer.from('Підроблене повідомлення');
  assert.equal(arWallet.verifySignature(jwk, tamperedData, sig), false);

  // Спотворений підпис має відхилятися
  const badSig = Buffer.from(sig);
  badSig[10] ^= 0xff;
  assert.equal(arWallet.verifySignature(jwk, data, badSig), false);
});

test('arweave-wallet: валідація вхідних параметрів та винятків', () => {
  assert.throws(() => arWallet.ownerToAddress(''), /Invalid owner/);
  assert.throws(() => arWallet.ownerToAddress(null), /Invalid owner/);
  assert.throws(() => arWallet.signData(null, 'data'), /Invalid Arweave JWK/);
  assert.throws(() => arWallet.signData({}, 'data'), /Invalid Arweave JWK/);
  assert.equal(arWallet.signTransaction, undefined, 'підпис транзакцій прибрано: потрібен deep-hash');
});

// Мінімальна заглушка гаманця: лише те, що потрібно методу arRequest
function fakeWallet(approve) {
  class W {}
  class RpcError extends Error { constructor(code, m) { super(m); this.code = code; } }
  arWallet.install(W, { RpcError, unauthorized: (m) => new RpcError(4100, m), clip: (x, n) => String(x).slice(0, n) });
  const w = new W();
  const sec = {};
  w.unlocked = () => true; w.section = () => sec; w.vault = { persist() {} };
  w.approve = async (_win, _origin, _same, req) => { w.last = req; return approve; };
  return w;
}

test('arweave-wallet: arweave_sign і arweave_dispatch не підписують (4200)', async () => {
  const w = fakeWallet(true);
  await w.arRequest(null, null, 'https://a.example', 'arweave_connect', {}, () => true);
  for (const m of ['arweave_sign', 'arweave_dispatch']) {
    await assert.rejects(w.arRequest(null, null, 'https://a.example', m, { transaction: { quantity: '1000' } }, () => true), (e) => e.code === 4200);
  }
});

test('arweave-wallet: arweave_signature вимагає підключення, право SIGNATURE та схвалення, показує вміст', async () => {
  const w = fakeWallet(true);
  const o = 'https://a.example';
  await assert.rejects(w.arRequest(null, null, o, 'arweave_signature', { data: 'hi' }, () => true), (e) => e.code === 4100);
  await w.arRequest(null, null, o, 'arweave_connect', { permissions: ['ACCESS_ADDRESS'] }, () => true);
  await assert.rejects(w.arRequest(null, null, o, 'arweave_signature', { data: 'hi' }, () => true), (e) => e.code === 4100, 'без права SIGNATURE');
  await w.arRequest(null, null, o, 'arweave_connect', { permissions: ['SIGNATURE'] }, () => true);
  const sig = await w.arRequest(null, null, o, 'arweave_signature', { data: 'привіт' }, () => true);
  assert.ok(Array.isArray(sig) && sig.length >= 256);
  const lines = Object.fromEntries(w.last.lines);
  assert.equal(lines['Вміст'], 'привіт');
  assert.match(lines['SHA-256'], /^[0-9a-f]{64}$/);
  const jwk = w.section().arweave.jwk;
  assert.equal(arWallet.verifySignature(jwk, Buffer.from('привіт'), Buffer.from(sig)), true);
  // Uint8Array із мосту приходить як об'єкт з числовими ключами
  const sig2 = await w.arRequest(null, null, o, 'arweave_signature', { data: { 0: 1, 1: 2, 2: 3 } }, () => true);
  assert.equal(arWallet.verifySignature(jwk, Buffer.from([1, 2, 3]), Buffer.from(sig2)), true);
  await assert.rejects(w.arRequest(null, null, o, 'arweave_signature', { data: '' }, () => true), (e) => e.code === -32602);
  await assert.rejects(w.arRequest(null, null, o, 'arweave_signature', { data: 'x'.repeat(70000) }, () => true), (e) => e.code === -32602);
});

test('arweave-wallet: відхилений підпис не виконується', async () => {
  const w = fakeWallet(false);
  const o = 'https://a.example';
  await assert.rejects(w.arRequest(null, null, o, 'arweave_connect', {}, () => true), (e) => e.code === 4001);
});
