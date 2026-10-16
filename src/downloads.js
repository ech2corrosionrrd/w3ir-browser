'use strict';
const { app, shell, dialog, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { Store } = require('./store');

function uniquePath(dir, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let p = path.join(dir, filename);
  for (let i = 1; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

class Downloads {
  constructor(ctx) {
    this.ctx = ctx;
    this.store = new Store('downloads', [], ctx.dir);
    this.live = new Map(); // id -> DownloadItem
    this.timer = null;
    for (const d of this.store.data) if (d.state === 'progressing' || d.state === 'paused') d.state = 'interrupted';
  }

  list() { return this.store.data; }

  attach(ses, incognito) {
    ses.on('will-download', (e, item) => this.onDownload(item, incognito));
  }

  onDownload(item, incognito) {
    const s = this.ctx.cfg();
    if (s.safeBrowsing !== false && this.ctx.threats) {
      const th = this.ctx.threats.check(item.getURL());
      if (th && th.severity === 'listed') {
        item.cancel();
        const w = [...this.ctx.windows].pop();
        if (w) w.toast('Завантаження заблоковано: сайт розповсюджує шкідливе ПЗ або шахрайський');
        return;
      }
    }
    if (!s.askDownload) {
      const dir = s.downloadDir && fs.existsSync(s.downloadDir) ? s.downloadDir : app.getPath('downloads');
      item.setSavePath(uniquePath(dir, item.getFilename()));
    }
    const rec = {
      id: randomUUID(), filename: item.getFilename(), url: incognito ? '' : item.getURL(),
      path: item.getSavePath(), total: item.getTotalBytes(), received: 0, state: 'progressing', start: Date.now(),
    };
    if (!incognito) { this.store.data.unshift(rec); if (this.store.data.length > 500) this.store.data.length = 500; }
    this.live.set(rec.id, { item, rec });
    item.on('updated', (_, state) => {
      rec.received = item.getReceivedBytes();
      rec.total = item.getTotalBytes();
      rec.path = item.getSavePath() || rec.path;
      if (rec.path) rec.filename = path.basename(rec.path);
      rec.state = state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing';
      this.changed();
    });
    item.once('done', (_, state) => {
      rec.received = item.getReceivedBytes();
      rec.state = state; // completed | cancelled | interrupted
      this.live.delete(rec.id);
      this.changed(true);
      if (state === 'completed' && /\.torrent$/i.test(rec.path || '')) this.offerTorrent(rec.path);
    });
    this.changed(true);
  }

  // Завантажений .torrent-файл пропонуємо відкрити у зовнішньому торент-клієнті
  async offerTorrent(file) {
    const cfg = this.ctx.cfg();
    if (cfg.torrentConfirm) {
      const opts = {
        type: 'question', buttons: ['Відкрити в торент-клієнті', 'Залишити файл'], defaultId: 1, cancelId: 1,
        message: 'Завантажено .torrent-файл', detail: path.basename(file) + '\n\nПід час роздачі та завантаження торентів ваша IP-адреса видима іншим учасникам.',
        checkboxLabel: 'Більше не питати',
      };
      const parent = BrowserWindow.getFocusedWindow();
      const r = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
      if (r.response !== 0) return;
      if (r.checkboxChecked) { cfg.torrentConfirm = false; this.ctx.settingsStore.save(); }
    }
    shell.openPath(file);
  }

  changed(now) {
    this.store.save();
    if (now) { clearTimeout(this.timer); this.timer = null; this.ctx.pushAll(); return; }
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.ctx.pushAll(); }, 300);
  }

  summary() {
    let active = 0, total = 0, received = 0;
    for (const { rec } of this.live.values()) { active++; total += rec.total; received += rec.received; }
    return { active, percent: total > 0 ? Math.round((received / total) * 100) : -1 };
  }

  action(id, action) {
    const live = this.live.get(id);
    const rec = this.store.data.find(d => d.id === id);
    if (action === 'cancel' && live) live.item.cancel();
    else if (action === 'pause' && live) live.item.pause();
    else if (action === 'resume' && live && live.item.canResume()) live.item.resume();
    else if (rec && action === 'open' && rec.path && rec.state === 'completed') shell.openPath(rec.path);
    else if (rec && action === 'show' && rec.path) shell.showItemInFolder(rec.path);
    else if (rec && action === 'remove' && !live) this.store.data.splice(this.store.data.indexOf(rec), 1);
    else if (action === 'clear') this.store.data = this.store.data.filter(d => this.live.has(d.id));
    this.changed(true);
  }
}

module.exports = { Downloads };
