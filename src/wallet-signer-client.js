'use strict';
// Клієнт процесу-підписувача в головному процесі: запускає його при першому виклику, зіставляє відповіді із запитами,
// обмежує час очікування, вважає збій процесу помилкою (а не зависанням) і вимикає процес після простою.
// Після завершення процесу seed у ньому зникає, тож наступний виклик потребує нового `unlock`.
const path = require('path');

const defaultSpawn = () => require('electron').utilityProcess.fork(path.join(__dirname, 'wallet-signer.js'), [], { serviceName: 'W3IR wallet signer' });

class SignerClient {
  constructor({ spawn = defaultSpawn, timeoutMs = 10000, idleMs = 5 * 60 * 1000 } = {}) {
    this.spawn = spawn;
    this.timeoutMs = timeoutMs;
    this.idleMs = idleMs;
    this.child = null;
    this.pending = new Map();
    this.seq = 0;
    this.idleTimer = null;
    this.locking = null; // триває блокування: нові виклики чекають, а потім запускають свіжий процес
  }

  running() { return !!this.child; }

  _ensure() {
    if (this.child) return this.child;
    const c = this.spawn();
    c.on('message', (m) => this._onMessage(m));
    c.on('exit', () => this._onExit(c));
    this.child = c;
    return c;
  }

  _onMessage(m) {
    const p = m && typeof m === 'object' ? this.pending.get(m.id) : null;
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok) p.resolve(m.result); else p.reject(new Error(String(m.error || 'signer error')));
  }

  _onExit(c) {
    if (this.child !== c) return;
    this.child = null;
    clearTimeout(this.idleTimer);
    this._rejectAll('signer-crashed');
  }

  _rejectAll(reason) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    this.pending.clear();
  }

  _touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.kill(), this.idleMs);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  async call(op, args) {
    if (this.locking) await this.locking;
    return this._callNow(op, args);
  }

  _callNow(op, args) {
    return new Promise((resolve, reject) => {
      let c;
      try { c = this._ensure(); } catch (e) { reject(new Error('signer-unavailable')); return; }
      const id = ++this.seq;
      // Після тайм-ауту стан процесу невідомий: завершуємо його, щоб не лишати seed у «завислому» процесі
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('signer-timeout')); this.kill(); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { c.postMessage({ id, op, args }); } catch { this.pending.delete(id); clearTimeout(timer); reject(new Error('signer-unavailable')); return; }
      this._touch();
    });
  }

  // Блокування: просимо обнулити стан, потім завершуємо процес
  lock() {
    if (this.locking) return this.locking;
    // .finally виконується після присвоєння: без цього при відсутньому процесі locking лишався б «застряглим» і наступні блокування не діяли
    const p = (async () => {
      if (this.child) { try { await this._callNow('lock'); } catch { /* процес і так буде завершено */ } }
      this.kill();
    })().finally(() => { if (this.locking === p) this.locking = null; });
    this.locking = p;
    return p;
  }

  kill() {
    clearTimeout(this.idleTimer);
    const c = this.child;
    this.child = null;
    this._rejectAll('signer-stopped');
    if (c) { try { c.kill(); } catch { /* уже завершено */ } }
  }
}

module.exports = { SignerClient };
