'use strict';
// Режими обережності (ліміти переказів, «лише адресна книга», автовідключення сайтів) і резервна копія гаманця
// (перевірка, що фраза записана; шифрований файл і відновлення з нього).
const crypto = require('crypto');
const { Mnemonic } = require('ethers');
const backup = require('./wallet-backup');
const { injectionClean } = require('./token-text');

const DEFAULT_POLICY = { contactsOnly: false, confirmUsd: 0, maxUsd: 0, siteDays: 0 };
const DELAY_SEC = 5;
const QUIZ_TTL = 5 * 60 * 1000;
const IMP_BASE = 1000;

function install(Wallet, { RpcError, unauthorized }) {
  const proto = Wallet.prototype;

  // ---------- режими обережності ----------
  proto.getPolicy = function () {
    const s = this.data();
    return { ...DEFAULT_POLICY, ...((s && s.policy) || {}) };
  };

  proto.setPolicy = function (patch) {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    patch = patch && typeof patch === 'object' ? patch : {};
    const next = { ...this.getPolicy() };
    const num = (v, max, name, int) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > max || (int && !Number.isInteger(n))) throw new RpcError(-32602, `Некоректне значення: ${name}.`);
      return n;
    };
    if (patch.contactsOnly !== undefined) next.contactsOnly = !!patch.contactsOnly;
    if (patch.confirmUsd !== undefined) next.confirmUsd = num(patch.confirmUsd, 1e9, 'поріг підтвердження');
    if (patch.maxUsd !== undefined) next.maxUsd = num(patch.maxUsd, 1e9, 'ліміт переказу');
    if (patch.siteDays !== undefined) next.siteDays = num(patch.siteDays, 365, 'дні до відключення сайтів', true);
    if (next.maxUsd && next.confirmUsd && next.confirmUsd > next.maxUsd) throw new RpcError(-32602, 'Поріг підтвердження не може перевищувати ліміт переказу.');
    s.policy = next;
    this.vault.persist();
    return next;
  };

  // Вартість переказу в USD за орієнтовними цінами (null, якщо ціни немає)
  proto.usdValue = async function (chain, token, amount) {
    try {
      const pr = await this.priceInfo({ chain, tokens: token ? [token] : [] });
      if (!pr.enabled) return null;
      const price = token ? pr.tokens[token] : pr.native;
      const n = Number(amount);
      return price && Number.isFinite(n) ? n * price : null;
    } catch { return null; }
  };

  // Перевірка переказу зі сторінки гаманця за режимами обережності: кидає помилку, якщо переказ заборонено;
  // повертає { warnings, delay, danger } для вікна підтвердження. Переказ NFT (nft: true) оцінюється лише за адресою отримувача.
  proto.policyGate = async function ({ to, chain, token, amount, nft }) {
    const p = this.getPolicy();
    const out = { warnings: [], delay: 0, danger: false };
    if (p.contactsOnly) {
      const norm = (a) => (String(a).startsWith('0x') ? String(a).toLowerCase() : String(a));
      const known = new Set([...this.ownEvm(), ...this.ownSol(), ...(this.data().contacts || []).map(c => c.address)].map(norm));
      if (!known.has(norm(to))) throw new RpcError(-32602, 'Увімкнено режим «лише адресна книга»: отримувача немає серед ваших рахунків і контактів. Додайте його в адресну книгу або вимкніть режим у налаштуваннях безпеки.');
    }
    if (!nft && (p.confirmUsd || p.maxUsd)) {
      const usd = await this.usdValue(chain, token, amount);
      if (usd === null) out.warnings.push('Вартість переказу в USD не визначено: ліміти за сумою не перевірено.');
      else {
        if (p.maxUsd && usd > p.maxUsd) throw new RpcError(-32602, `Перевищено ліміт ${p.maxUsd} USD на один переказ (сума ≈ ${usd.toFixed(2)} USD). Змініть ліміт у налаштуваннях безпеки гаманця.`);
        if (p.confirmUsd && usd >= p.confirmUsd) {
          out.warnings.push(`Велика сума (≈ ${usd.toFixed(2)} USD): підтвердити можна буде через ${DELAY_SEC} с. Ще раз перевірте отримувача й суму.`);
          out.delay = DELAY_SEC;
          out.danger = true;
        }
      }
    }
    return out;
  };

  // Автовідключення сайтів, якими давно не користувались
  proto.touchSite = function (origin) {
    if (!this.unlocked()) return; // сховище заблоковане: даних гаманця немає
    const s = this.data();
    if (!s) return;
    const now = Date.now();
    if (s.connections[origin]) s.connections[origin].last = now;
    if ((s.solConnections || {})[origin]) s.solConnections[origin].last = now;
  };
  proto.expireSites = function () {
    if (!this.unlocked()) return 0;
    const s = this.data();
    if (!s) return 0;
    const days = this.getPolicy().siteDays;
    const now = Date.now();
    if (!days || now - (this._lastExpire || 0) < 60000) return 0;
    this._lastExpire = now;
    const lim = days * 86400000;
    const stale = (c) => now - (c.last || c.since || now) > lim;
    const origins = new Set();
    for (const [o, c] of Object.entries(s.connections)) if (stale(c)) origins.add(o);
    for (const [o, c] of Object.entries(s.solConnections || {})) if (stale(c)) origins.add(o);
    for (const o of origins) this.disconnectSite(o);
    return origins.size;
  };

  // ---------- перевірка збереження фрази ----------
  proto.backupInfo = function () {
    const s = this.data();
    return { confirmed: !!(s && s.backupConfirmedAt), at: (s && s.backupConfirmedAt) || 0 };
  };
  // Три випадкові позиції слів, які користувач має ввести з аркуша (відповіді перевіряються тут, фраза зі сховища не виходить)
  proto.backupQuiz = function () {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    const n = s.mnemonic.split(' ').length;
    const pos = new Set();
    while (pos.size < 3) pos.add(crypto.randomInt(n));
    const list = [...pos].sort((a, b) => a - b);
    this._quiz = { pos: list, exp: Date.now() + QUIZ_TTL, tries: 0 };
    return { positions: list.map(p => p + 1) };
  };
  proto.backupCheck = function (answers) {
    const q = this._quiz;
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    if (!q || q.exp < Date.now()) throw new RpcError(-32602, 'Перевірка застаріла: почніть заново.');
    if (!Array.isArray(answers) || answers.length !== 3) throw new RpcError(-32602, 'Потрібно ввести три слова.');
    if (++q.tries > 5) { this._quiz = null; throw new RpcError(-32602, 'Забагато спроб: почніть перевірку заново.'); }
    const words = s.mnemonic.split(' ');
    const ok = q.pos.every((p, i) => String(answers[i] == null ? '' : answers[i]).trim().toLowerCase() === words[p]);
    if (!ok) return false;
    this._quiz = null;
    s.backupConfirmedAt = Date.now();
    this.vault.persist();
    return true;
  };

  // ---------- шифрована резервна копія ----------
  proto.backupExport = function (password) {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    const payload = {
      v: 1, createdAt: Date.now(), mnemonic: s.mnemonic, passphrase: s.passphrase || '', evmPath: s.evmPath || 'standard', solPath: s.solPath || 'phantom', accounts: s.addresses.length, names: s.names || [], contacts: s.contacts || [],
      imported: this._imported().map((a, i) => ({ chain: a.chain, name: a.name || '', key: this.revealKey(IMP_BASE + i) })),
    };
    return backup.encryptBackup(payload, password);
  };

  // Відновлення з файлу: лише коли гаманця ще немає. Усе з файлу перевіряється, пошкоджені записи пропускаються.
  proto.backupImport = function (buf, password) {
    if (this.exists() && this.data()) throw new RpcError(-32602, 'Гаманець уже існує. Спершу видаліть його, щоб відновити з копії.');
    const p = backup.decryptBackup(buf, password);
    if (!p || p.v !== 1 || typeof p.mnemonic !== 'string' || !Mnemonic.isValidMnemonic(p.mnemonic)) throw new RpcError(-32602, 'Файл резервної копії пошкоджено або має невідомий формат.');
    const accounts = Number.isInteger(p.accounts) && p.accounts >= 1 && p.accounts <= 10 ? p.accounts : 1;
    this.importPhrase(p.mnemonic, { passphrase: typeof p.passphrase === 'string' ? p.passphrase : '', evmPath: p.evmPath, solPath: p.solPath });
    for (let i = 1; i < accounts; i++) this.addAccount();
    const s = this.data();
    const names = Array.isArray(p.names) ? p.names : [];
    s.names = s.addresses.map((_, i) => injectionClean(typeof names[i] === 'string' ? names[i] : '', 32));
    const done = { accounts, contacts: 0, imported: 0 };
    for (const c of (Array.isArray(p.contacts) ? p.contacts : []).slice(0, 100)) {
      try { if (c && typeof c.name === 'string' && typeof c.address === 'string') { this.addContact(c.name, c.address); done.contacts++; } } catch { /* пропускаємо пошкоджений запис */ }
    }
    for (const k of (Array.isArray(p.imported) ? p.imported : []).slice(0, 20)) {
      try { if (k && typeof k.key === 'string') { this.importKey(k.key, typeof k.name === 'string' ? k.name : ''); done.imported++; } } catch { /* пропускаємо */ }
    }
    s.backupConfirmedAt = Date.now(); // файл із фразою — це і є резервна копія
    this.vault.persist();
    return done;
  };
}

module.exports = { install, DEFAULT_POLICY, DELAY_SEC };
