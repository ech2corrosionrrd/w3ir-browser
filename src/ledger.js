'use strict';
// Ledger (Nano S/S Plus/X/Stax) для EVM: протокол HID-кадрів, APDU застосунку Ethereum та підписувач ethers.
// ЕКСПЕРИМЕНТАЛЬНО: протокол реалізовано за специфікацією застосунку Ledger Ethereum і перевірено лише на імітованому
// пристрої (test/unit/ledger.test.js); на справжньому пристрої перевірте, що адреса й підпис збігаються. Приватний ключ
// нікуди не залишає пристрій, кожен підпис підтверджується кнопками на самому Ledger.
const {
  AbstractSigner, Transaction, getAddress, getBytes, Signature, recoverAddress,
  hashMessage, TypedDataEncoder, resolveProperties, resolveAddress, copyRequest, assertArgument,
} = require('ethers');

const PACKET = 64;
const CHANNEL = 0x0101;
const TAG = 0x05;
const CLA = 0xe0;
const INS = { GET_ADDRESS: 0x02, SIGN_TX: 0x04, SIGN_MESSAGE: 0x08, SIGN_EIP712_HASHED: 0x0c };
const CHUNK = 150;
const PATH_RE = /^m(\/\d{1,9}'?){1,10}$/;

class LedgerError extends Error {
  constructor(message, { code = -32000, sw = 0 } = {}) { super(message); this.name = 'LedgerError'; this.code = code; this.sw = sw; }
}

// Статуси відповіді → зрозуміле повідомлення (4001 — користувач відхилив на пристрої)
function statusError(sw) {
  if (sw === 0x6985 || sw === 0x6986) return new LedgerError('Підпис відхилено на пристрої Ledger.', { code: 4001, sw });
  if (sw === 0x6a80) return new LedgerError('Ledger відхилив дані. Увімкніть «Blind signing» у застосунку Ethereum на пристрої та повторіть.', { sw });
  if (sw === 0x6e00 || sw === 0x6d00 || sw === 0x6511 || sw === 0x6e01) return new LedgerError('Відкрийте на Ledger застосунок «Ethereum» і повторіть.', { sw });
  if (sw === 0x5515 || sw === 0x6b0c || sw === 0x6804) return new LedgerError('Ledger заблоковано: розблокуйте пристрій і повторіть.', { sw });
  return new LedgerError(`Помилка Ledger (0x${sw.toString(16)}).`, { sw });
}

// "m/44'/60'/0'/0/0" → [кількість, ...u32 BE зі старшим бітом для «'»]
function encodePath(path) {
  if (typeof path !== 'string' || !PATH_RE.test(path)) throw new LedgerError('Некоректний шлях деривації.');
  const parts = path.split('/').slice(1);
  const out = Buffer.alloc(1 + parts.length * 4);
  out[0] = parts.length;
  parts.forEach((p, i) => {
    const hard = p.endsWith("'");
    const n = Number(hard ? p.slice(0, -1) : p);
    if (!Number.isInteger(n) || n < 0 || n >= 0x80000000) throw new LedgerError('Некоректний шлях деривації.');
    out.writeUInt32BE((hard ? 0x80000000 : 0) + n, 1 + i * 4);
  });
  return out;
}

// APDU → пакети HID по 64 байти: канал(2) тег(1) номер(2) [довжина(2) лише в першому] дані
function toPackets(apdu) {
  const data = Buffer.concat([Buffer.from([apdu.length >> 8, apdu.length & 0xff]), apdu]);
  const out = [];
  for (let seq = 0, off = 0; off < data.length; seq++) {
    const head = Buffer.from([CHANNEL >> 8, CHANNEL & 0xff, TAG, seq >> 8, seq & 0xff]);
    const body = data.subarray(off, off + PACKET - head.length);
    const pkt = Buffer.alloc(PACKET);
    head.copy(pkt); body.copy(pkt, head.length);
    out.push(pkt);
    off += body.length;
  }
  return out;
}

// Зчитує відповідь із пакетів: readPacket() → Buffer(64). Повертає дані відповіді разом із SW (2 останні байти).
async function readResponse(readPacket) {
  let first = await readPacket();
  const check = (p, seq) => {
    if (p.length < 5 || p.readUInt16BE(0) !== CHANNEL || p[2] !== TAG || p.readUInt16BE(3) !== seq) throw new LedgerError('Некоректна відповідь Ledger (кадр).');
  };
  check(first, 0);
  const total = first.readUInt16BE(5);
  if (total < 2 || total > 4096) throw new LedgerError('Некоректна відповідь Ledger (довжина).');
  let acc = Buffer.from(first.subarray(7, 7 + Math.min(total, PACKET - 7)));
  for (let seq = 1; acc.length < total; seq++) {
    const p = await readPacket();
    check(p, seq);
    acc = Buffer.concat([acc, p.subarray(5, 5 + Math.min(total - acc.length, PACKET - 5))]);
  }
  return acc;
}

// Транспорт над сирими пакетами: io = { write(Buffer64), read() → Promise<Buffer64>, begin()? }. Обміни виконуються по черзі.
class Transport {
  constructor(io) { this.io = io; this.chain = Promise.resolve(); }
  exchange(apdu) {
    const run = async () => {
      if (this.io.begin) await this.io.begin(); // скинути залишки попереднього обміну
      for (const p of toPackets(apdu)) await this.io.write(p);
      const resp = await readResponse(() => this.io.read());
      const sw = resp.readUInt16BE(resp.length - 2);
      if (sw !== 0x9000) throw statusError(sw);
      return resp.subarray(0, resp.length - 2);
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }
}

const apdu = (ins, p1, p2, data) => {
  if (data.length > 255) throw new LedgerError('Надто великий фрагмент даних.');
  return Buffer.concat([Buffer.from([CLA, ins, p1, p2, data.length]), data]);
};

// Застосунок Ethereum на пристрої
class EthApp {
  constructor(transport) { this.t = transport; }

  async getAddress(path, display = false) {
    const r = await this.t.exchange(apdu(INS.GET_ADDRESS, display ? 0x01 : 0x00, 0x00, encodePath(path)));
    const pkLen = r[0];
    const addrLen = r[1 + pkLen];
    if (pkLen !== 65 || addrLen !== 40 || r.length < 2 + pkLen + addrLen) throw new LedgerError('Некоректна відповідь Ledger (адреса).');
    const address = getAddress('0x' + r.subarray(2 + pkLen, 2 + pkLen + addrLen).toString('ascii'));
    return { address, publicKey: '0x' + r.subarray(1, 1 + pkLen).toString('hex') };
  }

  // Порційно: перший фрагмент містить шлях (і довжину для повідомлення), далі — лише дані (P1 = 0x80)
  async _chunked(ins, head, payload) {
    let first = true, off = 0, last = null;
    while (first || off < payload.length) {
      const room = CHUNK - (first ? head.length : 0);
      const part = payload.subarray(off, off + room);
      last = await this.t.exchange(apdu(ins, first ? 0x00 : 0x80, 0x00, first ? Buffer.concat([head, part]) : part));
      off += part.length;
      first = false;
    }
    return last;
  }

  _sig(r) {
    if (r.length < 65) throw new LedgerError('Некоректна відповідь Ledger (підпис).');
    return { v: r[0], r: '0x' + r.subarray(1, 33).toString('hex'), s: '0x' + r.subarray(33, 65).toString('hex') };
  }

  async signTransaction(path, unsignedHex) { return this._sig(await this._chunked(INS.SIGN_TX, encodePath(path), Buffer.from(getBytes(unsignedHex)))); }

  async signPersonalMessage(path, bytes) {
    const len = Buffer.alloc(4); len.writeUInt32BE(bytes.length);
    return this._sig(await this._chunked(INS.SIGN_MESSAGE, Buffer.concat([encodePath(path), len]), Buffer.from(bytes)));
  }

  async signHashedTypedData(path, domainHash, structHash) {
    const data = Buffer.concat([encodePath(path), Buffer.from(getBytes(domainHash)), Buffer.from(getBytes(structHash))]);
    return this._sig(await this.t.exchange(apdu(INS.SIGN_EIP712_HASHED, 0x00, 0x00, data)));
  }
}

// Пристрій повертає v у різних форматах (EIP-155, чистий паритет, обрізаний байт): паритет визначаємо відновленням адреси
function toSignature(raw, digest, address) {
  for (const yParity of [0, 1]) {
    const sig = Signature.from({ r: raw.r, s: raw.s, yParity });
    try { if (recoverAddress(digest, sig) === address) return sig; } catch { /* інший паритет */ }
  }
  throw new LedgerError('Підпис Ledger не відповідає адресі рахунку: перевірте, що відкрито правильний пристрій і шлях.');
}

class LedgerSigner extends AbstractSigner {
  // app — EthApp; path — шлях деривації; address — адреса, збережена в гаманці (підпис іншим рахунком відхиляється)
  constructor(app, path, address, provider = null) {
    super(provider);
    this.app = app; this.path = path; this.address = getAddress(address);
  }

  async getAddress() { return this.address; }

  connect(provider) { return new LedgerSigner(this.app, this.path, this.address, provider); }

  async signTransaction(_tx) {
    const tx = copyRequest(_tx);
    const { to, from } = await resolveProperties({
      to: tx.to ? resolveAddress(tx.to, this.provider) : undefined,
      from: tx.from ? resolveAddress(tx.from, this.provider) : undefined,
    });
    if (to != null) tx.to = to;
    if (from != null) tx.from = from;
    if (tx.from != null) { assertArgument(getAddress(tx.from) === this.address, 'transaction from address mismatch', 'tx.from', tx.from); delete tx.from; }
    const btx = Transaction.from(tx);
    const raw = await this.app.signTransaction(this.path, btx.unsignedSerialized);
    btx.signature = toSignature(raw, btx.unsignedHash, this.address);
    return btx.serialized;
  }

  async signMessage(message) {
    const bytes = typeof message === 'string' ? Buffer.from(message, 'utf8') : Buffer.from(message);
    const raw = await this.app.signPersonalMessage(this.path, bytes);
    return toSignature(raw, hashMessage(bytes), this.address).serialized;
  }

  async signTypedData(domain, types, value) {
    const populated = await TypedDataEncoder.resolveNames(domain, types, value, async (name) => resolveAddress(name, this.provider));
    const enc = TypedDataEncoder.from(types);
    const domainHash = TypedDataEncoder.hashDomain(populated.domain);
    const structHash = enc.hash(populated.value);
    const raw = await this.app.signHashedTypedData(this.path, domainHash, structHash);
    return toSignature(raw, TypedDataEncoder.hash(populated.domain, types, populated.value), this.address).serialized;
  }
}

// Шляхи: «Ledger Live» (m/44'/60'/i'/0/0) і стандартний (m/44'/60'/0'/0/i)
const PATHS = {
  ledgerLive: (i) => `m/44'/60'/${i}'/0/0`,
  standard: (i) => `m/44'/60'/0'/0/${i}`,
};

module.exports = { Transport, EthApp, LedgerSigner, LedgerError, encodePath, toPackets, readResponse, PATHS };
