'use strict';
// Ядро процесу-підписувача гаманця (див. docs/adr/0001-wallet-signer-process.md): тримає seed і виводить з нього адреси.
// Не залежить від Electron, тому тестується в Node; транспорт повідомлень — у wallet-signer.js.
// Відповідь завжди { id, ok, result | error }; у помилках не буває фрази, seed чи ключів.
const { Mnemonic, HDNodeWallet } = require('ethers');
const { EVM_PATHS } = require('./wallet-evm-core');
const S = require('./solana');

const MAX_INDEX = 1000;

function createCore() {
  let st = null; // { mnemonic, passphrase, evmPath, solPath, seed: Buffer }
  const need = () => { if (!st) throw new Error('locked'); return st; };
  const zero = () => { if (st) { st.seed.fill(0); st = null; } };
  const index = (v) => { if (!Number.isInteger(v) || v < 0 || v > MAX_INDEX) throw new Error('bad index'); return v; };

  const ops = {
    ping: () => ({ pong: true }),
    status: () => ({ unlocked: !!st }),
    // Seed передається один раз при розблокуванні (варіант A з ADR); повторне розблокування замінює попередній стан
    unlock: ({ mnemonic, passphrase = '', evmPath = 'standard', solPath = 'phantom' } = {}) => {
      if (typeof mnemonic !== 'string' || typeof passphrase !== 'string' || !Mnemonic.isValidMnemonic(mnemonic)) throw new Error('bad mnemonic');
      if (passphrase.length > 128 || !EVM_PATHS[evmPath] || !S.SOL_PATHS[solPath]) throw new Error('bad options');
      const seed = Buffer.from(Mnemonic.fromPhrase(mnemonic, passphrase).computeSeed().slice(2), 'hex');
      zero();
      st = { mnemonic, passphrase, evmPath, solPath, seed };
      return {};
    },
    lock: () => { zero(); return {}; },
    address: ({ chain, index: i } = {}) => {
      const s = need();
      const n = index(i);
      if (chain === 'evm') return { address: HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(s.mnemonic, s.passphrase), EVM_PATHS[s.evmPath](n)).address };
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
