'use strict';
// Crash/error log without secrets: redacts keys, tokens, seed-like word runs and user home paths; rate-limited; rotated.
const fs = require('fs');

const MAX_BYTES = 256 * 1024;
const PER_MINUTE = 30;

function redact(input) {
  let s = String(input == null ? '' : input);
  s = s.replace(/[A-Za-z]:\\Users\\[^\\/\s'"]+/gi, '<home>');
  s = s.replace(/(bearer|authorization|token|password|passphrase|seed|mnemonic|secret|private[_ -]?key|api[_-]?key)(["'\s:=]+)[^\s,;"'}]+/gi, '$1$2[redacted]');
  s = s.replace(/\b(?:[a-z]{3,8}\s+){11,}[a-z]{3,8}\b/g, '[words]');
  s = s.replace(/\b0x[0-9a-fA-F]{40,}\b/g, '[hex]');
  s = s.replace(/\b[0-9a-fA-F]{40,}\b/g, '[hex]');
  s = s.replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, '[token]');
  return s;
}

class CrashLog {
  constructor(file) { this.file = file; this.stamps = []; }

  // kind: short label; err: Error or any value; extra: small plain object (values are redacted)
  note(kind, err, extra) {
    const now = Date.now();
    this.stamps = this.stamps.filter(t => now - t < 60000);
    if (this.stamps.length >= PER_MINUTE) return false;
    this.stamps.push(now);
    const e = err && typeof err === 'object' ? err : { message: String(err) };
    const line = {
      t: new Date(now).toISOString(), kind: String(kind).slice(0, 40),
      name: String(e.name || '').slice(0, 60), message: redact(e.message).slice(0, 500),
      stack: redact(e.stack).split('\n').slice(0, 8).join('\n').slice(0, 1500),
    };
    if (extra && typeof extra === 'object') for (const [k, v] of Object.entries(extra)) line[String(k).slice(0, 30)] = redact(v).slice(0, 200);
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > MAX_BYTES) fs.renameSync(this.file, this.file + '.old');
      fs.appendFileSync(this.file, JSON.stringify(line) + '\n', { mode: 0o600 });
      return true;
    } catch { return false; }
  }
}

// Handlers for the main process: log + flush; never exit silently. onFirst runs at most once per 5 minutes (user-visible hint),
// onRepeated runs when >= limit uncaught exceptions happen within a minute (state is probably broken).
function install(proc, log, { flush, onFirst, onRepeated, limit = 10 } = {}) {
  const hits = [];
  let lastNotice = 0;
  const safe = (fn, ...a) => { try { if (fn) fn(...a); } catch { /* ignore */ } };
  const onEx = (e) => {
    log.note('uncaughtException', e);
    safe(flush);
    const now = Date.now();
    while (hits.length && now - hits[0] > 60000) hits.shift();
    hits.push(now);
    if (now - lastNotice > 300000) { lastNotice = now; safe(onFirst, e); }
    if (hits.length >= limit) safe(onRepeated, e);
  };
  const onRej = (r) => { log.note('unhandledRejection', r); };
  proc.on('uncaughtException', onEx);
  proc.on('unhandledRejection', onRej);
  return () => { proc.off('uncaughtException', onEx); proc.off('unhandledRejection', onRej); };
}

module.exports = { CrashLog, install, redact };
