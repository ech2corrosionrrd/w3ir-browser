'use strict';
// Ядро процесу-підписувача гаманця (див. docs/adr/0001-wallet-signer-process.md): тримає seed і виводить з нього адреси.
// Не залежить від Electron, тому тестується в Node; транспорт повідомлень — у wallet-signer.js.
// Відповідь завжди { id, ok, result | error }; у помилках не буває фрази, seed чи ключів.
const crypto = require('crypto');
const { Mnemonic, HDNodeWallet, Wallet, Transaction, getBytes } = require('ethers');
const { EVM_PATHS } = require('./wallet-evm-core');
const S = require('./solana');

const MAX_INDEX = 1000;
const MAX_IMPORTED = 20;

function createCore() {
  let st = null; // { mnemonic, passphrase, evmPath, solPath, seed: Buffer, evm: Map<індекс, HDNodeWallet> }
  const need = () => { if (!st) throw new Error('locked'); return st; };
  const zero = () => {
    if (!st) return;
    st.seed.fill(0);
    for (const k of st.imp.values()) if (Buffer.isBuffer(k.secret)) k.secret.fill(0);
    st.evm.clear(); st.imp.clear(); st.ar = null; st = null;
  };
  const index = (v) => { if (!Number.isInteger(v) || v < 0 || v > MAX_INDEX) throw new Error('bad index'); return v; };

  // Рахунок EVM: за індексом (похідний від фрази) або за адресою (імпортований за приватним ключем); кешується до блокування
  const evmWallet = (s, args) => {
    if (args && typeof args.address === 'string') {
      const k = s.imp.get('evm:' + args.address);
      if (!k) throw new Error('unknown account');
      let w = s.evm.get(k.address);
      if (!w) { w = new Wallet(k.secret); if (w.address !== k.address) throw new Error('key mismatch'); s.evm.set(k.address, w); }
      return w;
    }
    const n = index(args && args.index);
    let w = s.evm.get(n);
    if (!w) { w = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(s.mnemonic, s.passphrase), EVM_PATHS[s.evmPath](n)); s.evm.set(n, w); }
    return w;
  };
  // Ключ Solana: за індексом (похідний) або за адресою (імпортований; seed 32 байти)
  const solKeypair = (s, args) => {
    if (args && typeof args.address === 'string' && args.index === undefined) {
      const k = s.imp.get('sol:' + args.address);
      if (!k) throw new Error('unknown account');
      const kp = S.keypairFromSeed(k.secret);
      if (kp.address !== k.address) throw new Error('key mismatch');
      return kp;
    }
    return S.deriveAccount(s.seed, index(args && args.index), s.solPath);
  };

  const ops = {
    ping: () => ({ pong: true }),
    status: () => ({ unlocked: !!st }),
    // Seed передається один раз при розблокуванні (варіант A з ADR); повторне розблокування замінює попередній стан
    unlock: ({ mnemonic, passphrase = '', evmPath = 'standard', solPath = 'phantom', imported = [], arweave = null } = {}) => {
      if (typeof mnemonic !== 'string' || typeof passphrase !== 'string' || !Mnemonic.isValidMnemonic(mnemonic)) throw new Error('bad mnemonic');
      if (passphrase.length > 128 || !EVM_PATHS[evmPath] || !S.SOL_PATHS[solPath]) throw new Error('bad options');
      const seed = Buffer.from(Mnemonic.fromPhrase(mnemonic, passphrase).computeSeed().slice(2), 'hex');
      const imp = new Map();
      if (!Array.isArray(imported) || imported.length > MAX_IMPORTED) throw new Error('bad imported');
      for (const a of imported) {
        if (!a || (a.chain !== 'evm' && a.chain !== 'sol') || typeof a.address !== 'string' || typeof a.secret !== 'string') throw new Error('bad imported');
        imp.set(a.chain + ':' + a.address, { address: a.address, secret: a.chain === 'sol' ? Buffer.from(a.secret, 'base64') : a.secret });
      }
      if (arweave !== null && !(arweave && typeof arweave.n === 'string' && typeof arweave.d === 'string')) throw new Error('bad arweave key');
      zero();
      st = { mnemonic, passphrase, evmPath, solPath, seed, evm: new Map(), imp, ar: arweave };
      return {};
    },
    lock: () => { zero(); return {}; },
    // Підпис EVM: головний процес надсилає вже схвалений запит; транзакція — непідписане серіалізоване тіло (hex)
    evmSignTx: (args = {}) => {
      const { raw } = args;
      const w = evmWallet(need(), args);
      if (typeof raw !== 'string') throw new Error('bad tx');
      const tx = Transaction.from(raw);
      if (tx.signature) throw new Error('tx already signed');
      tx.signature = w.signingKey.sign(tx.unsignedHash);
      return { signed: tx.serialized };
    },
    evmSignMessage: async (args = {}) => {
      const { text, hex } = args;
      const w = evmWallet(need(), args);
      if (typeof text === 'string') return { signature: await w.signMessage(text) };
      if (typeof hex === 'string') return { signature: await w.signMessage(getBytes(hex)) };
      throw new Error('bad message');
    },
    evmSignTyped: async (args = {}) => {
      const { domain, types, value } = args;
      const w = evmWallet(need(), args);
      if (!domain || !types || !value) throw new Error('bad typed data');
      return { signature: await w.signTypedData(domain, types, value) };
    },
    // Підпис Solana: похідний ключ існує лише всередині виклику; повідомлення й транзакції головний процес уже схвалив
    solSign: (args = {}) => {
      const s = need();
      const { message } = args;
      if (!ArrayBuffer.isView(message)) throw new Error('bad message');
      const kp = solKeypair(s, args);
      return { signature: S.sign(kp.secret, message) };
    },
    solSignTx: (args = {}) => {
      const s = need();
      const { address, wire } = args;
      if (typeof address !== 'string' || !ArrayBuffer.isView(wire)) throw new Error('bad tx');
      const kp = solKeypair(s, args);
      if (kp.address !== address) throw new Error('address mismatch');
      const r = S.signTransaction(kp.secret, address, Buffer.from(wire));
      return { signedWire: r.signedWire, signature: r.signature, index: r.index };
    },
    // Підпис даних ключем Arweave (RSASSA-PSS SHA-256, як signData у wallet-arweave.js)
    arSign: ({ data } = {}) => {
      const s = need();
      if (!s.ar) throw new Error('no arweave key');
      if (!ArrayBuffer.isView(data)) throw new Error('bad data');
      const signer = crypto.createSign('sha256');
      signer.update(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      return { signature: signer.sign({ key: crypto.createPrivateKey({ key: s.ar, format: 'jwk' }), padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }) };
    },
    address: ({ chain, index: i } = {}) => {
      const s = need();
      const n = index(i);
      if (chain === 'evm') return { address: evmWallet(s, { index: n }).address };
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
