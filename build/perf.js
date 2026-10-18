'use strict';
// Вимірювання продуктивності: `npm run perf` (Windows, потрібна робоча стільниця). Нічого не змінює в профілі користувача:
// браузер запускається з тимчасовим профілем. Результат — JSON у stdout і рядок-таблиця для docs/PERFORMANCE.md.
//   1) Store.flush на типових розмірах JSON; 2) старт до появи інтерфейсу; 3) пам'ять усіх процесів у спокої та з вкладками;
//   4) синхронний IPC (wallet:init) через build/perf-ipc.js.
// Скрипт сам перезапускає себе під Electron як Node (там є WebSocket і fetch).
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const electron = require(path.join(root, 'node_modules', 'electron'));

if (!process.versions.electron) {
  const r = spawnSync(electron, [__filename, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  process.exit(r.status === null ? 1 : r.status);
}

const PORT = 9444;
const TABS = Number(process.env.PERF_TABS || 5);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const appEnv = (extra = {}) => { const e = { ...process.env, ...extra }; delete e.ELECTRON_RUN_AS_NODE; return e; };
const stats = (a) => { const s = [...a].sort((x, y) => x - y); return { n: s.length, p50: +s[s.length >> 1].toFixed(2), p95: +s[Math.floor(s.length * 0.95)].toFixed(2), max: +s[s.length - 1].toFixed(2) }; };
const mb = (b) => +(b / 1048576).toFixed(0);

// ---- 1. Store.flush (чистий Node: теку передаємо явно, модуль electron не потрібен) ----
function benchStore() {
  const { Store } = require(path.join(root, 'src', 'store.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3ir-perf-store-'));
  const out = {};
  for (const [label, items] of [['≈10 КБ', 100], ['≈500 КБ', 5000], ['≈5 МБ', 50000]]) {
    const s = new Store('bench-' + items, { list: [] }, dir);
    s.data.list = Array.from({ length: items }, (_, i) => ({ id: i, url: 'https://example.com/page/' + i, title: 'Сторінка ' + i, t: Date.now() }));
    const times = [];
    for (let i = 0; i < 15; i++) { const t = performance.now(); s.flush(); times.push(performance.now() - t); }
    out[label] = stats(times.slice(1));
    clearTimeout(s.timer);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

// ---- пам'ять процесів: усі процеси, чий командний рядок містить наш тимчасовий профіль ----
function memoryMb(marker) {
  const ps = `(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' } | Measure-Object -Property WorkingSetSize -Sum).Sum`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  return mb(Number(String(r.stdout).trim()) || 0);
}

const cdp = (ws) => new Promise((res, rej) => {
  const s = new WebSocket(ws); let id = 0; const pend = new Map();
  s.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  s.onerror = rej;
  s.onopen = () => res({ send: (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); s.send(JSON.stringify({ id: i, method, params })); }), close: () => s.close() });
});
const pages = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page');
async function evalIn(t, expr) {
  const c = await cdp(t.webSocketDebuggerUrl);
  const r = await Promise.race([c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }), sleep(8000).then(() => ({}))]);
  c.close();
  return r.result && r.result.result ? r.result.result.value : undefined;
}

async function benchApp() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'w3ir-perf-app-'));
  // локальна сторінка для вкладок: звичайний вміст, щоб міряти справжній рендерер
  const body = '<!doctype html><title>perf</title>' + '<p>Текст сторінки для вимірювань пам\'яті.</p>'.repeat(400);
  const srv = http.createServer((q, s) => { s.setHeader('content-type', 'text/html; charset=utf-8'); s.end(body); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const t0 = Date.now();
  const child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${data}`], {
    cwd: root, stdio: 'ignore', env: appEnv({ W3IR_USER_DATA: data }),
  });
  const res = {};
  try {
    let ui = null;
    while (!ui && Date.now() - t0 < 30000) { try { ui = (await pages()).find(t => t.url === 'w3ir://ui/index.html'); } catch { /* ще не готовий */ } if (!ui) await sleep(100); }
    if (!ui) throw new Error('Інтерфейс не з\'явився за 30 с');
    res.startupMs = Date.now() - t0;
    await sleep(4000); // відкладені фонові завдання (оновлення, списки загроз, блокувальник)
    res.idleMb = memoryMb(path.basename(data));
    const base = res.idleMb;
    for (let i = 0; i < TABS; i++) { await evalIn(ui, `api.cmd('newTab')`); await sleep(400); await evalIn(ui, `api.cmd('go', ${JSON.stringify(url)})`); await sleep(1500); }
    await sleep(2500);
    res.tabs = TABS;
    res.withTabsMb = memoryMb(path.basename(data));
    res.perTabMb = +((res.withTabsMb - base) / TABS).toFixed(0);
  } finally {
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    srv.close();
    await sleep(1500);
    try { fs.rmSync(data, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return res;
}

function benchIpc() {
  const r = spawnSync(electron, [path.join(__dirname, 'perf-ipc.js')], { encoding: 'utf8', env: appEnv(), timeout: 60000 });
  const line = String(r.stdout).trim().split('\n').pop();
  try { return JSON.parse(line); } catch { return { error: 'не вдалося розібрати вивід', stderr: String(r.stderr).slice(0, 200) }; }
}

(async () => {
  const result = { date: new Date().toISOString().slice(0, 10), electron: process.versions.electron, node: process.versions.node, os: `${os.type()} ${os.release()}`, cpus: os.cpus().length, ramGb: +(os.totalmem() / 2 ** 30).toFixed(0) };
  result.storeFlushMs = benchStore();
  result.ipcSyncMs = benchIpc();
  result.app = await benchApp();
  console.log(JSON.stringify(result, null, 2));
})().catch(e => { console.error('ПОМИЛКА:', e.message); process.exit(1); });
