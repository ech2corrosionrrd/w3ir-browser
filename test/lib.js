'use strict';
// Спільні помічники тестів: лічильники, ok(), тимчасові теки.
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const stats = { pass: 0, failed: 0 };
const ok = (cond, name) => { cond ? stats.pass++ : stats.failed++; console.log(`[sec] ${cond ? 'PASS' : 'FAIL'} ${name}`); };
const tmpDirs = [];
const tmp = (n) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'w3ir-' + n + '-')); tmpDirs.push(d); return d; };
const cleanup = () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } };

module.exports = { sleep, stats, ok, tmp, cleanup };
