'use strict';
const { t: tr } = require('./i18n');
// Імпортовані рахунки (за приватним ключем) і QR-коди адрес.
// Імпортований ключ зберігається лише всередині зашифрованого сховища (розділ wallet), не відновлюється з фрази гаманця
// і не передається сайтам (dApp бачить основний рахунок): такі рахунки доступні для переказів зі сторінки гаманця.
// Показ ключа й видалення потребують майстер-пароля. Віртуальні індекси ≥ 1000 — імпортовані рахунки.
const { Wallet: EthWallet, getAddress, isAddress } = require('ethers');
const S = require('./solana');
const { injectionClean } = require('./token-text');
const qr = require('./qr');

const IMP_BASE = 1000;
const MAX_IMPORTED = 20;

function install(Wallet, { RpcError, unauthorized }) {
  const proto = Wallet.prototype;

  proto._imported = function () { const s = this.data(); if (!s) throw unauthorized('Гаманець не створено'); s.imported = s.imported || []; return s.imported; };

  proto.importedAccounts = function () { return this._imported().map((a, i) => ({ id: IMP_BASE + i, chain: a.chain, address: a.address, name: a.name || '' })); };

  // Адреса рахунку для EVM/Solana: індекс 0–9 — похідні від фрази, ≥ 1000 — імпортовані
  proto.evmAccount = function (index) {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    index = Number(index);
    if (Number.isInteger(index) && index >= IMP_BASE) {
      const a = this._imported()[index - IMP_BASE];
      if (a && a.chain === 'evm') return a.address;
      throw new RpcError(-32602, 'Невідомий рахунок');
    }
    if (!Number.isInteger(index) || index < 0 || index >= s.addresses.length) throw new RpcError(-32602, 'Невідомий рахунок');
    return s.addresses[index];
  };
  proto.solAccount = function (index) {
    index = Number(index);
    if (Number.isInteger(index) && index >= IMP_BASE) {
      const a = this._imported()[index - IMP_BASE];
      if (a && a.chain === 'sol') return a.address;
      throw new RpcError(-32602, 'Невідомий рахунок');
    }
    const list = this.solAddresses();
    if (!Number.isInteger(index) || index < 0 || index >= list.length) throw new RpcError(-32602, 'Невідомий рахунок');
    return list[index];
  };
  proto.ownEvm = function () { return [...this.data().addresses, ...this._imported().filter(a => a.chain === 'evm').map(a => a.address)]; };
  proto.ownSol = function () { return [...this.solAddresses(), ...this._imported().filter(a => a.chain === 'sol').map(a => a.address)]; };
  proto.isOwnEvm = function (address) { return this.ownEvm().includes(address); };
  proto.isOwnSol = function (address) { return this.ownSol().includes(address); };

  proto._importedSecret = function (address, chain) {
    const a = this._imported().find(x => x.chain === chain && x.address === address);
    return a ? a.secret : null;
  };

  // Розпізнає ключ: EVM — 64 hex (з 0x або без); Solana — base58 із 64 байтів (формат Phantom) або JSON-масив із 64 чисел (файл keypair)
  function parseKey(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t || t.length > 500) throw new RpcError(-32602, 'Вставте приватний ключ.');
    const hex = t.replace(/^0x/i, '');
    if (/^[0-9a-fA-F]{64}$/.test(hex)) {
      let w;
      try { w = new EthWallet('0x' + hex.toLowerCase()); } catch { throw new RpcError(-32602, 'Некоректний приватний ключ EVM.'); }
      return { chain: 'evm', address: getAddress(w.address), secret: '0x' + hex.toLowerCase() };
    }
    let bytes = null;
    if (t.startsWith('[')) {
      let arr;
      try { arr = JSON.parse(t); } catch { throw new RpcError(-32602, 'Некоректний JSON-масив ключа.'); }
      if (!Array.isArray(arr) || arr.length !== 64 || arr.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw new RpcError(-32602, 'Ключ Solana у JSON має містити рівно 64 числа 0–255.');
      bytes = Buffer.from(arr);
    } else {
      try { bytes = S.b58decode(t); } catch { throw new RpcError(-32602, 'Не вдалося розпізнати ключ. Приймаються: EVM — 64 шістнадцяткові символи; Solana — ключ у base58 (формат Phantom, 64 байти) або JSON-масив із файлу keypair.'); }
      if (bytes.length === 32) throw new RpcError(-32602, 'Це схоже на адресу (32 байти), а не на приватний ключ. Потрібен повний приватний ключ Solana (64 байти) із експорту гаманця.');
      if (bytes.length !== 64) throw new RpcError(-32602, 'Приватний ключ Solana має містити 64 байти.');
    }
    const kp = S.keypairFromSeed(bytes.subarray(0, 32));
    if (!kp.publicKey.equals(bytes.subarray(32))) throw new RpcError(-32602, 'Ключ пошкоджено: публічна частина не відповідає секретній.');
    return { chain: 'sol', address: kp.address, secret: Buffer.from(bytes.subarray(0, 32)).toString('base64') };
  }

  proto.importKey = function (text, name) {
    const list = this._imported();
    if (list.length >= MAX_IMPORTED) throw new RpcError(-32602, `Не більше ${MAX_IMPORTED} імпортованих рахунків.`);
    const k = parseKey(text);
    const dup = k.chain === 'evm' ? this.isOwnEvm(k.address) : this.isOwnSol(k.address);
    if (dup) throw new RpcError(-32602, 'Цей рахунок уже є в гаманці (похідний від фрази відновлення або вже імпортований).');
    const entry = { chain: k.chain, address: k.address, secret: k.secret, name: injectionClean(name, 32), added: Date.now() };
    list.push(entry);
    this.vault.persist();
    return { id: IMP_BASE + list.length - 1, chain: entry.chain, address: entry.address, name: entry.name };
  };

  // Ключ у форматі, який приймає імпорт (для резервної копії): потребує майстер-пароля на рівні IPC
  proto.revealKey = function (id) {
    const a = this._imported()[Number(id) - IMP_BASE];
    if (!a) throw new RpcError(-32602, 'Невідомий рахунок');
    if (a.chain === 'evm') return a.secret;
    const seed = Buffer.from(a.secret, 'base64');
    return S.b58encode(Buffer.concat([seed, S.keypairFromSeed(seed).publicKey]));
  };

  proto.removeImported = function (id) {
    const list = this._imported();
    const i = Number(id) - IMP_BASE;
    if (!Number.isInteger(i) || i < 0 || i >= list.length) throw new RpcError(-32602, 'Невідомий рахунок');
    const gone = list.splice(i, 1)[0];
    const s = this.data();
    // відстежувані транзакції й підключення цього рахунку більше не мають сенсу
    s.pending = (s.pending || []).filter(p => p.from !== gone.address);
    for (const [origin, c] of Object.entries(s.connections || {})) if ((c.accounts || []).includes(gone.address)) { delete s.connections[origin]; this.emit(origin, 'accountsChanged', []); }
    for (const [origin, c] of Object.entries(s.solConnections || {})) if (c.address === gone.address) { delete s.solConnections[origin]; this.emit(origin, 'sol:disconnect', null); }
    if (s.dapp) for (const k of ['evm', 'sol']) if (s.dapp[k] === Number(id)) delete s.dapp[k];
    // індекси імпортованих зсуваються: типові рахунки для сайтів, що вказують далі, зміщуємо разом із ними
    if (s.dapp) for (const k of ['evm', 'sol']) if (s.dapp[k] > Number(id)) s.dapp[k] -= 1;
    this.snapConns();
    this.vault.persist();
    return true;
  };

  // QR для власної чи збереженої в адресній книзі адреси (довільний текст кодувати не даємо)
  proto.qrFor = function (text) {
    const t = String(text == null ? '' : text);
    const known = new Set([...this.ownEvm(), ...this.ownSol(), ...(this.data().contacts || []).map(c => c.address)]);
    if (!known.has(t)) throw new RpcError(-32602, 'QR-код можна показати лише для адреси вашого рахунку або контакту.');
    return qr.encode(t);
  };

  proto.isEvmAddress = isAddress;

  // ---------- рахунок для сайтів (dApp) ----------
  // Типовий рахунок для нових підключень (окремо для EVM і Solana) і вибір рахунку для кожного підключеного сайту
  proto.dappIndex = function (chain) {
    const s = this.data();
    if (!s) return 0;
    const i = ((s.dapp || {})[chain]);
    if (i === undefined || i === 0) return 0;
    try { (chain === 'sol' ? this.solAccount : this.evmAccount).call(this, i); return i; } catch { return 0; }
  };
  // Рахунки, які можна запропонувати сайту під час підключення: [{ value: 'індекс', label }]
  proto.dappChoices = function (chain) {
    const s = this.data();
    if (!s) return [];
    const names = s.names || [];
    const sh = (a) => `${a.slice(0, 6)}\u2026${a.slice(-4)}`;
    const out = [];
    (chain === 'sol' ? this.solAddresses() : s.addresses).forEach((a, i) => out.push({ value: String(i), label: `${names[i] || tr('Рахунок {0}', i + 1)} \u00B7 ${sh(a)}` }));
    this._imported().forEach((a, i) => { if (a.chain === chain) out.push({ value: String(IMP_BASE + i), label: `${a.name || tr('Імпортований рахунок')} \u00B7 ${sh(a.address)}` }); });
    return out;
  };
  // Індекс рахунку з відповіді підтвердження: лише з тих, що були запропоновані, інакше — типовий
  proto.pickChoice = function (approval, options, fallback) {
    const v = approval && approval.choice;
    return typeof v === 'string' && options.some(o => o.value === v) ? Number(v) : fallback;
  };
  proto.setDappAccount = function (chain, index) {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    if (chain !== 'evm' && chain !== 'sol') throw new RpcError(-32602, 'Невідома мережа.');
    index = Number(index);
    (chain === 'sol' ? this.solAccount : this.evmAccount).call(this, index); // перевірка: рахунок існує й належить цій мережі
    s.dapp = { ...(s.dapp || {}), [chain]: index };
    this.vault.persist();
    return index;
  };
  proto.setSiteAccount = function (origin, chain, index) {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    origin = String(origin);
    index = Number(index);
    if (chain === 'evm') {
      const c = s.connections[origin];
      if (!c) throw new RpcError(-32602, 'Сайт не підключено.');
      const addr = this.evmAccount(index);
      c.accounts = [addr];
      this.vault.persist(); this.snapConns();
      this.emit(origin, 'accountsChanged', [addr]);
      return addr;
    }
    if (chain === 'sol') {
      const c = (s.solConnections || {})[origin];
      if (!c) throw new RpcError(-32602, 'Сайт не підключено.');
      const addr = this.solAccount(index);
      c.address = addr;
      this.vault.persist(); this.snapConns();
      this.emit(origin, 'sol:connect', { address: addr, publicKey: S.b58decode(addr).toString('base64') });
      return addr;
    }
    throw new RpcError(-32602, 'Невідома мережа.');
  };
}

module.exports = { install, IMP_BASE };
