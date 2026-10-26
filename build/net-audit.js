'use strict';
// Аудит мережі: `npm run net-audit [-- --idle 120]` (Windows, потрібна робоча стільниця). Нічого не змінює в профілі користувача.
// Запускає браузер з чистим тимчасовим профілем і записує ВСІ вихідні запити (src/net-audit.js: сесії Chromium і з'єднання Node,
// плюс DNS-запити з net-log). Фази: 1) старт (фонові завантаження), 2) набір тексту з помилками (спелчек), 3) спокій.
// Перевірка: будь-яка адреса поза переліком — помилка; у спокої дозволено лише wpad (автовизначення проксі в Chromium).
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

const PORT = 9445;
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? Number(process.argv[i + 1]) : d; };
const IDLE_S = arg('idle', 120);
const START_S = arg('start', 60);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Дозволено на старті (src/adblock.js, src/threats.js, src/updater.js); у спокої — нічого, крім wpad.
const START_OK = [
  'raw.githubusercontent.com', 'malware-filter.gitlab.io', 'gitlab.io', 'github.com', 'api.github.com',
  'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com', 'wpad',
];
const IDLE_OK = ['wpad'];
const CONTROL = 'https://example.com/';
const okHost = (h, list) => list.some(x => h === x || h.endsWith('.' + x));

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

function readAudit(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
}

// DNS-запити Chromium з net-log (час у журналі — відносний; переводимо в Unix-мс через timeTickOffset)
function readNetLogDns(file) {
  let raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  if (!raw) return [];
  if (!raw.endsWith('}')) raw = raw.replace(/,\s*$/, '') + ']}';
  let j;
  try { j = JSON.parse(raw); } catch { return []; }
  const typeId = j.constants.logEventTypes.HOST_RESOLVER_MANAGER_JOB;
  const off = Number(j.constants.timeTickOffset) || 0;
  return j.events.filter(e => e.type === typeId && e.params && e.params.host)
    .map(e => ({ t: Number(e.time) + off, kind: 'dns', host: String(e.params.host).replace(/^[a-z]+:\/\//i, '').replace(/:\d+$/, '') }));
}

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'w3ir-netaudit-'));
  const auditFile = path.join(data, '..', path.basename(data) + '.audit.jsonl');
  const netLog = path.join(data, '..', path.basename(data) + '.netlog.json');
  const env = { ...process.env, W3IR_USER_DATA: data, W3IR_NET_AUDIT: auditFile };
  delete env.ELECTRON_RUN_AS_NODE;
  // локальна сторінка зі спелчеком: textarea з помилками (мова uk, щоб Chromium спробував підвантажити словник)
  const srv = http.createServer((q, s) => { s.setHeader('content-type', 'text/html; charset=utf-8'); s.end('<!doctype html><html lang="uk"><title>spell</title><textarea id="t" spellcheck="true" lang="uk" style="width:400px;height:100px"></textarea><textarea id="e" spellcheck="true" lang="en" style="width:400px;height:100px"></textarea>'); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;

  const child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${data}`, `--log-net-log=${netLog}`], { cwd: root, stdio: 'ignore', env });
  const marks = {};
  try {
    let ui = null;
    const t0 = Date.now();
    while (!ui && Date.now() - t0 < 30000) { try { ui = (await pages()).find(t => t.url === 'w3ir://ui/index.html'); } catch { /* ще не готовий */ } if (!ui) await sleep(200); }
    if (!ui) throw new Error('Інтерфейс не з\'явився за 30 с');
    marks.start = Date.now();
    console.log(`Фаза 1: старт, ${START_S} с…`);
    await sleep(START_S * 1000);

    marks.spell = Date.now();
    console.log('Фаза 2: набір тексту з помилками (спелчек)…');
    await evalIn(ui, `api.cmd('newTab')`);
    await sleep(400);
    await evalIn(ui, `api.cmd('go', ${JSON.stringify(url)})`);
    await sleep(2500);
    const page = (await pages()).find(t => t.url.startsWith(url));
    if (page) {
      const c = await cdp(page.webSocketDebuggerUrl);
      for (const [id, text] of [['t', 'Првіт світе, цє тсет '], ['e', 'Helo wrold, thsi is a tset ']]) {
        await c.send('Runtime.evaluate', { expression: `document.getElementById('${id}').focus()` });
        await c.send('Input.insertText', { text });
        await sleep(1500);
      }
      c.close();
    } else console.log('  (сторінку спелчеку не знайдено — фазу пропущено)');
    await sleep(8000);
    // контроль приладу: запит вкладки до зовнішнього сайту має з'явитися в журналі Chromium
    await evalIn(ui, `api.cmd('go', ${JSON.stringify(CONTROL)})`);
    await sleep(6000);
    await evalIn(ui, `api.cmd('closeTab')`);

    marks.idle = Date.now();
    console.log(`Фаза 3: спокій, ${IDLE_S} с…`);
    await sleep(IDLE_S * 1000);
    marks.end = Date.now();
  } finally {
    try { spawnSync('taskkill', ['/PID', String(child.pid)], { stdio: 'ignore' }); } catch { /* ignore */ }
    await sleep(5000);
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    srv.close();
  }

  const recs = [...readAudit(auditFile), ...readNetLogDns(netLog)].filter(r => r.t >= (marks.start || 0) - 5000);
  const phaseOf = (t) => (t >= marks.idle ? 'idle' : t >= marks.spell ? 'spell' : 'start');
  const byPhase = { start: new Map(), spell: new Map(), idle: new Map() };
  const bad = [];
  for (const r of recs) {
    const ph = phaseOf(r.t);
    const k = `${r.kind} ${r.host}`;
    byPhase[ph].set(k, (byPhase[ph].get(k) || 0) + 1);
    if (r.host === 'example.com' && ph === 'spell') continue; // контрольний запит
    if (!okHost(r.host, ph === 'idle' ? IDLE_OK : START_OK)) bad.push({ ph, ...r });
  }
  for (const ph of ['start', 'spell', 'idle']) {
    console.log(`\n--- ${ph}`);
    for (const [k, n] of [...byPhase[ph]].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(4)}  ${k}`);
    if (!byPhase[ph].size) console.log('   (запитів немає)');
  }
  const seen = recs.some(r => r.kind === 'chromium' && r.host === 'example.com');
  console.log('\nКонтроль приладу (запит вкладки на example.com видно в журналі):', seen ? 'так' : 'НІ');
  if (!seen) bad.push({ ph: 'control', kind: 'прилад', host: 'не бачить запити Chromium' });
  const dict = fs.existsSync(path.join(data, 'Dictionaries')) ? fs.readdirSync(path.join(data, 'Dictionaries')) : [];
  console.log('\nСловники спелчеку в профілі:', dict.length ? dict.join(', ') : 'немає');
  try { fs.rmSync(data, { recursive: true, force: true }); fs.rmSync(auditFile, { force: true }); fs.rmSync(netLog, { force: true }); } catch { /* ignore */ }
  if (bad.length) {
    console.log('\nПОМИЛКА: адреси поза переліком:');
    for (const b of bad.slice(0, 30)) console.log(`  [${b.ph}] ${b.kind} ${b.host}${b.url ? ' ' + b.url : ''}`);
    process.exit(1);
  }
  console.log('\nOK: усі запити в межах переліку, у спокої — лише wpad.');
})().catch(e => { console.error('ПОМИЛКА:', e.message); process.exit(1); });
