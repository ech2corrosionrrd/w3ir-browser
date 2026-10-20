// @ts-check
'use strict';
// Менеджер паролів.
//  * Ключ = scrypt(майстер-пароль + «перець» DPAPI, сіль) — файл сховища марний без акаунта Windows і майстер-пароля.
//  * Дані шифруються AES-256-GCM; заголовок (параметри KDF) входить в AAD, тому підміна параметрів виявляється.
//  * Ключ та розшифровані дані живуть лише в пам'яті головного процесу й стираються при блокуванні.

/**
 * @typedef {Object} VaultEntry
 * @property {string} id
 * @property {string} origin
 * @property {string} username
 * @property {string} password
 * @property {string} [name]
 * @property {string} [note]
 * @property {number} [createdAt]
 * @property {number} [updatedAt]
 *
 * @typedef {Object} VaultHeader
 * @property {number} v
 * @property {Object} kdf
 * @property {boolean} pepper
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeStorage, clipboard } = require('electron');
const { KDF_DEFAULT, validKdf, deriveKey, encrypt, decrypt, b64, unb64, norm, writeAtomic } = require('./crypto-util');

const MAX = { field: 2048, password: 1024, note: 8192, entries: 5000 };
const REAUTH_MS = 2 * 60 * 1000;

function checkMaster(pw) {
  pw = String(pw || '');
  if (pw.length < 12) return 'Майстер-пароль має містити щонайменше 12 символів.';
  const classes = [/[a-zа-яіїєґ]/, /[A-ZА-ЯІЇЄҐ]/, /\d/, /[^\w\s]/].filter(r => r.test(pw)).length;
  if (pw.length < 20 && classes < 3) return 'Додайте великі й малі літери, цифри або символи (або зробіть пароль довшим за 20 символів).';
  if (/^(.)\1+$/.test(pw)) return 'Пароль надто простий.';
  return null;
}

function normOrigin(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))) return u.origin;
  } catch { /* ignore */ }
  return null;
}

function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some(x => x !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some(x => x !== '')) rows.push(row);
  return rows;
}

class Vault {
  constructor({ dir, usePepper = true, onChange = () => {}, autolockMinutes = 15 }) {
    this.dir = dir;
    this.file = path.join(dir, 'vault.bin');
    this.pepperFile = path.join(dir, 'vault.pepper');
    this.usePepper = usePepper;
    this.onChange = onChange;
    this.autolockMs = autolockMinutes * 60000;
    this.key = null;
    this.data = null;
    this.header = null;
    this.fails = 0;
    this.nextAllowed = 0;
    this.lastAuth = 0;
    this.timer = null;
    this.clipTimer = null;
  }

  exists() { return fs.existsSync(this.file); }
  status() { return this.key ? 'unlocked' : this.exists() ? 'locked' : 'none'; }
  setAutolock(min) { this.autolockMs = Math.max(1, Number(min) || 15) * 60000; this.touch(); }

  touch() {
    clearTimeout(this.timer);
    if (this.key) {
      this.timer = setTimeout(() => this.lock(), this.autolockMs);
      if (this.timer.unref) this.timer.unref();
    }
  }

  _pepper(create) {
    if (!this.usePepper || !safeStorage.isEncryptionAvailable()) {
      if (!create && this.header && this.header.pepper) throw new Error('pepper-unavailable');
      return { buf: Buffer.alloc(0), used: false };
    }
    if (create) {
      const raw = crypto.randomBytes(32);
      writeAtomic(fs, this.pepperFile, safeStorage.encryptString(b64(raw)), { backup: true });
      return { buf: raw, used: true };
    }
    if (!this.header.pepper) return { buf: Buffer.alloc(0), used: false };
    try { return { buf: unb64(safeStorage.decryptString(fs.readFileSync(this.pepperFile))), used: true }; }
    catch { throw new Error('pepper-unavailable'); }
  }

  _secret(master, pepper) { return Buffer.concat([norm(master), Buffer.from([0]), pepper]); }

  _aad(h) { return Buffer.from(JSON.stringify({ v: h.v, kdf: h.kdf, pepper: h.pepper })); }

  _persist() {
    const h = this.header;
    const env = encrypt(this.key, Buffer.from(JSON.stringify(this.data), 'utf8'), this._aad(h));
    writeAtomic(fs, this.file, JSON.stringify({ ...h, iv: b64(env.iv), tag: b64(env.tag), ct: b64(env.ct) }), { backup: true });
  }

  async create(master) {
    if (this.exists()) return { ok: false, error: 'Сховище вже існує.' };
    const weak = checkMaster(master);
    if (weak) return { ok: false, error: weak };
    const pepper = this._pepper(true);
    const salt = crypto.randomBytes(16);
    this.header = { v: 1, kdf: { ...KDF_DEFAULT, salt: b64(salt) }, pepper: pepper.used };
    this.key = await deriveKey(this._secret(master, pepper.buf), salt, this.header.kdf);
    this.data = { entries: [], never: [] };
    this._persist();
    this.lastAuth = Date.now();
    this.touch();
    this.onChange();
    return { ok: true };
  }

  async unlock(master) {
    if (this.key) return { ok: true };
    if (!this.exists()) return { ok: false, error: 'Сховище ще не створено.' };
    const now = Date.now();
    if (now < this.nextAllowed) return { ok: false, error: `Забагато спроб. Зачекайте ${Math.ceil((this.nextAllowed - now) / 1000)} с.` };
    let raw;
    const readHeader = (f) => {
      const r = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (r.v !== 1 || !validKdf(r.kdf)) throw new Error('format');
      return r;
    };
    try {
      raw = readHeader(this.file);
    } catch (e) {
      // Лише файл, що не розбирається як JSON (обрізаний запис, збій диска), відновлюється з резервної копії; пошкоджений
      // файл зберігаємо окремо. Файл із хибною структурою чи небезпечними параметрами KDF (підміна) відхиляється, а не «лікується».
      if (!(e instanceof SyntaxError)) return { ok: false, error: 'Файл сховища пошкоджено.' };
      try {
        raw = readHeader(this.file + '.bak');
        try { fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
        fs.copyFileSync(this.file + '.bak', this.file);
        this.recoveredFromBackup = true;
      } catch { return { ok: false, error: 'Файл сховища пошкоджено.' }; }
    }
    this.header = { v: raw.v, kdf: raw.kdf, pepper: !!raw.pepper };
    let key, plain;
    try {
      const pepper = this._pepper(false);
      key = await deriveKey(this._secret(master, pepper.buf), unb64(raw.kdf.salt), raw.kdf);
      plain = decrypt(key, { iv: unb64(raw.iv), tag: unb64(raw.tag), ct: unb64(raw.ct) }, this._aad(this.header));
    } catch (e) {
      if (e.message === 'pepper-unavailable') return { ok: false, error: 'Сховище прив’язане до іншого облікового запису Windows. Відновіть його з резервної копії.' };
      this.fails++;
      this.nextAllowed = Date.now() + Math.min(60000, 1000 * 2 ** (this.fails - 1));
      return { ok: false, error: 'Хибний майстер-пароль (або файл змінено).' };
    }
    try { this.data = JSON.parse(plain.toString('utf8')); } catch { return { ok: false, error: 'Дані сховища пошкоджено.' }; }
    if (!Array.isArray(this.data.entries)) this.data.entries = [];
    if (!Array.isArray(this.data.never)) this.data.never = [];
    plain.fill(0);
    this.key = key;
    this.fails = 0;
    this.lastAuth = Date.now();
    this.touch();
    this.onChange();
    return { ok: true };
  }

  lock() {
    clearTimeout(this.timer);
    clearTimeout(this.clipTimer);
    if (this.key) this.key.fill(0);
    this.key = null;
    this.data = null;
    this.onChange();
  }

  _need() { if (!this.key) throw new Error('locked'); this.touch(); }

  // Додаткові розділи зашифрованих даних (наприклад, гаманець)
  section(name, init) {
    this._need();
    if (!this.data[name] || typeof this.data[name] !== 'object') this.data[name] = init;
    return this.data[name];
  }
  persist() { this._need(); this._persist(); }

  async reauth(master) {
    this._need();
    const salt = unb64(this.header.kdf.salt);
    const pepper = this._pepper(false);
    const k = await deriveKey(this._secret(master, pepper.buf), salt, this.header.kdf);
    const ok = k.length === this.key.length && crypto.timingSafeEqual(k, this.key);
    k.fill(0);
    if (ok) this.lastAuth = Date.now();
    return ok;
  }
  recentlyAuthed(ms = REAUTH_MS) { return Date.now() - this.lastAuth < ms; }

  _pub(e) {
    let host = e.origin;
    try { host = new URL(e.origin).host; } catch { /* ignore */ }
    return { id: e.id, origin: e.origin, host, username: e.username, modified: e.modified, hasNote: !!e.note };
  }

  list(origin) {
    this._need();
    return this.data.entries.filter(e => !origin || e.origin === origin).map(e => this._pub(e))
      .sort((a, b) => a.host.localeCompare(b.host) || a.username.localeCompare(b.username));
  }

  count(origin) {
    return this.data ? this.data.entries.filter(e => e.origin === origin).length : 0;
  }

  get(id) { this._need(); return this.data.entries.find(e => e.id === id) || null; }

  find(origin, username) {
    this._need();
    return this.data.entries.find(e => e.origin === origin && e.username === username) || null;
  }

  add({ url, username = '', password, note = '' }) {
    this._need();
    const origin = normOrigin(url);
    if (!origin) throw new Error('Підтримуються лише https-адреси (та localhost).');
    username = String(username).slice(0, MAX.field);
    password = String(password || '');
    if (!password || password.length > MAX.password) throw new Error('Некоректний пароль.');
    note = String(note).slice(0, MAX.note);
    const now = Date.now();
    const ex = this.data.entries.find(e => e.origin === origin && e.username === username);
    if (ex) { ex.password = password; ex.note = note || ex.note; ex.modified = now; }
    else {
      if (this.data.entries.length >= MAX.entries) throw new Error('Досягнуто ліміт записів.');
      this.data.entries.push({ id: crypto.randomUUID(), origin, username, password, note, created: now, modified: now });
    }
    this._persist();
    return (ex || this.data.entries[this.data.entries.length - 1]).id;
  }

  update(id, fields) {
    this._need();
    const e = this.data.entries.find(x => x.id === id);
    if (!e) throw new Error('Запис не знайдено.');
    if (fields.url) { const o = normOrigin(fields.url); if (!o) throw new Error('Некоректна адреса.'); e.origin = o; }
    if (typeof fields.username === 'string') e.username = fields.username.slice(0, MAX.field);
    if (typeof fields.password === 'string' && fields.password) {
      if (fields.password.length > MAX.password) throw new Error('Пароль надто довгий.');
      e.password = fields.password;
    }
    if (typeof fields.note === 'string') e.note = fields.note.slice(0, MAX.note);
    e.modified = Date.now();
    this._persist();
  }

  remove(id) {
    this._need();
    this.data.entries = this.data.entries.filter(e => e.id !== id);
    this._persist();
  }

  isNever(origin) { return !!this.data && this.data.never.includes(origin); }
  addNever(origin) { this._need(); if (!this.data.never.includes(origin)) { this.data.never.push(origin); this._persist(); } }

  async changeMaster(oldPw, newPw) {
    this._need();
    if (!(await this.reauth(oldPw))) return { ok: false, error: 'Поточний майстер-пароль хибний.' };
    const weak = checkMaster(newPw);
    if (weak) return { ok: false, error: weak };
    const pepper = this._pepper(false);
    const salt = crypto.randomBytes(16);
    const header = { v: 1, kdf: { ...KDF_DEFAULT, salt: b64(salt) }, pepper: this.header.pepper };
    const key = await deriveKey(this._secret(newPw, pepper.buf), salt, header.kdf);
    this.key.fill(0);
    this.key = key;
    this.header = header;
    this._persist();
    return { ok: true };
  }

  // ---------- резервні копії (без «перцю», тільки пароль резервної копії) ----------
  async exportBackup(filePath, backupPassword) {
    this._need();
    const weak = checkMaster(backupPassword);
    if (weak) return { ok: false, error: weak };
    const salt = crypto.randomBytes(16);
    const header = { v: 1, kdf: { ...KDF_DEFAULT, salt: b64(salt) }, pepper: false, backup: true };
    const key = await deriveKey(norm(backupPassword), salt, header.kdf);
    const env = encrypt(key, Buffer.from(JSON.stringify(this.data), 'utf8'), this._aad(header));
    key.fill(0);
    writeAtomic(fs, filePath, JSON.stringify({ ...header, iv: b64(env.iv), tag: b64(env.tag), ct: b64(env.ct) }));
    return { ok: true };
  }

  async importBackup(filePath, backupPassword) {
    this._need();
    let raw;
    try {
      if (fs.statSync(filePath).size > 50 * 1024 * 1024) throw new Error('big');
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (raw.v !== 1 || !validKdf(raw.kdf) || !raw.backup) throw new Error('format');
    } catch { return { ok: false, error: 'Це не файл резервної копії W3IR.' }; }
    let data;
    try {
      const key = await deriveKey(norm(backupPassword), unb64(raw.kdf.salt), raw.kdf);
      const plain = decrypt(key, { iv: unb64(raw.iv), tag: unb64(raw.tag), ct: unb64(raw.ct) }, this._aad({ v: raw.v, kdf: raw.kdf, pepper: false }));
      key.fill(0);
      data = JSON.parse(plain.toString('utf8'));
    } catch { return { ok: false, error: 'Хибний пароль резервної копії або файл пошкоджено.' }; }
    let added = 0;
    for (const e of Array.isArray(data.entries) ? data.entries : []) {
      if (!e || typeof e.password !== 'string' || !normOrigin(e.origin)) continue;
      const ex = this.data.entries.find(x => x.origin === e.origin && x.username === String(e.username || ''));
      if (ex) { if ((e.modified || 0) > ex.modified) { ex.password = e.password; ex.note = String(e.note || ''); ex.modified = e.modified; added++; } }
      else if (this.data.entries.length < MAX.entries) {
        this.data.entries.push({ id: crypto.randomUUID(), origin: e.origin, username: String(e.username || '').slice(0, MAX.field), password: e.password.slice(0, MAX.password), note: String(e.note || '').slice(0, MAX.note), created: e.created || Date.now(), modified: e.modified || Date.now() });
        added++;
      }
    }
    for (const n of Array.isArray(data.never) ? data.never : []) if (normOrigin(n) && !this.data.never.includes(n)) this.data.never.push(n);
    this._persist();
    return { ok: true, added };
  }

  importCsv(text) {
    this._need();
    const rows = parseCsv(String(text).replace(/^﻿/, ''));
    if (rows.length < 2) return { ok: false, error: 'Порожній або некоректний CSV.' };
    const head = rows[0].map(x => x.trim().toLowerCase());
    const col = (...names) => head.findIndex(h => names.includes(h));
    const iUrl = col('url', 'login_uri', 'origin', 'website'), iUser = col('username', 'login_username', 'user', 'login');
    const iPass = col('password', 'login_password'), iNote = col('note', 'notes');
    if (iUrl < 0 || iPass < 0) return { ok: false, error: 'У CSV немає стовпців url та password.' };
    let added = 0, skipped = 0;
    for (const r of rows.slice(1)) {
      try {
        this.add({ url: r[iUrl], username: iUser >= 0 ? r[iUser] : '', password: r[iPass], note: iNote >= 0 ? r[iNote] : '' });
        added++;
      } catch { skipped++; }
    }
    return { ok: true, added, skipped };
  }

  copyPassword(id) {
    const e = this.get(id);
    if (!e) return false;
    clipboard.writeText(e.password);
    const pw = e.password;
    clearTimeout(this.clipTimer);
    this.clipTimer = setTimeout(() => { if (clipboard.readText() === pw) clipboard.clear(); }, 20000);
    return true;
  }

  generate({ length = 20, symbols = true } = {}) {
    length = Math.max(8, Math.min(64, Number(length) || 20));
    const sets = ['abcdefghijkmnopqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789'];
    if (symbols) sets.push('!@#$%^&*-_=+?');
    const all = sets.join('');
    const out = sets.map(s => s[crypto.randomInt(s.length)]);
    while (out.length < length) out.push(all[crypto.randomInt(all.length)]);
    for (let i = out.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
    return out.join('');
  }
}

module.exports = { Vault, normOrigin, checkMaster, parseCsv };
