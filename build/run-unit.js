'use strict';
// Запуск unit-тестів без Electron: `node --test` по всіх test/unit/*.test.js.
// Опція --coverage вмикає вимірювання покриття коду.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = path.join(__dirname, '..', 'test', 'unit');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js')).sort().map(f => path.join(dir, f));
if (!files.length) { console.error('Немає файлів у test/unit'); process.exit(1); }

const withCoverage = process.argv.includes('--coverage');
const nodeArgs = [];
if (withCoverage) nodeArgs.push('--experimental-test-coverage');
nodeArgs.push('--test', ...files);

const r = spawnSync(process.execPath, nodeArgs, { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
