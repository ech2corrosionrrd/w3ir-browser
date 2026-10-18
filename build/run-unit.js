'use strict';
// Запуск unit-тестів без Electron: `node --test` по всіх test/unit/*.test.js.
// Свій запускач потрібен, бо Node 20 не розуміє glob, а Node 24 не приймає теку.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = path.join(__dirname, '..', 'test', 'unit');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js')).sort().map(f => path.join(dir, f));
if (!files.length) { console.error('Немає файлів у test/unit'); process.exit(1); }
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
