'use strict';
// Unit-тести гаманця без Electron: Solana (base58, суми, повідомлення транзакцій) і розбір підписів сайту (SIWE, EIP-7702).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const src = (f) => require(path.join(__dirname, '..', '..', 'src', f));

const addrOf = (seed) => src('solana.js').b58encode(crypto.createHash('sha256').update(seed).digest());

test('solana: base58 туди й назад, адреси', () => {
  const s = src('solana.js');
  const bytes = crypto.randomBytes(32);
  assert.deepEqual(Buffer.from(s.b58decode(s.b58encode(bytes))), bytes);
  assert.equal(s.b58encode(Buffer.from([0, 0, 1])).startsWith('11'), true, 'початкові нулі → «1»');
  assert.equal(s.isAddress(addrOf('a')), true);
  assert.equal(s.isAddress('0OIl'), false, 'символи поза алфавітом');
  assert.equal(s.isAddress(s.b58encode(crypto.randomBytes(31))), false, 'не 32 байти');
  assert.equal(s.isAddress(''), false);
  assert.equal(s.isAddress(null), false);
});

test('solana: суми точні (BigInt) і відхиляють сміття', () => {
  const s = src('solana.js');
  assert.equal(s.parseSol('1'), 1_000_000_000n);
  assert.equal(s.parseSol('0.000000001'), 1n);
  assert.equal(s.parseSol('12.5'), 12_500_000_000n);
  for (const bad of ['0', '0.0', '-1', '1e3', '1.0000000001', '', ' 1', '1,5', 'abc', '1'.repeat(13), null, 5]) {
    assert.throws(() => s.parseSol(bad), undefined, String(bad));
  }
  assert.equal(s.parseUnits('12.5', 6), 12_500_000n);
  assert.equal(s.parseUnits('7', 0), 7n);
  assert.throws(() => s.parseUnits('1.5', 0));
  assert.throws(() => s.parseUnits('1.1234567', 6));
  assert.throws(() => s.parseUnits('1', -1));
  assert.throws(() => s.parseUnits('1', 31));
  assert.throws(() => s.parseUnits('18446744073709551616', 0), undefined, 'більше u64');
  assert.equal(s.parseUnits('18446744073709551615', 0), 0xffffffffffffffffn);
});

test('solana: форматування сум і коротких адрес', () => {
  const s = src('solana.js');
  assert.equal(s.formatUnits(1_500_000n, 6), '1.5');
  assert.equal(s.formatUnits(1n, 9), '0.000000001');
  assert.equal(s.formatUnits(42n, 0), '42');
  assert.equal(s.formatUnits(1_000_000n, 6), '1');
  assert.equal(s.sol(2_000_000_000), '2');
  assert.equal(s.short('1234567890ABCDEFGH'), '1234…EFGH');
  assert.equal(s.short('abc'), 'abc');
  assert.equal(s.short(null), '?');
});

test('solana: короткий вектор довжини (shortvec)', () => {
  const { encodeShortVec } = src('solana.js');
  assert.deepEqual([...encodeShortVec(0)], [0]);
  assert.deepEqual([...encodeShortVec(127)], [127]);
  assert.deepEqual([...encodeShortVec(128)], [0x80, 0x01]);
  assert.deepEqual([...encodeShortVec(16384)], [0x80, 0x80, 0x01]);
});

test('solana: переказ → повідомлення → розбір → опис збігаються', () => {
  const s = src('solana.js');
  const from = addrOf('from'), to = addrOf('to');
  const blockhash = addrOf('blockhash');
  const msg = s.buildTransferMessage({ from, to, lamports: 123_456_789n, blockhash });
  const parsed = s.parseMessage(msg);
  assert.equal(parsed.version, 'legacy');
  assert.ok(parsed.keys.includes(from) && parsed.keys.includes(to));
  const d = s.describe(parsed, [from]);
  assert.equal(d.outgoing, 123_456_789n);
  assert.equal(d.danger, false);
  const wire = s.unsignedWire(msg);
  const tx = s.parseTransaction(wire);
  assert.ok(tx);
  assert.throws(() => s.buildTransferMessage({ from, to: from, lamports: 1n, blockhash }), undefined, 'на той самий рахунок');
});

test('solana: обірвані й спотворені повідомлення відхиляються без збою', () => {
  const s = src('solana.js');
  const msg = s.buildTransferMessage({ from: addrOf('f'), to: addrOf('t'), lamports: 5n, blockhash: addrOf('b') });
  for (let n = 0; n < msg.length; n += 7) {
    try { s.parseMessage(msg.subarray(0, n)); } catch (e) { assert.ok(e instanceof Error); }
  }
  assert.throws(() => s.parseMessage(Buffer.alloc(0)));
  assert.throws(() => s.parseMessage(Buffer.from([0x81, 0, 0, 0])), undefined, 'версія 1 не підтримується');
});

const SIWE = (over = {}) => [
  `${over.domain || 'app.example'} wants you to sign in with your Ethereum account:`,
  over.address || '0x1111111111111111111111111111111111111111',
  '',
  over.statement || 'Увійти в застосунок.',
  '',
  `URI: ${over.uri || 'https://app.example/login'}`,
  `Version: ${over.version || '1'}`,
  `Chain ID: ${over.chain || '1'}`,
  `Nonce: ${over.nonce || 'abcdef123456'}`,
  `Issued At: ${over.issued || '2026-10-18T10:00:00.000Z'}`,
].join('\n');
const NOW = Date.parse('2026-10-18T10:05:00.000Z');
const ACC = '0x1111111111111111111111111111111111111111';

test('signguard: коректний SIWE без попереджень про домен', () => {
  const g = src('wallet-signguard.js');
  const p = g.parseSiwe(SIWE());
  assert.equal(p.domain, 'app.example');
  assert.equal(p.fields.Nonce, 'abcdef123456');
  const r = g.checkSiwe(SIWE(), { origin: 'https://app.example', account: ACC, chainId: 1, now: NOW });
  assert.equal(r.danger, false);
  assert.deepEqual(r.warnings, []);
  assert.equal(g.checkSiwe('звичайний текст', { origin: 'https://x.y' }), null);
  assert.equal(g.parseSiwe('hello'), null);
});

test('signguard: SIWE з чужим доменом, чужою адресою й підозрілим текстом', () => {
  const g = src('wallet-signguard.js');
  const phish = g.checkSiwe(SIWE({ domain: 'app.example' }), { origin: 'https://evil.example', account: ACC, chainId: 1, now: NOW });
  assert.equal(phish.danger, true, 'домен ≠ сайт');
  const uri = g.checkSiwe(SIWE({ uri: 'https://evil.example/x' }), { origin: 'https://app.example', account: ACC, now: NOW });
  assert.equal(uri.danger, true, 'URI з іншого домену');
  const acc = g.checkSiwe(SIWE(), { origin: 'https://app.example', account: '0x2222222222222222222222222222222222222222', now: NOW });
  assert.equal(acc.danger, true, 'адреса ≠ рахунок');
  const stmt = g.checkSiwe(SIWE({ statement: 'Approve and transfer all my tokens' }), { origin: 'https://app.example', account: ACC, now: NOW });
  assert.ok(stmt.warnings.length >= 1);
  const old = g.checkSiwe(SIWE({ nonce: 'x' }), { origin: 'https://app.example', account: ACC, now: NOW });
  assert.ok(old.warnings.length >= 1, 'короткий nonce');
});

test('signguard: відхилені методи й делегування EIP-7702', () => {
  const g = src('wallet-signguard.js');
  assert.ok(g.rejectReason('wallet_sendCalls'));
  assert.ok(g.rejectReason('eth_signAuthorization'));
  assert.equal(g.rejectReason('eth_chainId'), null);
  assert.equal(g.hasDelegation({ type: 4 }), true);
  assert.equal(g.hasDelegation({ type: '0x04' }), true);
  assert.equal(g.hasDelegation({ authorizationList: [] }), true);
  assert.equal(g.hasDelegation({ type: 2 }), false);
  assert.equal(g.hasDelegation(null), false);
  const a = '0x' + 'ab'.repeat(20);
  assert.equal(g.delegateOf('0xef0100' + 'ab'.repeat(20)).toLowerCase(), a);
  assert.equal(g.delegateOf('0x'), null);
  assert.equal(g.delegateOf('0xef0100' + 'ab'.repeat(19)), null);
});
