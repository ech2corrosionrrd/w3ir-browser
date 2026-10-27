'use strict';
// npm test: повний автотест у ізольованих тимчасових профілях. Код виходу 1, якщо є збої або не отримано підсумок.
// Тести запускаються всередині Electron зі справжніми вікнами (потрібен робочий стіл Windows); див. docs/TESTING.md.
// Області розподіляються між паралельними екземплярами Electron (типово 2): `W3IR_SHARDS=1 npm test` — один екземпляр.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3ir-test-'));
const electron = require('electron'); // шлях до виконуваного файлу Electron
const shards = Math.max(1, Number(process.env.W3IR_SHARDS) || 2);

const runShard = (k) => new Promise((resolve) => {
  const env = { ...process.env, W3IR_USER_DATA: path.join(dir, 'data' + k), W3IR_SMOKE: 'security' };
  delete env.ELECTRON_RUN_AS_NODE;
  if (shards > 1) env.W3IR_SHARD = `${k}/${shards}`;
  const label = shards > 1 ? `[${k + 1}/${shards}] ` : '';
  let summary = null;
  let tail = '';
  const child = spawn(electron, ['.'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const onData = (buf) => {
    tail += buf.toString('utf8');
    const lines = tail.split('\n');
    tail = lines.pop();
    for (const l of lines) {
      if (/\[sec\] (FAIL|ERROR|TIME)|RESULT/.test(l)) console.log(label + l.trim());
      const m = /RESULT: (\d+) passed, (\d+) failed/.exec(l);
      if (m) summary = { passed: Number(m[1]), failed: Number(m[2]) };
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('close', () => resolve(summary));
});

(async () => {
  const results = await Promise.all(Array.from({ length: shards }, (_, k) => runShard(k)));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  if (results.some(r => !r)) { console.error('Підсумок тестів не отримано (збій запуску Electron?).'); process.exit(1); }
  const passed = results.reduce((a, r) => a + r.passed, 0);
  const failed = results.reduce((a, r) => a + r.failed, 0);
  console.log(`Тести: ${passed} пройдено, ${failed} провалено.`);
  process.exit(failed ? 1 : 0);
})();
