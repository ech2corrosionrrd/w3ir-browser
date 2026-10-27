'use strict';
// Ядро процесу-підписувача гаманця (див. docs/adr/0001-wallet-signer-process.md): тримає seed і виводить з нього адреси.
// Не залежить від Electron, тому тестується в Node; транспорт повідомлень — у wallet-signer.js.
// Відповідь завжди { id, ok, result | error }; у помилках не буває фрази, seed чи ключів.
const { Mnemonic, HDNodeWallet, Transaction, getBytes } = require('ethers');
const { EVM_PATHS } = require('./wallet-evm-core');
const S = require('./solana');

const MAX_INDEX = 1000;

function createCore() {
  let st = null; // { mnemonic, passphrase, evmPath, solPath, seed: Buffer, evm: Map<індекс, HDNodeWallet> }
  const need = () => { if (!st) throw new Error('locked'); return st; };
  const zero = () => { if (st) { st.seed.fill(0); st.evm.clear(); st = null; } };
  const index = (v) => { if (!Number.isInteger(v) || v < 0 || v > MAX_INDEX) throw new Error('bad index'); return v; };

  // Похідний рахунок EVM кешується до блокування (виведення з фрази — кілька мс)
  const evmWallet = (s, n) => {
    let w = s.evm.get(n);
    if (!w) { w = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(s.mnemonic, s.passphrase), EVM_PATHS[s.evmPath](n)); s.evm.set(n, w); }
    return w;
  };

  const ops = {
    ping: () => ({ pong: true }),
    status: () => ({ unlocked: !!st }),
    // Seed передається один раз при розблокуванні (варіант A з ADR); повторне розблокування замінює попередній стан
    unlock: ({ mnemonic, passphrase = '', evmPath = 'standard', solPath = 'phantom' } = {}) => {
      if (typeof mnemonic !== 'string' || typeof passphrase !== 'string' || !Mnemonic.isValidMnemonic(mnemonic)) throw new Error('bad mnemonic');
      if (passphrase.length > 128 || !EVM_PATHS[evmPath] || !S.SOL_PATHS[solPath]) throw new Error('bad options');
      const seed = Buffer.from(Mnemonic.fromPhrase(mnemonic, passphrase).computeSeed().slice(2), 'hex');
      zero();
      st = { mnemonic, passphrase, evmPath, solPath, seed, evm: new Map() };
      return {};
    },
    lock: () => { zero(); return {}; },
    // Підпис EVM: головний процес надсилає вже схвалений запит; транзакція — непідписане серіалізоване тіло (hex)
    evmSignTx: ({ index: i, raw } = {}) => {
      const w = evmWallet(need(), index(i));
      if (typeof raw !== 'string') throw new Error('bad tx');
      const tx = Transaction.from(raw);
      if (tx.signature) throw new Error('tx already signed');
      tx.signature = w.signingKey.sign(tx.unsignedHash);
      return { signed: tx.serialized };
    },
    evmSignMessage: async ({ index: i, text, hex } = {}) => {
      const w = evmWallet(need(), index(i));
      if (typeof text === 'string') return { signature: await w.signMessage(text) };
      if (typeof hex === 'string') return { signature: await w.signMessage(getBytes(hex)) };
      throw new Error('bad message');
    },
    evmSignTyped: async ({ index: i, domain, types, value } = {}) => {
      const w = evmWallet(need(), index(i));
      if (!domain || !types || !value) throw new Error('bad typed data');
      return { signature: await w.signTypedData(domain, types, value) };
    },
    // Підпис Solana: похідний ключ існує лише всередині виклику; повідомлення й транзакції головний процес уже схвалив
    solSign: ({ index: i, message } = {}) => {
      const s = need();
      if (!ArrayBuffer.isView(message)) throw new Error('bad message');
      const kp = S.deriveAccount(s.seed, index(i), s.solPath);
      return { signature: S.sign(kp.secret, message) };
    },
    solSignTx: ({ index: i, address, wire } = {}) => {
      const s = need();
      if (typeof address !== 'string' || !ArrayBuffer.isView(wire)) throw new Error('bad tx');
      const kp = S.deriveAccount(s.seed, index(i), s.solPath);
      if (kp.address !== address) throw new Error('address mismatch');
      const r = S.signTransaction(kp.secret, address, Buffer.from(wire));
      return { signedWire: r.signedWire, signature: r.signature, index: r.index };
    },
    address: ({ chain, index: i } = {}) => {
      const s = need();
      const n = index(i);
      if (chain === 'evm') return { address: evmWallet(s, n).address };
      if (chain === 'sol') return { address: S.deriveAccount(s.seed, n, s.solPath).address };
      throw new Error('bad chain');
    },
  };

  async function handle(req) {
    const id = req && typeof req === 'object' ? req.id : undefined;
    try {
      if (!req || typeof req !== 'object' || typeof req.op !== 'string' || !Object.prototype.hasOwnProperty.call(ops, req.op)) throw new Error('unknown op');
      return { id, ok: true, result: await ops[req.op](req.args) };
    } catch (e) {
      return { id, ok: false, error: String(e && e.message || e).slice(0, 120) };
    }
  }

  return { handle, isUnlocked: () => !!st };
}

module.exports = { createCore, MAX_INDEX };
