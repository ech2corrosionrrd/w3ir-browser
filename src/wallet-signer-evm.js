'use strict';
// EVM-підписувач ethers, що віддає підпис процесу-підписувачу (docs/adr/0001-wallet-signer-process.md). Працює за прапором
// W3IR_SIGNER=1 (етап 2 плану S1): Wallet.signerFor() повертає RemoteEvmSigner замість HDNodeWallet, тож похідний ключ
// не створюється в головному процесі. Підписувач ethers тут лише готує запит так само, як LedgerSigner (ledger.js).
const {
  AbstractSigner, Transaction, getAddress, TypedDataEncoder, resolveProperties, resolveAddress, copyRequest, assertArgument,
} = require('ethers');
const { SignerClient } = require('./wallet-signer-client');

class RemoteEvmSigner extends AbstractSigner {
  // call(op, args) — виклик підписувача (вже після розблокування); index — номер рахунку; address — адреса, збережена в гаманці
  constructor(call, index, address, provider = null) {
    super(provider);
    this.call = call; this.index = index; this.address = getAddress(address);
  }

  async getAddress() { return this.address; }

  connect(provider) { return new RemoteEvmSigner(this.call, this.index, this.address, provider); }

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
    const r = await this.call('evmSignTx', { index: this.index, raw: btx.unsignedSerialized });
    // Підпис мусить належати цьому рахунку: інакше відхиляємо (захист від розсинхрону індексу)
    const signed = Transaction.from(r.signed);
    assertArgument(signed.from === this.address, 'signature does not match the account', 'tx', signed.from);
    return r.signed;
  }

  async signMessage(message) {
    const args = typeof message === 'string' ? { index: this.index, text: message } : { index: this.index, hex: '0x' + Buffer.from(message).toString('hex') };
    return (await this.call('evmSignMessage', args)).signature;
  }

  async signTypedData(domain, types, value) {
    const populated = await TypedDataEncoder.resolveNames(domain, types, value, async (name) => resolveAddress(name, this.provider));
    return (await this.call('evmSignTyped', { index: this.index, domain: populated.domain, types, value: populated.value })).signature;
  }
}

function install(Wallet, { unauthorized }) {
  Object.assign(Wallet.prototype, {
    signerEnabled() { return process.env.W3IR_SIGNER === '1'; },
    signerClient() { return this._signerClient || (this._signerClient = new SignerClient()); },
    // Розблоковує підписувач поточною фразою, якщо він ще не розблокований (після простою, збою чи блокування сховища)
    async signerCall(op, args) {
      const c = this.signerClient();
      if (!(await c.call('status')).unlocked) {
        const s = this.data();
        if (!s) throw unauthorized('Гаманець не створено');
        await c.call('unlock', { mnemonic: s.mnemonic, passphrase: s.passphrase || '', evmPath: s.evmPath || 'standard', solPath: s.solPath || 'phantom' });
      }
      return c.call(op, args);
    },
    // Блокування сховища, нова фраза чи видалення гаманця: підписувач обнуляє seed і завершується
    signerLock() { if (this._signerClient) this._signerClient.lock().catch(() => {}); },
    remoteEvmSigner(index, address) { return new RemoteEvmSigner((op, args) => this.signerCall(op, args), index, address); },
  });
}

module.exports = { RemoteEvmSigner, install };
