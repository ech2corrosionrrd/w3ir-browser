'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { Mnemonic, HDNodeWallet } = require('ethers');
const { createCore } = require('../../src/wallet-signer-core');
const { SignerClient } = require('../../src/wallet-signer-client');
const { EVM_PATHS } = require('../../src/wallet-evm-core');
const S = require('../../src/solana');

const PHRASE = 'test test test test test test test test test test test junk';
const evmAt = (i, pass = '', kind = 'standard') => HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(PHRASE, pass), EVM_PATHS[kind](i)).address;
const solAt = (i, pass = '', kind = 'phantom') => S.deriveAccount(Buffer.from(Mnemonic.fromPhrase(PHRASE, pass).computeSeed().slice(2), 'hex'), i, kind).address;

test('signer-core: адреси EVM і Solana збігаються з прямою деривацією', async () => {
  const core = createCore();
  assert.strictEqual((await core.handle({ id: 1, op: 'unlock', args: { mnemonic: PHRASE } })).ok, true);
  for (const i of [0, 1, 7]) {
    assert.strictEqual((await core.handle({ id: 2, op: 'address', args: { chain: 'evm', index: i } })).result.address, evmAt(i));
    assert.strictEqual((await core.handle({ id: 3, op: 'address', args: { chain: 'sol', index: i } })).result.address, solAt(i));
  }
});

test('signer-core: фраза-пароль і шляхи деривації враховуються', async () => {
  const core = createCore();
  await core.handle({ id: 1, op: 'unlock', args: { mnemonic: PHRASE, passphrase: 'x', evmPath: 'ledgerLive', solPath: 'bip44' } }).then(r => assert.ok(r.ok, r.error));
  assert.strictEqual((await core.handle({ id: 2, op: 'address', args: { chain: 'evm', index: 2 } })).result.address, evmAt(2, 'x', 'ledgerLive'));
  assert.strictEqual((await core.handle({ id: 3, op: 'address', args: { chain: 'sol', index: 2 } })).result.address, solAt(2, 'x', 'bip44'));
});

test('signer-core: lock обнуляє стан, а до розблокування адреси недоступні', async () => {
  const core = createCore();
  assert.strictEqual((await core.handle({ id: 1, op: 'address', args: { chain: 'evm', index: 0 } })).error, 'locked');
  await core.handle({ id: 2, op: 'unlock', args: { mnemonic: PHRASE } });
  assert.strictEqual(core.isUnlocked(), true);
  await core.handle({ id: 3, op: 'lock' });
  assert.strictEqual(core.isUnlocked(), false);
  assert.strictEqual((await core.handle({ id: 4, op: 'address', args: { chain: 'sol', index: 0 } })).error, 'locked');
});

test('signer-core: некоректні запити відхиляються, а відповіді не містять фрази', async () => {
  const core = createCore();
  const bad = [
    { id: 1, op: 'unlock', args: { mnemonic: 'не фраза' } },
    { id: 2, op: 'unlock', args: { mnemonic: PHRASE, evmPath: 'nope' } },
    { id: 3, op: 'unlock', args: { mnemonic: PHRASE, passphrase: 'a'.repeat(129) } },
    { id: 4, op: 'nope' },
    { id: 5, op: '__proto__' },
    { id: 6, op: 'toString' },
    null,
    'рядок',
  ];
  for (const r of bad) { const out = await core.handle(r); assert.strictEqual(out.ok, false); assert.ok(!JSON.stringify(out).includes('junk')); }
  await core.handle({ id: 7, op: 'unlock', args: { mnemonic: PHRASE } });
  for (const args of [{ chain: 'evm', index: -1 }, { chain: 'evm', index: 1001 }, { chain: 'evm', index: 1.5 }, { chain: 'btc', index: 0 }, {}]) {
    assert.strictEqual((await core.handle({ id: 8, op: 'address', args })).ok, false);
  }
});

// Фальшивий процес: повідомлення обробляє ядро в цьому ж процесі; режими збою — для перевірки клієнта
function fakeSpawn(opts = {}) {
  const made = [];
  const spawn = () => {
    const core = createCore();
    const c = new EventEmitter();
    c.killed = false;
    c.postMessage = (m) => {
      if (opts.silent) return;
      if (opts.crashOn && m.op === opts.crashOn) { setImmediate(() => c.emit('exit', 1)); return; }
      core.handle(m).then(r => setImmediate(() => !c.killed && c.emit('message', r)));
    };
    c.kill = () => { c.killed = true; setImmediate(() => c.emit('exit', 0)); };
    c.core = core;
    made.push(c);
    return c;
  };
  return { spawn, made };
}

test('signer-client: запуск при першому виклику, відповіді зіставляються із запитами', async () => {
  const { spawn, made } = fakeSpawn();
  const cl = new SignerClient({ spawn });
  assert.strictEqual(cl.running(), false);
  await cl.call('unlock', { mnemonic: PHRASE });
  const [a, b] = await Promise.all([cl.call('address', { chain: 'evm', index: 0 }), cl.call('address', { chain: 'sol', index: 1 })]);
  assert.strictEqual(a.address, evmAt(0));
  assert.strictEqual(b.address, solAt(1));
  assert.strictEqual(made.length, 1);
  cl.kill();
});

test('signer-client: помилка ядра стає відхиленим промісом', async () => {
  const { spawn } = fakeSpawn();
  const cl = new SignerClient({ spawn });
  await assert.rejects(cl.call('address', { chain: 'evm', index: 0 }), /locked/);
  cl.kill();
});

test('signer-client: збій процесу — помилка, а не зависання; наступний виклик запускає новий процес без seed', async () => {
  const { spawn, made } = fakeSpawn({ crashOn: 'address' });
  const cl = new SignerClient({ spawn, timeoutMs: 2000 });
  await cl.call('unlock', { mnemonic: PHRASE });
  await assert.rejects(cl.call('address', { chain: 'evm', index: 0 }), /signer-crashed/);
  assert.strictEqual(cl.running(), false);
  assert.strictEqual((await cl.call('status')).unlocked, false);
  assert.strictEqual(made.length, 2);
  cl.kill();
});

test('signer-client: тайм-аут відхиляє виклик і завершує процес', async () => {
  const { spawn, made } = fakeSpawn({ silent: true });
  const cl = new SignerClient({ spawn, timeoutMs: 30 });
  await assert.rejects(cl.call('ping'), /signer-timeout/);
  assert.strictEqual(cl.running(), false);
  assert.strictEqual(made[0].killed, true);
});

test('signer-client: lock завершує процес, простій теж', async () => {
  const { spawn, made } = fakeSpawn();
  const cl = new SignerClient({ spawn, idleMs: 40 });
  await cl.call('unlock', { mnemonic: PHRASE });
  await cl.lock();
  assert.strictEqual(made[0].killed, true);
  assert.strictEqual(made[0].core.isUnlocked(), false);
  assert.strictEqual(cl.running(), false);
  await cl.call('ping');
  assert.strictEqual(cl.running(), true);
  await new Promise(r => setTimeout(r, 120));
  assert.strictEqual(cl.running(), false);
  assert.strictEqual(made[1].killed, true);
});

test('signer-client: сторонні й помилкові повідомлення ігноруються', async () => {
  const { spawn, made } = fakeSpawn();
  const cl = new SignerClient({ spawn });
  await cl.call('ping');
  made[0].emit('message', { id: 999, ok: true, result: {} });
  made[0].emit('message', null);
  made[0].emit('message', 'рядок');
  assert.strictEqual((await cl.call('ping')).pong, true);
  cl.kill();
});
