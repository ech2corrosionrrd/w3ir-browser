'use strict';
// Stability and safety tests: PDF worker, crash log, Store/vault recovery, internal-page navigation, external-scheme gesture,
// protocol headers, MCP lockout, agent network guard, sync rollback, threat-list size cap.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { dialog } = require('electron');
const { PDFDocument } = require('pdf-lib');
const { ok, sleep, tmp } = require('../lib');

async function makePdf(file, pages) {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage([300, 300]).drawText('page ' + i + ' lorem ipsum', { x: 20, y: 150, size: 12 });
  fs.writeFileSync(file, await d.save());
}

async function pdfWorkerTests() {
  const tools = require('../../src/pdf-tools');
  const dir = tmp('pdfworker');
  const a = path.join(dir, 'a.pdf'), b = path.join(dir, 'b.pdf'), big = path.join(dir, 'big.pdf');
  await makePdf(a, 3); await makePdf(b, 2); await makePdf(big, 400);
  const saved = { ...tools.WORKER };
  try {
    const r = await tools.runWorker({ op: 'merge', paths: [a, b], strip: false, arg: {} });
    ok(r.outputs.length === 1 && r.outputs[0].pages === 5 && r.outputs[0].bytes.length > 100 && Buffer.from(r.outputs[0].bytes).subarray(0, 5).toString() === '%PDF-', 'worker: merge runs in a worker thread and returns bytes');
    const d = await tools.runWorker({ op: 'describe', paths: [a] });
    ok(d.pages === 3 && d.size > 100, 'worker: describe returns pages and size');
    ok((await tools.runWorker({ op: 'split', paths: [big], arg: { mode: 'every', every: 100 } })).outputs.length === 4, 'worker: split by N pages works');

    // limits are kept inside the worker
    const many = Array.from({ length: tools.MAX_FILES + 1 }, () => a);
    const e1 = await tools.runWorker({ op: 'merge', paths: many, arg: {} }).catch(e => e.code);
    const e2 = await tools.runWorker({ op: 'describe', paths: [path.join(dir, 'x.txt')] }).catch(e => e.code);
    const e3 = await tools.runWorker({ op: 'split', paths: [a], arg: { mode: 'ranges', ranges: '1-9' } }).catch(e => e.code);
    ok(e1 === 'select' && e2 === 'path' && e3 === 'range', 'worker: file-count, path and range checks still apply (' + [e1, e2, e3] + ')');

    // event loop stays responsive while a heavy job runs
    let last = Date.now(), maxGap = 0;
    const tick = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 20);
    const t0 = Date.now();
    await tools.runWorker({ op: 'merge', paths: [big, big, big, big, big, big], arg: {} });
    const took = Date.now() - t0;
    clearInterval(tick);
    ok(maxGap < 400, 'worker: main-process event loop is not blocked by a heavy job (max gap ' + maxGap + ' ms, job ' + took + ' ms)');

    // crash, uncaught error, hang -> clear error codes; the queue keeps working
    const crash = path.join(dir, 'crash.js'), thr = path.join(dir, 'throw.js'), hang = path.join(dir, 'hang.js');
    fs.writeFileSync(crash, "process.exit(3);");
    fs.writeFileSync(thr, "require('worker_threads').parentPort.once('message', () => { setImmediate(() => { throw new Error('boom'); }); });");
    fs.writeFileSync(hang, "require('worker_threads').parentPort.once('message', () => { setInterval(() => {}, 1000); });");
    tools.WORKER.file = crash;
    const c1 = await tools.runWorker({ op: 'describe', paths: [a] }).catch(e => e.code);
    tools.WORKER.file = thr;
    const c2 = await tools.runWorker({ op: 'describe', paths: [a] }).catch(e => e.code);
    tools.WORKER.file = hang; tools.WORKER.timeoutMs = 400;
    const t1 = Date.now();
    const c3 = await tools.runWorker({ op: 'describe', paths: [a] }).catch(e => e.code);
    const hangMs = Date.now() - t1;
    tools.WORKER.file = path.join(dir, 'missing-worker.js');
    const c4 = await tools.runWorker({ op: 'describe', paths: [a] }).catch(e => e.code);
    ok(c1 === 'worker' && c2 === 'worker' && c3 === 'timeout' && hangMs < 3000 && c4 === 'worker', 'worker: crash/exception/hang/missing file give worker|timeout errors, the hung worker is terminated (' + [c1, c2, c3, c4, hangMs] + ')');
    Object.assign(tools.WORKER, saved);
    const again = await tools.runWorker({ op: 'describe', paths: [b] });
    ok(again.pages === 2, 'worker: the queue works normally after failures');
  } finally { Object.assign(tools.WORKER, saved); }
}

function crashLogTests() {
  const { CrashLog, install, redact } = require('../../src/crash-log');
  const { EventEmitter } = require('events');
  const dir = tmp('crashlog');
  const f = path.join(dir, 'crash.log');
  const secret = '0x' + 'ab'.repeat(32);
  const words = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  const red = redact('C:\\Users\\Bob\\AppData failed token=SECRETVALUE Bearer abc.def ' + secret + ' ' + words + ' ' + 'Zz9'.repeat(20));
  ok(!/Bob|SECRETVALUE|abandon|abab|Zz9Zz9/.test(red) && /<home>/.test(red), 'crash-log: home path, tokens, hex keys and seed-like word runs are redacted');
  const log = new CrashLog(f);
  const err = new Error('failed with password=hunter2 key ' + secret); err.stack = err.stack + '\nat C:\\Users\\Bob\\x.js:1';
  log.note('uncaughtException', err, { site: 'https://a.example/?token=abc123' });
  const text = fs.readFileSync(f, 'utf8');
  ok(/uncaughtException/.test(text) && !/hunter2|Bob|abab|abc123/.test(text) && JSON.parse(text.trim().split('\n')[0]).kind === 'uncaughtException', 'crash-log: an entry is written as JSON without secrets');
  let n = 0; for (let i = 0; i < 200; i++) if (log.note('x', new Error('e' + i))) n++;
  ok(n <= 30, 'crash-log: entries are rate-limited per minute (' + n + ')');

  const proc = new EventEmitter();
  const log2 = new CrashLog(path.join(dir, 'c2.log'));
  let flushes = 0, firsts = 0, repeated = 0;
  const off = install(proc, log2, { flush: () => { flushes++; }, onFirst: () => { firsts++; }, onRepeated: () => { repeated++; }, limit: 3 });
  proc.emit('uncaughtException', new Error('one'));
  proc.emit('unhandledRejection', new Error('rej'));
  proc.emit('uncaughtException', new Error('two'));
  ok(flushes === 2 && firsts === 1 && repeated === 0, 'crash-log: uncaughtException flushes data and notifies once');
  proc.emit('uncaughtException', new Error('three'));
  const lines = fs.readFileSync(path.join(dir, 'c2.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l).kind);
  ok(repeated === 1 && lines.includes('unhandledRejection') && lines.filter(k => k === 'uncaughtException').length === 3, 'crash-log: rejections are logged, repeated fatal errors trigger the safe-exit hook');
  off();
  ok(proc.listenerCount('uncaughtException') === 0, 'crash-log: handlers can be removed');
}

async function storeRecoveryTests() {
  const { Store } = require('../../src/store');
  const { Vault } = require('../../src/vault');
  const dir = tmp('storerec');
  const s1 = new Store('t', { n: 0 }, dir);
  s1.data.n = 1; s1.flush();
  s1.data.n = 2; s1.flush();
  ok(fs.existsSync(path.join(dir, 't.json.bak')) && !fs.existsSync(path.join(dir, 't.json.tmp')), 'store: the backup copy exists and no temporary file is left');
  fs.writeFileSync(path.join(dir, 't.json'), '{"n": 2, "tru');
  const s2 = new Store('t', { n: 0 }, dir);
  ok(s2.recovered === 'backup' && s2.data.n === 1 && fs.readdirSync(dir).some(f => f.startsWith('t.json.corrupt-')), 'store: a corrupt file is recovered from .bak and kept as .corrupt-*');
  fs.writeFileSync(path.join(dir, 't.json'), 'garbage'); fs.writeFileSync(path.join(dir, 't.json.bak'), 'garbage');
  const s3 = new Store('t', { n: 7 }, dir);
  ok(s3.recovered === 'defaults' && s3.data.n === 7, 'store: when both files are corrupt the defaults are used and the state is reported');
  s3.data.n = 9; s3.save();
  require('../../src/store').flushAll();
  ok(JSON.parse(fs.readFileSync(path.join(dir, 't.json'), 'utf8')).n === 9, 'store: flushAll writes pending data (safe quit)');

  const vd = tmp('vaultrec');
  const v = new Vault({ dir: vd, autolockMinutes: 15 });
  await v.create('Correct-Horse-9-Battery');
  v.add({ url: 'https://example.com/', username: 'u', password: 'p4ssw0rd!x' });
  v.lock();
  ok(fs.existsSync(path.join(vd, 'vault.bin.bak')), 'vault: backup copy exists after save');
  fs.writeFileSync(path.join(vd, 'vault.bin'), '{"v":1,"kdf":');
  const v2 = new Vault({ dir: vd, autolockMinutes: 15 });
  const r = await v2.unlock('Correct-Horse-9-Battery');
  ok(r.ok && v2.recoveredFromBackup === true && fs.readdirSync(vd).some(f => f.startsWith('vault.bin.corrupt-')), 'vault: a truncated vault.bin is restored from .bak and unlocks');
  const vd2 = tmp('vaultrec2');
  const v3 = new Vault({ dir: vd2, autolockMinutes: 15 });
  await v3.create('Correct-Horse-9-Battery'); v3.lock();
  fs.writeFileSync(path.join(vd2, 'vault.bin'), '{"v":1,"kdf":');
  fs.rmSync(path.join(vd2, 'vault.bin.bak'), { force: true });
  const v4 = new Vault({ dir: vd2, autolockMinutes: 15 });
  const r4 = await v4.unlock('Correct-Horse-9-Battery');
  ok(!r4.ok && !!r4.error, 'vault: without a backup a corrupt file gives an error, not an empty vault');
}

async function navigationTests(ctx) {
  const w = [...ctx.windows].find(x => !x.incognito && !x.agent);
  const od = dialog.showMessageBox;
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<title>t</title><body>hello</body>'); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const tab = w.createTab(url, { activate: false });
  const wc = tab.view.webContents;
  for (let i = 0; i < 40 && wc.isLoading(); i++) await sleep(100);
  await sleep(300);
  const fire = (ev, to) => { let prevented = false; wc.emit(ev, { preventDefault() { prevented = true; } }, to); return prevented; };
  try {
    // web content cannot navigate to internal pages (except error/warning)
    ok(fire('will-navigate', 'w3ir://settings') && fire('will-navigate', 'w3ir://wallet') && fire('will-navigate', 'w3ir://pdftools') && fire('will-redirect', 'w3ir://downloads'), 'nav: web page cannot navigate to w3ir:// internal pages');
    ok(!fire('will-navigate', 'w3ir://error?code=1') && !fire('will-navigate', 'w3ir://warning?x=1') && !fire('will-navigate', 'https://example.com/'), 'nav: error/warning pages and ordinary links stay allowed');
    const before = w.tabs.length;
    await wc.executeJavaScript("window.open('w3ir://settings'); window.open('w3ir://wallet', '_blank', 'popup,width=300,height=300'); 1", true);
    await sleep(800);
    ok(w.tabs.length === before && ![...require('electron').BrowserWindow.getAllWindows()].some(b => /^w3ir:\/\/(settings|wallet)/.test(b.webContents.getURL())), 'nav: window.open to w3ir:// from a web page is denied (tab and popup)');
    // internal page may still open internal pages
    const itab = w.createTab('w3ir://settings', { activate: false });
    await sleep(800);
    let p2 = false; itab.view.webContents.emit('will-navigate', { preventDefault() { p2 = true; } }, 'w3ir://history');
    ok(!p2, 'nav: internal -> internal navigation is allowed');
    w.closeTab(itab.id);

    // external schemes: a user gesture in that tab is required; a declined prompt pauses page-originated prompts
    let asked = 0;
    dialog.showMessageBox = async () => { asked++; return { response: 1 }; };
    w._extCool = 0; w._extAsk = false; tab.lastInput = 0;
    fire('will-navigate', 'vscode://file/x');
    await sleep(100);
    ok(asked === 0, 'external: no prompt without a recent user gesture');
    tab.lastInput = Date.now();
    fire('will-navigate', 'vscode://file/x');
    await sleep(150);
    ok(asked === 1, 'external: a prompt is shown after a user gesture');
    tab.lastInput = Date.now();
    fire('will-navigate', 'vscode://file/y');
    await sleep(150);
    ok(asked === 1, 'external: after a declined prompt the page cannot ask again right away');
    // real input events update the gesture time (Electron input-event)
    tab.lastInput = 0;
    wc.sendInputEvent({ type: 'mouseDown', x: 10, y: 10, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: 10, y: 10, button: 'left', clickCount: 1 });
    await sleep(300);
    ok(tab.lastInput > 0, 'external: real mouse input is recorded as a user gesture');

    // hung page: dialog after the timeout, cleared when the page responds
    let hang = 0;
    dialog.showMessageBox = async () => { hang++; return { response: 0 }; };
    w.hangMs = 200;
    wc.emit('unresponsive'); await sleep(600);
    wc.emit('unresponsive'); wc.emit('responsive'); await sleep(600);
    ok(hang === 1, 'hang: unresponsive page offers wait/reload once; responsive cancels the prompt');
    w.hangMs = 0;

    // renderer crash: the first crash reloads the page, the second one shows the error page (no reload loop)
    dialog.showMessageBox = od;
    tab.crashes = [];
    wc.forcefullyCrashRenderer();
    let ok1 = false;
    for (let i = 0; i < 40 && !ok1; i++) { await sleep(250); ok1 = wc.getURL() === url && !wc.isLoading() && !wc.isCrashed(); }
    ok(ok1, 'crash: the tab reloads automatically after the first renderer crash');
    await sleep(500);
    wc.forcefullyCrashRenderer();
    let ok2 = false;
    for (let i = 0; i < 40 && !ok2; i++) { await sleep(250); ok2 = /^w3ir:\/\/error/.test(wc.getURL()); }
    ok(ok2, 'crash: a second crash within a minute shows the error page instead of reloading again');
  } finally {
    dialog.showMessageBox = od; w.hangMs = 0;
    try { w.closeTab(tab.id); } catch { /* ignore */ }
    srv.close();
  }
}

async function protocolTests(ctx) {
  for (const u of ['w3ir://settings', 'w3ir://pdftools', 'w3ir://ui/overlay.html']) {
    const r = await ctx.session.fetch(u);
    ok(r.status === 200 && /frame-ancestors 'none'/.test(r.headers.get('content-security-policy') || '') && r.headers.get('x-frame-options') === 'DENY' && r.headers.get('x-content-type-options') === 'nosniff', 'protocol: ' + u + ' is served with frame-ancestors none, X-Frame-Options and nosniff');
  }
  const nf = await ctx.session.fetch('w3ir://nope.png');
  ok(nf.status === 404, 'protocol: unknown internal resource stays 404');
}

async function agentTests2(ctx) {
  const { Agent } = require('../../src/agent');
  const agent = new Agent({ ctx, dir: tmp('agentguard'), port: 45871, allowLocal: false });
  agent.regenerate();
  const mk = (auth) => ({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:' + agent.state.port, authorization: auth }, url: '/mcp', method: 'GET', on() {} });
  const go = (auth) => { const res = { code: 0, writeHead(c) { this.code = c; }, end() {} }; agent.handle(mk(auth), res); return res.code; };
  const codes = [];
  for (let i = 0; i < 10; i++) codes.push(go('Bearer wrong' + i));
  ok(codes.slice(0, 8).every(c => c === 401) && codes[8] === 429 && codes[9] === 429, 'mcp: invalid tokens are throttled after 8 failures');
  ok(go('Bearer ' + agent.token) === 405, 'mcp: a valid token is not locked out by failed attempts of someone else');

  // network guard for agent-controlled pages
  const ses = (list, fail) => ({ resolveHost: async () => { if (fail) throw new Error('x'); return { endpoints: list.map(address => ({ address, family: 'ipv4' })) }; } });
  ok(await agent.netGuard(ses(['127.0.0.1']), 'https://rebind.example/') === true && await agent.netGuard(ses(['93.184.216.34', '10.0.0.5']), 'https://rebind.example/') === true && await agent.netGuard(ses(['169.254.169.254']), 'https://rebind.example/') === true, 'agent-net: a host resolving to a private address is blocked at the network layer');
  ok(await agent.netGuard(ses(['93.184.216.34']), 'https://example.com/') === false && await agent.netGuard(ses([], true), 'https://example.com/') === false && await agent.netGuard(ses(['127.0.0.1']), 'https://127.0.0.1/') === false, 'agent-net: public hosts, resolver errors and IP literals (checked elsewhere) are not blocked here');
  agent.shares.set('t', { id: 't', tab: { view: { webContents: { id: 4242 } } } });
  ok(agent.guardsContents(4242) === true && agent.guardsContents(1) === false && agent.guardsContents(0) === false, 'agent-net: only agent-controlled pages are guarded');
  ok(agent.lateIpCheck({ ip: '127.0.0.1', url: 'https://x.example/', webContentsId: 999999 }) === true && agent.lateIpCheck({ ip: '93.184.216.34', url: 'https://x.example/', webContentsId: 1 }) === false, 'agent-net: the real peer address is checked after connect');
  const local = new Agent({ ctx, dir: tmp('agentguard2'), port: 45872, allowLocal: true });
  local.shares.set('t', { id: 't', tab: { view: { webContents: { id: 4242 } } } });
  ok(local.guardsContents(4242) === false, 'agent-net: test mode with allowLocal disables the guard');
}

async function syncRollbackTests() {
  const crypto = require('crypto');
  const { Sync, FILE_NAME } = require('../../src/sync');
  const cu = require('../../src/crypto-util');
  const folder = tmp('syncrb');
  const mk = (n) => { let items = []; const s = new Sync({ dir: tmp('rb' + n), bookmarks: { get: () => items, set: (a) => { items = a; } } }); return { s, set items(v) { items = v; }, get items() { return items; } }; };
  const now = Date.now();
  const A = mk('A');
  A.items = [{ url: 'https://a.example.com/', title: 'A', added: now - 5000, mod: now - 5000 }];
  await A.s.enable(folder, 'sync-passphrase-ABC123');
  const file = path.join(folder, FILE_NAME);
  const j1 = JSON.parse(fs.readFileSync(file, 'utf8'));
  const snap = fs.readFileSync(file);
  ok(j1.seq === 1, 'sync: the first write carries counter 1');
  A.items = [...A.items, { url: 'https://b.example.com/', title: 'B', added: now - 4000, mod: now - 4000 }];
  await A.s.syncNow();
  const j2 = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(j2.seq === 2 && A.s.state.data.seq === 2, 'sync: every write increases the counter');
  const tampered = { ...j2, seq: 1 };
  fs.writeFileSync(file, JSON.stringify(tampered));
  await A.s.syncNow();
  ok(/розшифр|decrypt|\S/.test(A.s.state.data.lastError) && A.s.state.data.lastError !== '' && A.items.length === 2, 'sync: a modified counter breaks authentication (counter is bound to the ciphertext)');
  fs.writeFileSync(file, snap);
  await A.s.syncNow();
  ok(A.s.state.data.lastError !== '' && /відкат/.test(A.s.state.data.lastError) && A.items.length === 2, 'sync: an older file (rollback) is rejected and local data is untouched');
  fs.writeFileSync(file, JSON.stringify(j2));
  await A.s.syncNow();
  ok(A.s.state.data.lastError === '', 'sync: the current file is accepted again');

  // legacy file (no counter, old AAD) is still readable and is upgraded on the next write
  const f2 = tmp('synclegacy');
  const salt = crypto.randomBytes(16);
  const key = await cu.deriveKey(cu.norm('sync-passphrase-ABC123'), salt, cu.KDF_DEFAULT);
  const env = cu.encrypt(key, Buffer.from(JSON.stringify({ v: 1, items: [{ url: 'https://old.example.com/', title: 'old', added: 1, mod: 1 }], tomb: {}, time: 1 })), Buffer.from('W3IRSYNC1'));
  fs.writeFileSync(path.join(f2, FILE_NAME), JSON.stringify({ magic: 'W3IRSYNC1', salt: cu.b64(salt), iv: cu.b64(env.iv), tag: cu.b64(env.tag), ct: cu.b64(env.ct) }));
  const C = mk('C');
  await C.s.enable(f2, 'sync-passphrase-ABC123');
  ok(C.items.length === 1 && C.items[0].url === 'https://old.example.com/', 'sync: a legacy file without counter is read');
  C.items = [...C.items, { url: 'https://new.example.com/', title: 'n', added: Date.now(), mod: Date.now() }];
  await C.s.syncNow();
  ok(JSON.parse(fs.readFileSync(path.join(f2, FILE_NAME), 'utf8')).seq === 1 && C.s.state.data.lastError === '', 'sync: the legacy file is upgraded to counter 1 on the next write');
}

async function threatCapTests() {
  const { Threats } = require('../../src/threats');
  const dir = tmp('threatcap');
  let served = 0;
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/plain');
    res.write('0.0.0.0 a.example\n');
    const iv = setInterval(() => { served += 65536; if (!res.write(Buffer.alloc(65536, 0x61))) { /* backpressure */ } if (served > 80 * 1024 * 1024) { clearInterval(iv); res.end(); } }, 1);
    req.on('close', () => clearInterval(iv));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  let t;
  try {
    t = new Threats({ dir, sources: [{ id: 'big', kind: 'malware', title: 'big', url: `http://127.0.0.1:${srv.address().port}/` }], allowInsecure: true });
  } catch (e) { ok(false, 'threats: cannot construct for the size-cap test: ' + e.message); srv.close(); return; }
  await t.update();
  ok(/./.test(t.meta.error || '') && served < 78 * 1024 * 1024, 'threats: a list without Content-Length is cut off at the size limit (' + Math.round(served / 1048576) + ' MB read)');
  srv.close();
}

async function stabilityTests(ctx) {
  await pdfWorkerTests();
  crashLogTests();
  await storeRecoveryTests();
  await navigationTests(ctx);
  await protocolTests(ctx);
  await agentTests2(ctx);
  await syncRollbackTests();
  await threatCapTests();
}

module.exports = { stabilityTests };