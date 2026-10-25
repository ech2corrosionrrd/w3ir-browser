'use strict';
const { t: tr } = require('./i18n');
// Імпортовані рахунки (за приватним ключем) і QR-коди адрес.
// Імпортований ключ зберігається лише всередині зашифрованого сховища (розділ wallet), не відновлюється з фрази гаманця
// і не передається сайтам (dApp бачить основний рахунок): такі рахунки доступні для переказів зі сторінки гаманця.
// Показ ключа й видалення потребують майстер-пароля. Віртуальні індекси ≥ 1000 — імпортовані рахунки.
const { Wallet: EthWallet, getAddress, isAddress, ZeroAddress } = require('ethers');
const S = require('./solana');
const { injectionClean } = require('./token-text');
const qr = require('./qr');
const { LedgerSigner, PATHS } = require('./ledger');

const IMP_BASE = 1000;
const MAX_IMPORTED = 20;

// Рахунки лише для перегляду (адреса без ключа): ідентифікатори з WATCH_BASE; підписувати чи надсилати з них неможливо —
// їх немає в ownEvm()/ownSol() та в evmAccount()/solAccount(), а читання (баланси, токени, NFT, історія) йде окремими шляхами.
const WATCH_BASE = 5000;
const MAX_WATCH = 20;

function install(Wallet, { RpcError, unauthorized }) {
  const proto = Wallet.prototype;

  proto._imported = function () { const s = this.data(); if (!s) throw unauthorized('Гаманець не створено'); s.imported = s.imported || []; return s.imported; };

  proto.importedAccounts = function () { return this._imported().map((a, i) => ({ id: IMP_BASE + i, chain: a.chain, address: a.address, name: a.name || '', ...(a.hw ? { hw: a.hw.type, path: a.hw.path } : {}) })); };

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
    const a = this._imported().find(x => x.chain === chain && x.address === address && !x.hw);
    return a ? a.secret : null;
  };

  // ---------- Ledger (ЕКСПЕРИМЕНТАЛЬНО): рахунок без ключа, підпис — на пристрої ----------
  // Запис зберігає лише адресу й шлях деривації; приватний ключ ніколи не залишає пристрій.
  proto.ledgerApp = function () { return this.ctx.ledger().app(); };
  proto._ledgerEntry = function (address) { return this._imported().find(x => x.chain === 'evm' && x.address === address && x.hw && x.hw.type === 'ledger') || null; };
  proto.ledgerSigner = function (address) {
    const e = this._ledgerEntry(address);
    return e ? new LedgerSigner(this.ledgerApp(), e.hw.path, e.address) : null;
  };
  proto.addLedger = async function (kind, index, name) {
    const make = PATHS[kind];
    const i = Number(index);
    if (!make || !Number.isInteger(i) || i < 0 || i > 19) throw new RpcError(-32602, 'Некоректний шлях Ledger.');
    const list = this._imported();
    if (list.length >= MAX_IMPORTED) throw new RpcError(-32602, `Не більше ${MAX_IMPORTED} імпортованих рахунків.`);
    const path = make(i);
    let got;
    try { got = await this.ledgerApp().getAddress(path, true); } // адреса показується на екрані пристрою для звірки
    catch (e) { throw new RpcError(e.code === 4001 ? 4001 : -32000, e.message); }
    if (this.isOwnEvm(got.address)) throw new RpcError(-32602, 'Цей рахунок уже є в гаманці.');
    list.push({ chain: 'evm', address: got.address, name: injectionClean(name, 32), added: Date.now(), hw: { type: 'ledger', path } });
    this.vault.persist();
    return { id: IMP_BASE + list.length - 1, chain: 'evm', address: got.address, name: list[list.length - 1].name, hw: 'ledger', path };
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
    if (a.hw) throw new RpcError(-32602, 'Ключ рахунку Ledger зберігається лише на пристрої.');
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
    const known = new Set([...this.ownEvm(), ...this.ownSol(), ...this._watch().map(a => a.address), ...(this.data().contacts || []).map(c => c.address)]);
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
  // ---------- рахунки лише для перегляду ----------
  proto._watch = function () { const s = this.data(); if (!s) throw unauthorized('Гаманець не створено'); s.watch = s.watch || []; return s.watch; };
  proto.watchAccounts = function () { return this._watch().map((a, i) => ({ id: WATCH_BASE + i, chain: a.chain, address: a.address, name: a.name || '' })); };
  proto.watchAddrs = function (chain) { return this._watch().filter(a => a.chain === chain).map(a => a.address); };
  proto.addWatch = function (address, name) {
    const raw = String(address == null ? '' : address).trim();
    let chain, addr;
    if (isAddress(raw)) { chain = 'evm'; addr = getAddress(raw); if (addr === ZeroAddress) throw new RpcError(-32602, 'Нульова адреса не може бути рахунком для перегляду.'); }
    else if (S.isAddress(raw)) { chain = 'sol'; addr = raw; }
    else throw new RpcError(-32602, 'Некоректна адреса (потрібна адреса EVM або Solana).');
    const own = chain === 'evm' ? this.ownEvm() : this.ownSol();
    if (own.includes(addr)) throw new RpcError(-32602, 'Це адреса вашого власного рахунку.');
    const list = this._watch();
    if (list.some(a => a.address === addr)) throw new RpcError(-32602, 'Цю адресу вже додано.');
    if (list.length >= MAX_WATCH) throw new RpcError(-32602, `Не більше ${MAX_WATCH} рахунків для перегляду.`);
    const clean = String(name == null ? '' : name).replace(/[\u0000-\u001f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '').trim().slice(0, 32);
    list.push({ chain, address: addr, name: clean });
    this.vault.persist();
    return { id: WATCH_BASE + list.length - 1, chain, address: addr, name: clean };
  };
  proto.removeWatch = function (id) {
    const list = this._watch();
    const i = Number(id) - WATCH_BASE;
    if (!Number.isInteger(i) || i < 0 || i >= list.length) throw new RpcError(-32602, 'Невідомий рахунок.');
    list.splice(i, 1);
    this.vault.persist();
    return true;
  };
  // Адреса для ЧИТАННЯ (баланси, токени, NFT): власні рахунки й рахунки лише для перегляду. Для підпису не використовується.
  proto.evmView = function (index) {
    index = Number(index);
    if (Number.isInteger(index) && index >= WATCH_BASE) {
      const a = this._watch()[index - WATCH_BASE];
      if (a && a.chain === 'evm') return a.address;
      throw new RpcError(-32602, 'Невідомий рахунок');
    }
    return this.evmAccount(index);
  };
  proto.isViewSol = function (address) { return this.ownSol().includes(address) || this.watchAddrs('sol').includes(address); };

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
  // Авторизація сайту: показує вікно з вибором серед УСІХ доступних рахунків цієї мережі (власні, похідні від фрази й імпортовані; рахунки лише для
  // перегляду не пропонуються, бо підписати ними неможливо). Якщо сховище заблоковано, список рахунків ще недоступний: спершу окреме вікно з
  // розблокуванням, потім, коли рахунків кілька, вікно з вибором. Повертає адресу вибраного рахунку; користувач може відхилити (4001).
  // opts: { chain: 'evm'|'sol', have: [адреса поточного підключення], intro, network, accountLabel, chains?: { options, value } }
  // Якщо передано opts.chains (EVM), у вікні є другий вибір — мережа (валюта); вибір повертається в opts.pickedChain.
  proto.pickDappAccount = async function (win, origin, sameTab, opts) {
    const { chain, have } = opts;
    const accountOf = (i) => (chain === 'sol' ? this.solAccount(i) : this.evmAccount(i));
    const plan = () => {
      let def = this.dappIndex(chain);
      const options = this.dappChoices(chain);
      if (have.length) { // повторна авторизація: за замовчуванням — рахунок, яким сайт підключено зараз
        const cur = options.find(o => { try { return accountOf(Number(o.value)) === have[0]; } catch { return false; } });
        if (cur) def = Number(cur.value);
      }
      return { def, options };
    };
    const title = have.length ? tr('Авторизація на сайті') : tr('Підключення до сайту');
    const warnings = ['Сайт не зможе нічого підписати без вашого окремого підтвердження.'];
    const ask = (def, options) => {
      const choose = options.length > 1;
      const cc = opts.chains && opts.chains.options.length > 1 ? opts.chains : null;
      return this.approve(win, origin, sameTab, {
        kind: 'connect', title,
        lines: [['Сайт отримає', opts.intro], ...(choose ? [] : [[opts.accountLabel, accountOf(def)]]), ...(cc ? [] : [['Мережа', opts.network()]])],
        ...(choose ? { choice: { label: 'Рахунок для сайту', options, value: String(def) } } : {}),
        ...(cc ? { choice2: { label: 'Мережа і валюта', options: cc.options, value: cc.value } } : {}),
        warnings,
      });
    };
    let def, options, ap = null, ap0 = null;
    if (this.unlocked()) {
      ({ def, options } = plan());
      ap = await ask(def, options);
    } else {
      const cc0 = opts.chains && opts.chains.options.length > 1 ? opts.chains : null; // вибір мережі доступний і до розблокування
      ap0 = await this.approve(win, origin, sameTab, {
        kind: 'connect', title,
        lines: [['Сайт отримає', opts.intro], [opts.accountLabel, 'буде показано після розблокування'], ...(cc0 ? [] : [['Мережа', opts.network()]])],
        ...(cc0 ? { choice2: { label: 'Мережа і валюта', options: cc0.options, value: cc0.value } } : {}),
        warnings,
      });
      if (!this.unlocked()) throw unauthorized('Гаманець заблоковано — розблокуйте сховище паролів');
      ({ def, options } = plan());
      if (options.length > 1) ap = await ask(def, options); // сховище розблоковано: тепер видно рахунки, питаємо, яким увійти
    }
    if (opts.chains) opts.pickedChain = ap && opts.chains.options.length > 1 && typeof ap.choice2 === 'string' && opts.chains.options.some(o => o.value === ap.choice2) ? Number(ap.choice2) : ap0 && typeof ap0.choice2 === 'string' && opts.chains.options.some(o => o.value === ap0.choice2) ? Number(ap0.choice2) : Number(opts.chains.value);
    return accountOf(options.length > 1 && ap ? this.pickChoice(ap, options, def) : def);
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

module.exports = { install, IMP_BASE, WATCH_BASE };
