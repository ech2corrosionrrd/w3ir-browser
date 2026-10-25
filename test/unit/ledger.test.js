'use strict';
// Імітований пристрій Ledger (застосунок Ethereum): збирає HID-пакети в APDU, підписує тестовим ключем і відповідає
// у форматі пристрою. Перевіряє кадрування, кодування шляху, порційну передачу, відновлення паритету та підписувач.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SigningKey, Wallet, keccak256, getBytes, Transaction, hashMessage, TypedDataEncoder, verifyMessage, verifyTypedData, recoverAddress,
} = require('ethers');
const { Transport, EthApp, LedgerSigner, encodePath, toPackets, readResponse } = require('../../src/ledger');

const KEY = '0x' + '11'.repeat(32);
const WALLET = new Wallet(KEY);
const PATH = "m/44'/60'/0'/0/0";

function makeDevice({ key = KEY, sw = 0x9000, vMode = 'parity', open = true } = {}) {
  const sk = new SigningKey(key);
  const addr = new Wallet(key).address;
  const log = [];
  let apduBuf = null; let want = 0; const pending = [];
  let chunks = [];
  const reply = (data, status = 0x9000) => {
    const body = Buffer.concat([data, Buffer.from([status >> 8, status & 0xff])]);
    const framed = Buffer.concat([Buffer.from([body.length >> 8, body.length & 0xff]), body]);
    for (let seq = 0, off = 0; off < framed.length; seq++) {
      const head = Buffer.from([0x01, 0x01, 0x05, seq >> 8, seq & 0xff]);
      const pkt = Buffer.alloc(64); head.copy(pkt); framed.subarray(off, off + 59).copy(pkt, 5);
      pending.push(pkt); off += 59;
    }
  };
  const sigOf = (digest, v0) => {
    const s = sk.sign(digest);
    const v = vMode === 'parity' ? s.yParity : 27 + s.yParity;
    return Buffer.concat([Buffer.from([v0 === undefined ? v : v0]), getBytes(s.r), getBytes(s.s)]);
  };
  const handle = (a) => {
    log.push(a);
    const [cla, ins, p1, , lc] = a;
    const data = a.subarray(5, 5 + lc);
    if (!open) return reply(Buffer.alloc(0), 0x6e00);
    if (sw !== 0x9000) return reply(Buffer.alloc(0), sw);
    if (cla !== 0xe0) return reply(Buffer.alloc(0), 0x6e00);
    if (ins === 0x02) {
      const n = data[0];
      assert.ok(n >= 1 && data.length === 1 + n * 4);
      const pub = Buffer.from(getBytes(sk.publicKey));
      return reply(Buffer.concat([Buffer.from([65]), pub, Buffer.from([40]), Buffer.from(addr.slice(2).toLowerCase(), 'ascii')]));
    }
    if (ins === 0x04 || ins === 0x08) {
      if (p1 === 0x00) { chunks = []; const n = data[0]; chunks.push({ head: data.subarray(0, 1 + n * 4 + (ins === 0x08 ? 4 : 0)), body: data.subarray(1 + n * 4 + (ins === 0x08 ? 4 : 0)) }); }
      else chunks.push({ head: null, body: data });
      const body = Buffer.concat(chunks.map(c => c.body));
      if (ins === 0x08) {
        const len = chunks[0].head.readUInt32BE(chunks[0].head.length - 4);
        if (body.length < len) return reply(Buffer.alloc(0));
        return reply(sigOf(hashMessage(body)));
      }
      // транзакція: довжина невідома заздалегідь; спробуємо розібрати накопичене
      let parsed = null;
      try { parsed = Transaction.from(('0x' + body.toString('hex'))); } catch { /* неповні дані */ }
      if (!parsed) return reply(Buffer.alloc(0));
      return reply(sigOf(keccak256(body), vMode === 'eip155' && parsed.type === null ? Number(parsed.chainId) * 2 + 35 + sk.sign(keccak256(body)).yParity : undefined));
    }
    if (ins === 0x0c) {
      const n = data[0];
      const dom = data.subarray(1 + n * 4, 33 + n * 4), st = data.subarray(33 + n * 4, 65 + n * 4);
      return reply(sigOf(keccak256(Buffer.concat([Buffer.from([0x19, 0x01]), dom, st]))));
    }
    return reply(Buffer.alloc(0), 0x6d00);
  };
  const io = {
    async write(p) {
      if (!apduBuf) { want = p.readUInt16BE(5); apduBuf = Buffer.from(p.subarray(7, 7 + Math.min(want, 57))); }
      else apduBuf = Buffer.concat([apduBuf, p.subarray(5, 5 + Math.min(want - apduBuf.length, 59))]);
      if (apduBuf.length >= want) { const a = apduBuf; apduBuf = null; handle(a); }
    },
    async read() { return pending.shift(); },
  };
  return { io, log, address: addr };
}

const appFor = (opts) => { const d = makeDevice(opts); return { d, app: new EthApp(new Transport(d.io)) }; };

test('ledger: кодування шляху деривації', () => {
  assert.equal(encodePath(PATH).toString('hex'), '058000002c8000003c800000000000000000000000');
  assert.throws(() => encodePath('44/60'), /шлях/);
  assert.throws(() => encodePath("m/44'/abc"), /шлях/);
});

test('ledger: кадрування — довгий APDU розбивається на пакети по 64 байти й збирається назад', async () => {
  const apdu = Buffer.alloc(150, 7);
  const pk = toPackets(apdu);
  assert.ok(pk.length > 1 && pk.every(p => p.length === 64));
  assert.equal(pk[0].readUInt16BE(5), 150);
  assert.equal(pk[1].readUInt16BE(3), 1);
  // відповідь у кількох пакетах
  const body = Buffer.concat([Buffer.alloc(100, 9), Buffer.from([0x90, 0x00])]);
  const framed = Buffer.concat([Buffer.from([0, body.length]), body]);
  const out = [];
  for (let seq = 0, off = 0; off < framed.length; seq++) {
    const p = Buffer.alloc(64); Buffer.from([1, 1, 5, 0, seq]).copy(p); framed.subarray(off, off + 59).copy(p, 5); out.push(p); off += 59;
  }
  const r = await readResponse(async () => out.shift());
  assert.equal(r.length, 102);
});

test('ledger: адреса з пристрою (контрольна сума) і публічний ключ', async () => {
  const { app } = appFor();
  const r = await app.getAddress(PATH);
  assert.equal(r.address, WALLET.address);
  assert.equal(r.publicKey.length, 132);
});

test('ledger: підпис повідомлення відновлюється до адреси (v = 27/28)', async () => {
  const { app } = appFor({ vMode: 'v27' });
  const signer = new LedgerSigner(app, PATH, WALLET.address);
  const sig = await signer.signMessage('Привіт, Ledger');
  assert.equal(verifyMessage('Привіт, Ledger', sig), WALLET.address);
});

test('ledger: довге повідомлення передається порціями', async () => {
  const { app, d } = appFor();
  const msg = 'x'.repeat(600);
  const signer = new LedgerSigner(app, PATH, WALLET.address);
  const sig = await signer.signMessage(msg);
  assert.equal(verifyMessage(msg, sig), WALLET.address);
  assert.ok(d.log.filter(a => a[1] === 0x08).length >= 4);
  assert.equal(d.log.filter(a => a[1] === 0x08)[1][2], 0x80);
});

test('ledger: транзакція EIP-1559 підписується, підпис відновлюється до адреси', async () => {
  const { app } = appFor();
  const signer = new LedgerSigner(app, PATH, WALLET.address);
  const raw = await signer.signTransaction({ chainId: 1, type: 2, nonce: 3, to: '0x000000000000000000000000000000000000dEaD', value: 10n ** 15n, gasLimit: 21000n, maxFeePerGas: 30n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n, data: '0x' });
  const tx = Transaction.from(raw);
  assert.equal(tx.from, WALLET.address);
  assert.equal(tx.nonce, 3);
});

test('ledger: транзакція з великими даними (кілька порцій) і EIP-155 v', async () => {
  const { app, d } = appFor({ vMode: 'eip155' });
  const signer = new LedgerSigner(app, PATH, WALLET.address);
  const data = '0x' + 'ab'.repeat(400);
  const raw = await signer.signTransaction({ chainId: 137, nonce: 0, to: '0x000000000000000000000000000000000000dEaD', value: 0n, gasLimit: 100000n, gasPrice: 10n ** 9n, data });
  assert.equal(Transaction.from(raw).from, WALLET.address);
  assert.ok(d.log.filter(a => a[1] === 0x04).length >= 3);
});

test('ledger: типізовані дані EIP-712 (хеші домену й структури)', async () => {
  const { app } = appFor();
  const signer = new LedgerSigner(app, PATH, WALLET.address);
  const domain = { name: 'Тест', version: '1', chainId: 1, verifyingContract: '0x000000000000000000000000000000000000dEaD' };
  const types = { Mail: [{ name: 'to', type: 'address' }, { name: 'text', type: 'string' }] };
  const value = { to: '0x000000000000000000000000000000000000dEaD', text: 'hi' };
  const sig = await signer.signTypedData(domain, types, value);
  assert.equal(verifyTypedData(domain, types, value, sig), WALLET.address);
});

test('ledger: підпис пристроєм з іншим ключем відхиляється', async () => {
  const { app } = appFor({ key: '0x' + '22'.repeat(32) });
  const signer = new LedgerSigner(app, PATH, WALLET.address);
  await assert.rejects(signer.signMessage('x'), /не відповідає адресі/);
});

test('ledger: транзакція від іншої адреси відхиляється ще до звернення до пристрою', async () => {
  const { app, d } = appFor();
  const signer = new LedgerSigner(app, PATH, WALLET.address);
  await assert.rejects(signer.signTransaction({ chainId: 1, from: '0x000000000000000000000000000000000000dEaD', to: '0x000000000000000000000000000000000000dEaD', nonce: 0, gasLimit: 21000n, gasPrice: 1n }), /mismatch/);
  assert.equal(d.log.length, 0);
});

test('ledger: коди помилок пристрою перетворюються на зрозумілі повідомлення', async () => {
  for (const [sw, re, code] of [[0x6985, /відхилено/, 4001], [0x6a80, /Blind signing/, -32000], [0x6e00, /Ethereum/, -32000], [0x5515, /заблоковано/, -32000], [0x1234, /0x1234/, -32000]]) {
    const { app } = appFor({ sw });
    await assert.rejects(app.getAddress(PATH), (e) => re.test(e.message) && e.code === code, 'sw ' + sw.toString(16));
  }
});

test('ledger: обміни виконуються по черзі навіть при паралельних викликах', async () => {
  const { app } = appFor();
  const rs = await Promise.all([app.getAddress(PATH), app.getAddress("m/44'/60'/1'/0/0"), app.getAddress("m/44'/60'/2'/0/0")]);
  assert.ok(rs.every(r => r.address === WALLET.address));
});

test('ledger: recoverAddress використовується для визначення паритету (sanity)', () => {
  const sk = new SigningKey(KEY);
  const d = keccak256('0x01');
  const s = sk.sign(d);
  assert.equal(recoverAddress(d, s), WALLET.address);
  assert.ok(TypedDataEncoder);
});
