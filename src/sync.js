'use strict';
// Наскрізно зашифрована синхронізація закладок через спільну папку (OneDrive, Dropbox, Syncthing тощо).
// Хмара бачить лише шифротекст AES-256-GCM; ключ виводиться з парольної фрази (scrypt) і зберігається
// на пристрої під захистом DPAPI. Жодних серверів і чужих облікових даних.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeStorage } = require('electron');
const { Store } = require('./store');
const { KDF_DEFAULT, deriveKey, encrypt, decrypt, b64, unb64, norm, writeAtomic } = require('./crypto-util');

const FILE_NAME = 'w3ir-bookmarks.sync';
const MAGIC = 'W3IRSYNC1';
const MAX_ITEMS = 20000;
const MAX_FILE = 8 * 1024 * 1024;
const TOMB_TTL = 90 * 864e5;

const cleanItem = (x) => {
  if (!x || typeof x.url !== 'string' || !/^(https?|file):/i.test(x.url) || x.url.length > 4096) return null;
  return {
    url: x.url,
    title: String(x.title || '').slice(0, 500),
    added: Number(x.added) || 0,
    mod: Number(x.mod) || Number(x.added) || 0,
  };
};

// Злиття: для кожної адреси перемагає найновіша зміна; надгробок (видалення) перемагає, якщо новіший за зміну.
function merge(local, localTomb, remote, remoteTomb, now = Date.now()) {
  const tomb = {};
  for (const src of [localTomb, remoteTomb]) {
    for (const [u, ts] of Object.entries(src || {})) {
      if (typeof ts === 'number' && ts > (tomb[u] || 0) && now - ts < TOMB_TTL) tomb[u] = ts;
    }
  }
  const best = new Map();
  for (const it of [...local, ...remote]) {
    const c = cleanItem(it);
    if (!c) continue;
    const cur = best.get(c.url);
    if (!cur || c.mod > cur.mod) best.set(c.url, c);
  }
  const items = [];
  for (const it of best.values()) {
    if ((tomb[it.url] || 0) >= it.mod && tomb[it.url]) continue;
    items.push(it);
    if (items.length >= MAX_ITEMS) break;
  }
  items.sort((a, b) => a.added - b.added || a.url.localeCompare(b.url));
  return { items, tomb };
}

class Sync {
  // bookmarks: { get(): array, set(array) }
  constructor({ dir, bookmarks, onChange = () => {} }) {
    this.dir = dir;
    this.keyFile = path.join(dir, 'sync.key');
    this.state = new Store('sync', { enabled: false, folder: '', lastSync: 0, lastError: '', tomb: {} }, dir);
    this.bookmarks = bookmarks;
    this.onChange = onChange;
    this.running = null;
    this.debounce = null;
    this.timer = null;
  }

  tomb() { return this.state.data.tomb; }

  status() {
    const s = this.state.data;
    return { enabled: s.enabled, folder: s.folder, lastSync: s.lastSync, lastError: s.lastError, available: safeStorage.isEncryptionAvailable() };
  }

  _loadKey() {
    try {
      const j = JSON.parse(safeStorage.decryptString(fs.readFileSync(this.keyFile)));
      return { salt: unb64(j.salt), key: unb64(j.key) };
    } catch { return null; }
  }

  _readRemote(file, key) {
    if (!fs.existsSync(file)) return null;
    if (fs.statSync(file).size > MAX_FILE) throw new Error('Файл синхронізації надто великий.');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw.magic !== MAGIC) throw new Error('Невідомий формат файлу синхронізації.');
    let plain;
    try { plain = decrypt(key, { iv: unb64(raw.iv), tag: unb64(raw.tag), ct: unb64(raw.ct) }, Buffer.from(MAGIC)); }
    catch { throw new Error('Не вдалося розшифрувати файл: хибна парольна фраза або файл змінено.'); }
    const data = JSON.parse(plain.toString('utf8'));
    if (!data || !Array.isArray(data.items)) throw new Error('Пошкоджені дані синхронізації.');
    return { items: data.items.slice(0, MAX_ITEMS), tomb: data.tomb && typeof data.tomb === 'object' ? data.tomb : {} };
  }

  async enable(folder, passphrase) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Захищене сховище ключів недоступне в цій системі.');
    if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error('Папку не знайдено.');
    if (String(passphrase || '').length < 12) throw new Error('Парольна фраза має містити щонайменше 12 символів.');
    const file = path.join(folder, FILE_NAME);
    let salt;
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw.magic !== MAGIC) throw new Error('У папці є файл з тією самою назвою іншого формату.');
      salt = unb64(raw.salt);
    } else salt = crypto.randomBytes(16);
    const key = await deriveKey(norm(passphrase), salt, KDF_DEFAULT);
    this._readRemote(file, key); // перевіряє парольну фразу, якщо файл уже є
    writeAtomic(fs, this.keyFile, safeStorage.encryptString(JSON.stringify({ salt: b64(salt), key: b64(key) })));
    Object.assign(this.state.data, { enabled: true, folder, lastError: '' });
    this.state.flush();
    this.start();
    await this.syncNow();
    if (this.state.data.lastError) {
      const err = this.state.data.lastError;
      this.disable();
      throw new Error(err);
    }
  }

  disable() {
    this.stop();
    Object.assign(this.state.data, { enabled: false, lastError: '' });
    this.state.flush();
    try { fs.unlinkSync(this.keyFile); } catch { /* ignore */ }
    this.onChange();
  }

  start() {
    this.stop();
    this.timer = setInterval(() => this.syncNow(), 3 * 60 * 1000);
  }
  stop() { clearInterval(this.timer); clearTimeout(this.debounce); this.timer = null; }

  schedule() {
    if (!this.state.data.enabled) return;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.syncNow(), 4000);
  }

  async syncNow() {
    const s = this.state.data;
    if (!s.enabled) return;
    if (this.running) return this.running;
    this.running = (async () => {
      await null; // гарантує, що this.running буде присвоєно до завершення тіла
      try {
        const k = this._loadKey();
        if (!k) throw new Error('Ключ синхронізації втрачено. Налаштуйте синхронізацію заново.');
        const file = path.join(s.folder, FILE_NAME);
        if (!fs.existsSync(s.folder)) throw new Error('Папка синхронізації недоступна.');
        const remote = this._readRemote(file, k.key) || { items: [], tomb: {} };
        const local = this.bookmarks.get();
        const merged = merge(local, s.tomb, remote.items, remote.tomb);

        // застосовуємо до локальних закладок
        const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
        const localNorm = merge(local, s.tomb, [], {}).items;
        if (!same(localNorm, merged.items)) this.bookmarks.set(merged.items);
        s.tomb = merged.tomb;

        // записуємо у спільну папку лише коли є зміни
        const remoteNorm = merge(remote.items, remote.tomb, [], {});
        if (!same(remoteNorm.items, merged.items) || !same(remoteNorm.tomb, merged.tomb)) {
          const env = encrypt(k.key, Buffer.from(JSON.stringify({ v: 1, items: merged.items, tomb: merged.tomb, time: Date.now() })), Buffer.from(MAGIC));
          writeAtomic(fs, file, JSON.stringify({ magic: MAGIC, salt: b64(k.salt), iv: b64(env.iv), tag: b64(env.tag), ct: b64(env.ct) }));
        }
        s.lastSync = Date.now();
        s.lastError = '';
      } catch (e) {
        s.lastError = e.message;
      } finally {
        this.state.save();
        this.running = null;
        this.onChange();
      }
    })();
    return this.running;
  }
}

module.exports = { Sync, merge, FILE_NAME };
