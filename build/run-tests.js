'use strict';
// npm test: повний автотест у ізольованому тимчасовому профілі. Код виходу 1, якщо є збої або не отримано підсумок.
// Тести запускаються всередині Electron зі справжніми вікнами (потрібен робочий стіл Windows); див. docs/TESTING.md.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3ir-test-'));
const electron = require('electron'); // шлях до виконуваного файлу Electron
const env = { ...process.env, W3IR_USER_DATA: path.join(dir, 'data'), W3IR_SMOKE: 'security' };
delete env.ELECTRON_RUN_AS_NODE;

let summary = null;
let tail = '';
const child = spawn(electron, ['.'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
const onData = (buf) => {
  tail += buf.toString('utf8');
  const lines = tail.split('\n');
  tail = lines.pop();
  for (const l of lines) {
    if (/\[sec\] (FAIL|ERROR)|RESULT/.test(l)) console.log(l.trim());
    const m = /RESULT: (\d+) passed, (\d+) failed/.exec(l);
    if (m) summary = { passed: Number(m[1]), failed: Number(m[2]) };
  }
};
child.stdout.on('data', onData);
child.stderr.on('data', onData);
child.on('close', () => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  if (!summary) { console.error('Підсумок тестів не отримано (збій запуску Electron?).'); process.exit(1); }
  console.log(`Тести: ${summary.passed} пройдено, ${summary.failed} провалено.`);
  process.exit(summary.failed ? 1 : 0);
});
