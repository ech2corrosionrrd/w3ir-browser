'use strict';
// Аудит мережі УПАКОВАНОЇ збірки: `npm run pack && npm run net-audit:packaged [-- --start 120 --idle 120]` (Windows).
// Вбудований запис запитів (src/net-audit.js) у пакованій збірці вимкнено навмисно, тому міряємо ззовні: раз на 1,5 с опитуємо TCP-з'єднання
// усіх процесів браузера (за тимчасовим профілем у командному рядку) і зіставляємо IP з іменами з кешу DNS Windows.
// Фази: старт (оновлення, списки загроз, правила реклами), спокій. UDP/QUIC не охоплено. Профіль тимчасовий, дані користувача не чіпаються.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const exe = process.argv.slice(2).find(a => a.endsWith('.exe')) || path.join(root, 'dist', 'win-unpacked', 'W3IR Browser.exe');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? Number(process.argv[i + 1]) : d; };
const START_S = arg('start', 120);
const IDLE_S = arg('idle', 120);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Дозволено на старті (src/adblock.js, src/threats.js, src/updater.js); у спокої — нічого.
const START_OK = ['githubusercontent.com', 'gitlab.io', 'github.com', 'api.github.com', 'objects.githubusercontent.com'];

function ps(script) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return String(r.stdout || '').trim();
}
function snapshot(marker) {
  const out = ps(`$pids = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { $_.ProcessId })
if ($pids.Count -eq 0) { '[]'; exit }
@(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $pids -contains $_.OwningProcess -and $_.RemoteAddress -notin @('127.0.0.1','::1','0.0.0.0','::') -and $_.State -ne 'Listen' } | Select-Object RemoteAddress,RemotePort,State,OwningProcess) | ConvertTo-Json -Compress`);
  try { return [].concat(JSON.parse(out || '[]')); } catch { return []; }
}
function dnsMap() {
  const out = ps(`@(Get-DnsClientCache -ErrorAction SilentlyContinue | Where-Object { $_.Data } | Select-Object Entry,Data) | ConvertTo-Json -Compress`);
  const m = new Map();
  try { for (const e of [].concat(JSON.parse(out || '[]'))) if (e && e.Data) m.set(String(e.Data), String(e.Entry)); } catch { /* ignore */ }
  return m;
}
const okHost = (h) => START_OK.some(x => h === x || h.endsWith('.' + x));

(async () => {
  if (!fs.existsSync(exe)) { console.error('Немає збірки: ' + exe + ' (спершу npm run pack)'); process.exit(1); }
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'w3ir-netaudit-pk-'));
  const marker = path.basename(data);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // інакше застосунок запуститься як Node і одразу завершиться
  const child = spawn(exe, [`--user-data-dir=${data}`], { stdio: 'ignore', env });
  const seen = { start: new Map(), idle: new Map() };
  let phase = 'start';
  const t0 = Date.now();
  const names = new Map();
  let polls = 0;
  const poll = setInterval(() => {
    polls++;
    for (const c of snapshot(marker)) {
      const k = `${c.RemoteAddress}:${c.RemotePort}`;
      if (phase === 'idle' && seen.start.has(k)) continue; // тримане з'єднання зі старту — не нове
      if (!seen[phase].has(k)) seen[phase].set(k, Math.round((Date.now() - t0) / 1000));
    }
  }, 1500);
  let exited = null;
  child.on('exit', (code) => { exited = code; });
  await sleep(15000);
  const alive = ps(`@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--user-data-dir=*${marker}*' }).Count`);
  console.log('Процесів застосунку через 15 с:', alive, exited === null ? '' : `(головний процес завершився, код ${exited})`);
  if (exited !== null || Number(alive) < 2) { console.error('Застосунок не запустився — вимірювання неможливе.'); process.exit(1); }
  console.log(`Фаза 1: старт, ${START_S} с…`);
  await sleep(START_S * 1000);
  for (const [ip, n] of dnsMap()) names.set(ip, n);
  phase = 'idle';
  console.log(`Фаза 2: спокій, ${IDLE_S} с…`);
  await sleep(IDLE_S * 1000);
  clearInterval(poll);
  console.log('опитувань:', polls);
  for (const [ip, n] of dnsMap()) if (!names.has(ip)) names.set(ip, n);
  spawnSync('taskkill', ['/PID', String(child.pid)], { stdio: 'ignore' });
  await sleep(4000);
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });

  const nameOf = (addr) => names.get(addr.replace(/:\d+$/, '')) || '(ім\'я невідоме)';
  const bad = [];
  for (const ph of ['start', 'idle']) {
    console.log(`\n--- ${ph}`);
    if (!seen[ph].size) console.log('   (з\'єднань немає)');
    for (const [addr, sec] of seen[ph]) {
      const name = nameOf(addr);
      console.log(`  +${String(sec).padStart(3)} с  ${addr.padEnd(24)} ${name}`);
      if (ph === 'idle' || (name !== '(ім\'я невідоме)' && !okHost(name))) bad.push({ ph, addr, name });
    }
  }
  try { fs.rmSync(data, { recursive: true, force: true }); } catch { /* ignore */ }
  if (bad.length) { console.log('\nУВАГА: потребує перевірки:'); for (const b of bad) console.log(`  [${b.ph}] ${b.addr} ${b.name}`); process.exit(1); }
  console.log('\nOK: на старті лише очікувані адреси, у спокої з\'єднань немає.');
})().catch(e => { console.error('ПОМИЛКА:', e.message); process.exit(1); });
