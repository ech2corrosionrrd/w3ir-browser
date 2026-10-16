'use strict';
// Автооновлення: перевірка, завантаження у фоні, перевірка підпису випускача та встановлення при виході/за кліком.
const { app, Notification, dialog, shell } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const { verifyFile, fingerprint } = require('./update-verify');

const CHECK_EVERY = 6 * 60 * 60 * 1000;
// Офіційне джерело оновлень (публічні релізи GitHub); користувач може вказати власне в налаштуваннях
const DEFAULT_FEED = 'github:ech2corrosionrrd/w3ir-browser';
const { stripCtl } = require('./util');
const clip = (s, n) => stripCtl(s, n);

// Джерело оновлень: «github:власник/репозиторій» або https-адреса теки зі статичними файлами
function parseFeed(feed, allowInsecure = false) {
  feed = String(feed || '').trim();
  let m = /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(feed);
  if (m) return { provider: 'github', owner: m[1], repo: m[2], releaseType: 'release' };
  try {
    const u = new URL(feed);
    const local = allowInsecure && u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
    if ((u.protocol === 'https:' || local) && !u.username && !u.password) return { provider: 'generic', url: feed.endsWith('/') ? feed : feed + '/' };
  } catch { /* не адреса */ }
  return null;
}

class Updater {
  constructor({ getCfg, onChange = () => {}, onReady = () => {}, publicKey, allowInsecure = false, forceDev = false, cacheDirName = 'w3ir-browser-updater', defaultFeed = DEFAULT_FEED, logFile = '' }) {
    this.getCfg = getCfg;
    this.onReady = onReady;
    this.logFile = logFile;
    this.defaultFeed = defaultFeed;
    this.onChange = onChange;
    this.publicKey = publicKey;
    this.allowInsecure = allowInsecure;
    this.forceDev = forceDev;
    this.info = null;
    this.timer = null;
    this.state = { state: 'idle', version: '', percent: 0, error: '', notes: '', checkedAt: 0 };

    const u = autoUpdater;
    // Журнал оновлень (updater.log у теці даних) — допомагає розібратися, якщо щось пішло не так
    u.logger = { info: (m) => this.log('info', m), warn: (m) => this.log('warn', m), error: (m) => this.log('error', m), debug: () => {} };
    u.autoDownload = false;
    u.autoInstallOnAppQuit = false; // вмикається лише після успішної перевірки підпису
    u.allowDowngrade = false;
    u.allowPrerelease = false;
    u.disableWebInstaller = true;
    u.forceDevUpdateConfig = forceDev;
    // Конфігурація задається в коді, а не з app-update.yml; publisherName змушує electron-updater викликати нашу перевірку підпису
    u.configOnDisk = { value: Promise.resolve({ provider: 'generic', url: 'https://invalid.invalid/', publisherName: ['W3IR'], updaterCacheDirName: cacheDirName }) };
    u.verifyUpdateCodeSignature = (names, file) => this.verifyDownloaded(file);

    u.on('checking-for-update', () => this.set({ state: 'checking', error: '' }));
    u.on('update-available', (info) => {
      this.info = info;
      this.set({ state: 'available', version: clip(info.version, 40), notes: this.notes(info), error: '' });
    });
    u.on('update-not-available', () => this.set({ state: 'none', version: '', error: '', checkedAt: Date.now() }));
    u.on('download-progress', (p) => this.set({ state: 'downloading', percent: Math.round(p.percent || 0) }));
    u.on('update-downloaded', async (ev) => {
      // Друга лінія захисту: перевіряємо підпис ще раз (кеш електрон-апдейтера міг підсунути готовий файл)
      const bad = await this.verifyDownloaded(ev.downloadedFile);
      if (bad) { this.fail(bad, ev.downloadedFile); return; }
      u.autoInstallOnAppQuit = true;
      this.set({ state: 'ready', version: clip(ev.version, 40), percent: 100, checkedAt: Date.now() });
    });
    u.on('error', (e) => this.fail(e && e.message ? e.message : String(e)));
  }

  notes(info) {
    let n = info.releaseNotes;
    if (Array.isArray(n)) n = n.map(x => x.note || '').join('\n');
    return clip(String(n || '').replace(/<[^>]+>/g, ' '), 600);
  }

  fail(msg, file) {
    autoUpdater.autoInstallOnAppQuit = false;
    if (file) { try { fs.unlinkSync(file); } catch { /* ignore */ } }
    this.set({ state: 'error', error: clip(msg, 300), checkedAt: Date.now() });
  }

  async verifyDownloaded(file) {
    const info = this.info;
    if (!info) return 'Немає даних про оновлення.';
    return verifyFile({ publicPem: this.publicKey, version: info.version, signature: info.w3irSignature, file });
  }

  log(level, msg) {
    if (!this.logFile) return;
    try {
      const line = `${new Date().toISOString()} [${level}] ${String(msg && msg.stack ? msg.stack : msg).replace(/\s+/g, ' ').slice(0, 600)}\n`;
      try { if (fs.statSync(this.logFile).size > 200 * 1024) fs.renameSync(this.logFile, this.logFile + '.old'); } catch { /* файлу ще немає */ }
      if (!fs.existsSync(this.logFile)) fs.writeFileSync(this.logFile, '﻿'); // UTF-8 з позначкою, щоб Блокнот/PowerShell правильно показували кирилицю
      fs.appendFileSync(this.logFile, line);
    } catch { /* журнал необов'язковий */ }
  }

  set(patch) {
    const was = this.state.state;
    Object.assign(this.state, patch);
    if (patch.state && patch.state !== was) this.log('state', `${was} -> ${patch.state}${patch.version ? ' ' + patch.version : ''}${patch.error ? ' (' + patch.error + ')' : ''}`);
    if (patch.state === 'ready' && was !== 'ready') { try { this.onReady(this.state.version); } catch { /* ignore */ } }
    this.onChange();
  }

  feed() { return parseFeed(this.getCfg().updateFeed || this.defaultFeed, this.allowInsecure); }
  enabled() { return (app.isPackaged || this.forceDev) && !!this.feed(); }

  status() {
    const cfg = this.getCfg();
    const f = this.feed();
    return {
      ...this.state, current: app.getVersion(), autoUpdate: cfg.autoUpdate !== false, feed: cfg.updateFeed || '', defaultFeed: this.defaultFeed, feedValid: !!f,
      packaged: app.isPackaged || this.forceDev, fingerprint: fingerprint(this.publicKey), logFile: this.logFile,
    };
  }
  brief() { return { state: this.state.state, version: this.state.version, percent: this.state.percent }; }

  start() {
    this.stop();
    setTimeout(() => this.check(), 20000);
    this.timer = setInterval(() => this.check(), CHECK_EVERY);
  }
  stop() { clearInterval(this.timer); this.timer = null; }

  async check({ manual = false } = {}) {
    if (['checking', 'downloading', 'ready'].includes(this.state.state)) return this.status();
    const f = this.feed();
    if (!(app.isPackaged || this.forceDev)) { this.set({ state: 'idle', error: manual ? 'У режимі розробки оновлення вимкнено.' : '' }); return this.status(); }
    if (!f) { this.set({ state: 'idle', error: manual ? 'Джерело оновлень не налаштовано.' : '' }); return this.status(); }
    try {
      autoUpdater.setFeedURL(f);
      const r = await autoUpdater.checkForUpdates();
      if (r && r.isUpdateAvailable && this.state.state === 'available' && (this.getCfg().autoUpdate !== false || manual)) {
        await this.download();
      }
    } catch (e) {
      if (this.state.state !== 'error') this.fail(e.message);
    }
    return this.status();
  }

  async download() {
    if (this.state.state !== 'available') return;
    this.log('download', 'початок');
    try { this.set({ state: 'downloading', percent: 0 }); await autoUpdater.downloadUpdate(); }
    catch (e) { if (this.state.state !== 'error') this.fail(e.message); }
  }

  install() {
    if (this.state.state !== 'ready') return false;
    this.log('install', `quitAndInstall (версія ${this.state.version})`);
    this.writeAttempt();
    try {
      new Notification({ title: 'W3IR Browser', body: `Встановлюється оновлення ${this.state.version}. Браузер закриється й сам запуститься приблизно за 30 секунд — не відкривайте його вручну.` }).show();
    } catch { /* сповіщення необов'язкове */ }
    autoUpdater.quitAndInstall(true, true);
    // Якщо браузер не завершився за 20 с — встановлення не розпочалося: повідомляємо й лишаємо автовстановлення при виході
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.log('error', 'застосунок не завершився після quitAndInstall за 20 с');
      autoUpdater.autoInstallOnAppQuit = true;
      this.set({ state: 'ready', error: 'Не вдалося автоматично перезапустити для встановлення. Закрийте браузер вручну — оновлення встановиться при виході.' });
    }, 20000);
    this.watchdog.unref && this.watchdog.unref();
    return true;
  }

  logPath() { return this.logFile; }

  // ---------- облік спроби встановлення ----------
  attemptFile() { return this.logFile ? path.join(path.dirname(this.logFile), 'update-attempt.json') : ''; }

  writeAttempt() {
    const f = this.attemptFile();
    if (!f) return;
    try {
      const helper = autoUpdater.downloadedUpdateHelper;
      fs.writeFileSync(f, JSON.stringify({
        from: app.getVersion(), to: this.state.version, time: Date.now(),
        installer: helper && helper.file ? helper.file : '', signature: this.info && this.info.w3irSignature ? this.info.w3irSignature : '',
      }));
    } catch (e) { this.log('error', `не вдалося записати update-attempt.json: ${e.message}`); }
  }

  readAttempt() {
    try { return JSON.parse(fs.readFileSync(this.attemptFile(), 'utf8')); } catch { return null; }
  }

  clearAttempt() { try { fs.unlinkSync(this.attemptFile()); } catch { /* ignore */ } }

  // Викликається після запуску: підсумок попередньої спроби встановлення (успіх чи збій)
  async afterStart({ toast = () => {}, parent } = {}) {
    const a = this.readAttempt();
    if (!a) return 'none';
    this.clearAttempt();
    const cur = app.getVersion();
    if (cur === a.to) {
      this.log('install', `успішно: ${a.from} -> ${cur}`);
      toast(`Браузер оновлено до версії ${cur}`);
      return 'success';
    }
    if (cur !== a.from || Date.now() - a.time > 6 * 3600 * 1000) return 'stale';
    this.log('error', `встановлення ${a.to} не відбулося (досі ${cur})`);
    const r = await dialog.showMessageBox(parent || undefined, {
      type: 'warning', buttons: ['Відкрити інсталятор', 'Пізніше'], defaultId: 0, cancelId: 1,
      message: `Не вдалося автоматично встановити оновлення ${a.to}`,
      detail: 'Можна встановити його вручну: відкриється інсталятор оновлення (натисніть «Далі» й «Встановити»). Файл перевірено підписом випускача.',
    }).catch(() => ({ response: 1 }));
    if (r.response !== 0) return 'failed';
    if (!a.installer || !fs.existsSync(a.installer)) { toast('Файл оновлення не знайдено — перевірте оновлення в налаштуваннях'); return 'failed'; }
    const bad = await verifyFile({ publicPem: this.publicKey, version: a.to, signature: a.signature, file: a.installer });
    if (bad) { this.log('error', `ручне встановлення скасовано: ${bad}`); toast(`Файл оновлення не пройшов перевірку підпису: ${bad}`); return 'failed'; }
    this.log('install', `відкриваємо інсталятор вручну: ${a.installer}`);
    shell.openPath(a.installer);
    return 'manual';
  }

  resetForTest() { this.info = null; this.state = { state: 'idle', version: '', percent: 0, error: '', notes: '', checkedAt: 0 }; autoUpdater.autoInstallOnAppQuit = false; }
}

// Чи працює зараз інсталятор браузера (щоб не запускати браузер посеред оновлення)
function installerRunning(csv) {
  return String(csv).split(/\r?\n/).some(l => /^"W3IR-Browser-Setup[^"]*\.exe"/i.test(l.trim()));
}
function installerIsRunning() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => resolve(!err && installerRunning(out)));
  });
}

module.exports = { Updater, parseFeed, DEFAULT_FEED, installerRunning, installerIsRunning };
