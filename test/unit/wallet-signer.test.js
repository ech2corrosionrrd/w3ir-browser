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

// ---- підпис EVM: результат підписувача збігається з локальним HDNodeWallet (підпис ECDSA детермінований) ----
const { RemoteEvmSigner } = require('../../src/wallet-signer-evm');
const { getBytes } = require('ethers');

async function remoteSigner(i = 0) {
  const core = createCore();
  await core.handle({ id: 0, op: 'unlock', args: { mnemonic: PHRASE } });
  let n = 0;
  const call = async (op, args) => { const r = await core.handle({ id: ++n, op, args }); if (!r.ok) throw new Error(r.error); return r.result; };
  const local = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(PHRASE), EVM_PATHS.standard(i));
  return { core, local, signer: new RemoteEvmSigner(call, i, local.address) };
}

test('signer-evm: підпис транзакцій (legacy, EIP-1559) збігається з локальним', async () => {
  const { local, signer } = await remoteSigner(2);
  const to = '0x000000000000000000000000000000000000dEaD';
  for (const req of [
    { type: 0, to, value: 1n, nonce: 3, gasLimit: 21000n, gasPrice: 5n * 10n ** 9n, chainId: 1n },
    { type: 2, to, value: 10n ** 18n, nonce: 0, gasLimit: 50000n, maxFeePerGas: 30n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n, chainId: 11155111n, data: '0xa9059cbb' },
  ]) {
    assert.strictEqual(await signer.signTransaction({ ...req, from: local.address }), await local.signTransaction(req));
  }
});

test('signer-evm: підпис повідомлень і typed data збігається з локальним', async () => {
  const { local, signer } = await remoteSigner(1);
  assert.strictEqual(await signer.signMessage('привіт'), await local.signMessage('привіт'));
  assert.strictEqual(await signer.signMessage(getBytes('0x0102ff')), await local.signMessage(getBytes('0x0102ff')));
  const domain = { name: 'W3IR', version: '1', chainId: 1n, verifyingContract: '0x000000000000000000000000000000000000dEaD' };
  const types = { Order: [{ name: 'amount', type: 'uint256' }, { name: 'who', type: 'address' }] };
  const value = { amount: 10n ** 20n, who: '0x000000000000000000000000000000000000dEaD' };
  assert.strictEqual(await signer.signTypedData(domain, types, value), await local.signTypedData(domain, types, value));
});

test('signer-evm: чужа адреса відправника, підписана чи некоректна транзакція і заблокований підписувач відхиляються', async () => {
  const { core, local, signer } = await remoteSigner(0);
  const base = { type: 2, to: local.address, value: 1n, nonce: 0, gasLimit: 21000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n, chainId: 1n };
  await assert.rejects(signer.signTransaction({ ...base, from: '0x000000000000000000000000000000000000dEaD' }), /from address mismatch/);
  const signed = await local.signTransaction(base);
  const r = await core.handle({ id: 1, op: 'evmSignTx', args: { index: 0, raw: signed } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual((await core.handle({ id: 2, op: 'evmSignTx', args: { index: 0, raw: 5 } })).ok, false);
  assert.strictEqual((await core.handle({ id: 3, op: 'evmSignMessage', args: { index: 0 } })).ok, false);
  await core.handle({ id: 4, op: 'lock' });
  assert.strictEqual((await core.handle({ id: 5, op: 'evmSignMessage', args: { index: 0, text: 'x' } })).error, 'locked');
});

test('signer-evm: підпис, що не належить рахунку, відхиляється (розсинхрон індексу)', async () => {
  const { local } = await remoteSigner(0);
  const core = createCore();
  await core.handle({ id: 0, op: 'unlock', args: { mnemonic: PHRASE } });
  const call = async (op, args) => (await core.handle({ id: 1, op, args })).result;
  const wrong = new RemoteEvmSigner(call, 5, local.address); // індекс 5, але адреса рахунку 0
  await assert.rejects(wrong.signTransaction({ type: 2, to: local.address, value: 1n, nonce: 0, gasLimit: 21000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n, chainId: 1n }), /does not match the account/);
});

// ---- підпис Solana: збігається з локальним Ed25519 (детермінований) ----
const solSeed = () => Buffer.from(Mnemonic.fromPhrase(PHRASE).computeSeed().slice(2), 'hex');
const solTx = (from) => S.unsignedWire(S.buildTransferMessage({ from, to: solAt(5), lamports: 1_000n, blockhash: solAt(6) }));

test('signer-sol: підпис повідомлення і транзакції збігається з локальним', async () => {
  const core = createCore();
  await core.handle({ id: 0, op: 'unlock', args: { mnemonic: PHRASE } });
  for (const i of [0, 3]) {
    const kp = S.deriveAccount(solSeed(), i, 'phantom');
    const msg = Buffer.from('повідомлення ' + i);
    const m = await core.handle({ id: 1, op: 'solSign', args: { index: i, message: msg } });
    assert.ok(m.ok, m.error);
    assert.deepStrictEqual(Buffer.from(m.result.signature), S.sign(kp.secret, msg));
    const wire = solTx(kp.address);
    const t = await core.handle({ id: 2, op: 'solSignTx', args: { index: i, address: kp.address, wire } });
    assert.ok(t.ok, t.error);
    const local = S.signTransaction(kp.secret, kp.address, wire);
    assert.deepStrictEqual(Buffer.from(t.result.signedWire), local.signedWire);
    assert.deepStrictEqual(Buffer.from(t.result.signature), local.signature);
    assert.strictEqual(t.result.index, local.index);
  }
});

test('signer-sol: чужа адреса, не потрібний підпис, некоректні дані й блокування відхиляються', async () => {
  const core = createCore();
  assert.strictEqual((await core.handle({ id: 1, op: 'solSign', args: { index: 0, message: Buffer.from('x') } })).error, 'locked');
  await core.handle({ id: 2, op: 'unlock', args: { mnemonic: PHRASE } });
  const wire = solTx(solAt(0));
  assert.strictEqual((await core.handle({ id: 3, op: 'solSignTx', args: { index: 1, address: solAt(0), wire } })).error, 'address mismatch');
  assert.strictEqual((await core.handle({ id: 4, op: 'solSignTx', args: { index: 1, address: solAt(1), wire } })).ok, false); // рахунок 1 не підписант
  assert.strictEqual((await core.handle({ id: 5, op: 'solSign', args: { index: 0, message: 'рядок' } })).ok, false);
  assert.strictEqual((await core.handle({ id: 6, op: 'solSignTx', args: { index: 0, address: solAt(0), wire: 5 } })).ok, false);
  await core.handle({ id: 7, op: 'lock' });
  assert.strictEqual((await core.handle({ id: 8, op: 'solSignTx', args: { index: 0, address: solAt(0), wire } })).error, 'locked');
});

// ---- імпортовані ключі й ключ Arweave ----
const { Wallet: EthWallet } = require('ethers');
const arweave = require('../../src/wallet-arweave');

test('signer-import: імпортовані ключі EVM і Solana підписують так само, як локально', async () => {
  const evmKey = '0x' + '11'.repeat(32);
  const evm = new EthWallet(evmKey);
  const solSeedB64 = Buffer.alloc(32, 7).toString('base64');
  const solKp = S.keypairFromSeed(Buffer.alloc(32, 7));
  const core = createCore();
  const u = await core.handle({ id: 0, op: 'unlock', args: { mnemonic: PHRASE, imported: [{ chain: 'evm', address: evm.address, secret: evmKey }, { chain: 'sol', address: solKp.address, secret: solSeedB64 }] } });
  assert.ok(u.ok, u.error);
  let n = 0;
  const call = async (op, args) => { const r = await core.handle({ id: ++n, op, args }); if (!r.ok) throw new Error(r.error); return r.result; };
  const signer = new RemoteEvmSigner(call, { address: evm.address }, evm.address);
  assert.strictEqual(await signer.signMessage('імпорт'), await evm.signMessage('імпорт'));
  const req = { type: 2, to: evm.address, value: 5n, nonce: 1, gasLimit: 21000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n, chainId: 1n };
  assert.strictEqual(await signer.signTransaction(req), await evm.signTransaction(req));
  const msg = Buffer.from('sol імпорт');
  assert.deepStrictEqual(Buffer.from((await call('solSign', { address: solKp.address, message: msg })).signature), S.sign(solKp.secret, msg));
  const wire = solTx(solKp.address);
  const t = await call('solSignTx', { address: solKp.address, wire });
  assert.deepStrictEqual(Buffer.from(t.signedWire), S.signTransaction(solKp.secret, solKp.address, wire).signedWire);
  await assert.rejects(call('solSign', { address: solAt(0), message: msg }), /unknown account/);
  await assert.rejects(call('evmSignMessage', { address: '0x000000000000000000000000000000000000dEaD', text: 'x' }), /unknown account/);
});

test('signer-import: некоректний набір ключів відхиляється, lock забуває імпортовані ключі', async () => {
  const core = createCore();
  const bad = [
    { imported: 'x' }, { imported: [{ chain: 'btc', address: 'a', secret: 'b' }] }, { imported: Array.from({ length: 21 }, () => ({ chain: 'evm', address: 'a', secret: 'b' })) },
    { arweave: { n: 1 } },
  ];
  for (const extra of bad) assert.strictEqual((await core.handle({ id: 1, op: 'unlock', args: { mnemonic: PHRASE, ...extra } })).ok, false);
  const evmKey = '0x' + '22'.repeat(32);
  const addr = new EthWallet(evmKey).address;
  await core.handle({ id: 2, op: 'unlock', args: { mnemonic: PHRASE, imported: [{ chain: 'evm', address: addr, secret: evmKey }] } });
  assert.ok((await core.handle({ id: 3, op: 'evmSignMessage', args: { address: addr, text: 'x' } })).ok);
  await core.handle({ id: 4, op: 'lock' });
  await core.handle({ id: 5, op: 'unlock', args: { mnemonic: PHRASE } });
  assert.strictEqual((await core.handle({ id: 6, op: 'evmSignMessage', args: { address: addr, text: 'x' } })).error, 'unknown account');
  // ключ, чия адреса не збігається із заявленою, відхиляється
  await core.handle({ id: 7, op: 'unlock', args: { mnemonic: PHRASE, imported: [{ chain: 'evm', address: '0x000000000000000000000000000000000000dEaD', secret: evmKey }] } });
  assert.strictEqual((await core.handle({ id: 8, op: 'evmSignMessage', args: { address: '0x000000000000000000000000000000000000dEaD', text: 'x' } })).error, 'key mismatch');
});

test('signer-arweave: підпис ключем Arweave перевіряється відкритим ключем', async () => {
  const jwk = arweave.generateArweaveJwk();
  const core = createCore();
  assert.strictEqual((await core.handle({ id: 0, op: 'unlock', args: { mnemonic: PHRASE } })).ok, true);
  assert.strictEqual((await core.handle({ id: 1, op: 'arSign', args: { data: Buffer.from('x') } })).error, 'no arweave key');
  await core.handle({ id: 2, op: 'unlock', args: { mnemonic: PHRASE, arweave: jwk } });
  const data = Buffer.from('дані Arweave');
  const r = await core.handle({ id: 3, op: 'arSign', args: { data } });
  assert.ok(r.ok, r.error);
  assert.strictEqual(arweave.verifySignature(jwk, data, Buffer.from(r.result.signature)), true);
  assert.strictEqual(arweave.verifySignature(jwk, Buffer.from('інші'), Buffer.from(r.result.signature)), false);
  assert.strictEqual((await core.handle({ id: 4, op: 'arSign', args: { data: 'рядок' } })).ok, false);
});

// ---- стейкінг: адреса Stake Program береться з експорту solana.js (раніше S.P був undefined, і виклики падали) ----
test('solana-staking: solStakeAccounts запитує програму Stake за адресою PROGRAMS.STAKE', async () => {
  const proto = {};
  require('../../src/wallet-solana-staking').installStaking(proto, { S, RpcError: Error, clip: (x) => x, unauthorized: Error });
  let seen = null;
  const me = solAt(0);
  const out = await proto.solStakeAccounts.call({ solCluster: () => 'devnet', solRpc: async (_c, method, params) => { seen = { method, params }; return []; } }, me);
  assert.deepStrictEqual(out, []);
  assert.strictEqual(seen.method, 'getParsedProgramAccounts');
  assert.strictEqual(seen.params[0], S.PROGRAMS.STAKE);
  assert.strictEqual(seen.params[1].filters[0].memcmp.bytes, me);
});
