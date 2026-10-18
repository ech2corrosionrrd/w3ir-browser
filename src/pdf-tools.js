'use strict';
// Інструменти PDF (внутрішня сторінка w3ir://pdftools): злиття, розділення, витяг/видалення/переставляння сторінок,
// поворот, видалення метаданих і накладання зображення-підпису. Усе робиться ЛОКАЛЬНО в головному процесі бібліотекою
// pdf-lib (чистий JS, без виконання коду з PDF). Сторінка не передає шляхів: файли обирає діалог головного процесу,
// а сторінка оперує лише випадковими id. Вхідні файли перевіряються (розмір, кількість, підпис %PDF-, шлях, ім'я).
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { PDFDocument, PDFName, PDFArray, PDFDict, degrees } = require('pdf-lib');
const pdf = require('./pdf');
const { isWebUrl } = require('./util');

const MAX_FILE = 200 * 1024 * 1024; // один вхідний PDF
const MAX_TOTAL = 400 * 1024 * 1024; // сума вхідних файлів однієї операції
const MAX_FILES = 20; // файлів у списку
const MAX_PAGES = 5000; // сторінок у вхідному файлі й у результаті
const MAX_PARTS = 200; // частин при розділенні
const MAX_IMAGE = 5 * 1024 * 1024; // зображення підпису
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;
const POSITIONS = new Set(['br', 'bc', 'bl', 'tr', 'tc', 'tl', 'c']);

const fail = (code) => Object.assign(new Error(code), { code });

// Діалоги й показ у папці — через цей об'єкт, щоб тести могли їх підмінити
const ui = {
  open: (win, opts) => require('electron').dialog.showOpenDialog(win, opts),
  save: (win, opts) => require('electron').dialog.showSaveDialog(win, opts),
  show: (file) => require('electron').shell.showItemInFolder(file),
};

// ---------- вхідні файли ----------
function checkInputPath(file, exts) {
  const f = typeof file === 'string' ? file : '';
  if (!f || f.includes('\0') || !path.isAbsolute(f) || !exts.test(f) || RESERVED.test(path.basename(f))) throw fail('path');
  return f;
}

// Читає PDF: розширення .pdf, звичайний файл, розмір, сигнатура %PDF-
function readPdf(file) {
  const f = checkInputPath(file, /\.pdf$/i);
  let st;
  try { st = fs.statSync(f); } catch { throw fail('read'); }
  if (!st.isFile()) throw fail('path');
  if (st.size > MAX_FILE) throw fail('big');
  if (st.size < 16 || !pdf.looksLikePdf(f)) throw fail('signature');
  try { return fs.readFileSync(f); } catch { throw fail('read'); }
}

async function loadDoc(bytes) {
  let doc;
  try { doc = await PDFDocument.load(bytes, { updateMetadata: false }); } catch (e) {
    throw fail(/encrypt/i.test(String((e && (e.name + ' ' + e.message)) || '')) ? 'encrypted' : 'broken');
  }
  let n;
  try { n = doc.getPageCount(); } catch { throw fail('broken'); }
  if (n > MAX_PAGES) throw fail('pages');
  if (n < 1) throw fail('broken');
  return doc;
}

// Зображення підпису: .png/.jpg/.jpeg, розмір, сигнатура
function readImage(file) {
  const f = checkInputPath(file, /\.(png|jpe?g)$/i);
  let st;
  try { st = fs.statSync(f); } catch { throw fail('read'); }
  if (!st.isFile()) throw fail('path');
  if (st.size > MAX_IMAGE || st.size < 16) throw fail('image');
  let bytes;
  try { bytes = fs.readFileSync(f); } catch { throw fail('read'); }
  const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!png && !jpg) throw fail('image');
  return { bytes, kind: png ? 'png' : 'jpg' };
}

// ---------- діапазони ----------
// «1-3, 5, 8-» → індекси з нуля у вказаному порядку; '' → []; некоректне або поза межами → null.
// allowDesc: дозволяє «5-1» (зворотний порядок) і дублікати — для переставляння.
function parseSelection(spec, total, { allowDesc = false } = {}) {
  const s = String(spec == null ? '' : spec).replace(/\s+/g, '');
  if (!s) return [];
  if (s.length > 200 || !/^\d{1,5}(-\d{0,5})?(,\d{1,5}(-\d{0,5})?)*$/.test(s)) return null;
  const out = [];
  for (const part of s.split(',')) {
    const [as, bs] = part.split('-');
    const a = Number(as);
    const b = bs === undefined ? a : bs === '' ? total : Number(bs);
    if (!(a >= 1) || !(b >= 1) || a > total || b > total) return null;
    if (b < a) {
      if (!allowDesc) return null;
      for (let i = a; i >= b; i--) out.push(i - 1);
    } else for (let i = a; i <= b; i++) out.push(i - 1);
    if (out.length > MAX_PAGES) return null;
  }
  return out;
}

// «1-3, 5, 8-» → [[0,1,2],[4],[7..]] — кожна частина стане окремим файлом
function splitParts(spec, total) {
  const s = String(spec == null ? '' : spec).replace(/\s+/g, '');
  if (!s) return null;
  const parts = [];
  for (const p of s.split(',')) {
    const r = parseSelection(p, total);
    if (!r || !r.length) return null;
    parts.push(r);
  }
  return parts.length && parts.length <= MAX_PARTS ? parts : null;
}

function chunkEvery(n, total) {
  const k = Math.floor(Number(n));
  if (!(k >= 1) || k > total) return null;
  const parts = [];
  for (let i = 0; i < total; i += k) parts.push(Array.from({ length: Math.min(k, total - i) }, (_, j) => i + j));
  return parts.length <= MAX_PARTS ? parts : null;
}

// ---------- обробка ----------
const DANGEROUS_ACTIONS = new Set(['/JavaScript', '/Launch', '/ImportData', '/SubmitForm']);

// У результаті не лишається дій, які можуть виконати код або запустити файл (JavaScript, Launch, SubmitForm, ImportData)
// ні додаткових дій сторінок і анотацій (/AA). Звичайні посилання (URI, GoTo) зберігаються. Повертає кількість прибраного.
function stripActions(doc) {
  let n = 0;
  const AA = PDFName.of('AA'), A = PDFName.of('A'), S = PDFName.of('S');
  for (const page of doc.getPages()) {
    if (page.node.has(AA)) { page.node.delete(AA); n++; }
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const a = annots.lookupMaybe(i, PDFDict);
      if (!a) continue;
      if (a.has(AA)) { a.delete(AA); n++; }
      const act = a.lookupMaybe(A, PDFDict);
      const type = act && act.lookupMaybe(S, PDFName);
      if (act && (!type || DANGEROUS_ACTIONS.has(type.asString()))) { a.delete(A); n++; }
    }
  }
  return n;
}

function placeSignature(page, img, pos, widthPct) {
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const { x: ox, y: oy, width: w, height: h } = page.getMediaBox();
  const sideways = rot % 180 !== 0;
  const vw = sideways ? h : w, vh = sideways ? w : h;
  let iw = vw * Math.min(80, Math.max(5, widthPct)) / 100;
  let ih = iw * img.height / img.width;
  if (ih > vh * 0.9) { iw *= (vh * 0.9) / ih; ih = vh * 0.9; }
  const m = Math.min(vw, vh) * 0.04;
  const vx = pos.endsWith('l') ? m : pos === 'c' || pos === 'bc' || pos === 'tc' ? (vw - iw) / 2 : vw - iw - m;
  const vy = pos.startsWith('b') ? m : pos === 'c' ? (vh - ih) / 2 : vh - ih - m;
  // видимі координати → координати незверненої сторінки (з урахуванням /Rotate)
  const map = { 0: [vx, vy, 0], 90: [w - vy, vx, 90], 180: [w - vx, h - vy, 180], 270: [vy, h - vx, 270] }[rot];
  page.drawImage(img, { x: ox + map[0], y: oy + map[1], width: iw, height: ih, rotate: degrees(map[2]) });
}

// Збирає новий PDF. sources: [{ doc, indices }] (індекси з нуля, порядок збережено). Нічого з вилучених сторінок не лишається
// у файлі (створюється новий документ, а не редагується старий).
// opts: { strip, rotate: { set:Set(позиції в результаті), angle }, sig: { bytes, kind, page, pos, width } }
async function build(sources, opts = {}) {
  const out = await PDFDocument.create({ updateMetadata: false });
  for (const s of sources) {
    const pages = await out.copyPages(s.doc, s.indices);
    for (const p of pages) out.addPage(p);
  }
  if (out.getPageCount() < 1) throw fail('empty');
  if (out.getPageCount() > MAX_PAGES) throw fail('pages');
  const removed = stripActions(out);
  const outPages = out.getPages();
  const rot = opts.rotate;
  if (rot && rot.angle) {
    for (const i of rot.set) {
      const p = outPages[i];
      if (p) p.setRotation(degrees((p.getRotation().angle + rot.angle) % 360));
    }
  }
  if (opts.sig) {
    const page = outPages[opts.sig.page];
    if (!page) throw fail('range');
    let img;
    try { img = opts.sig.kind === 'png' ? await out.embedPng(opts.sig.bytes) : await out.embedJpg(opts.sig.bytes); } catch { throw fail('image'); }
    placeSignature(page, img, opts.sig.pos, opts.sig.width);
  }
  if (opts.strip) {
    const M = PDFName.of('Metadata'), P = PDFName.of('PieceInfo');
    for (const p of outPages) { p.node.delete(M); p.node.delete(P); }
  } else {
    const first = sources[0].doc;
    const get = (f) => { try { return first[f](); } catch { return undefined; } };
    const title = get('getTitle'), author = get('getAuthor'), subject = get('getSubject'), kw = get('getKeywords'), creator = get('getCreator');
    if (title) out.setTitle(title);
    if (author) out.setAuthor(author);
    if (subject) out.setSubject(subject);
    if (kw) out.setKeywords([kw]);
    if (creator) out.setCreator(creator);
    out.setProducer('W3IR Browser');
    out.setCreationDate(new Date());
    out.setModificationDate(new Date());
  }
  const bytes = await out.save({ useObjectStreams: true });
  return { bytes, pages: outPages.length, removedActions: removed };
}

// ---------- запис результату ----------
const sameFile = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function writeOut(file, bytes, inputs) {
  const f = pdf.safePdfPath(file);
  if (!f) throw fail('path');
  if (inputs.some(i => sameFile(i, f))) throw fail('same');
  const tmp = f + '.w3ir-tmp';
  try { fs.writeFileSync(tmp, bytes); fs.renameSync(tmp, f); } catch { try { fs.unlinkSync(tmp); } catch { /* ignore */ } throw fail('write'); }
  return f;
}

function uniquePath(dir, base) {
  for (let i = 0; i < 1000; i++) {
    const f = path.join(dir, i ? `${base}-${i}.pdf` : `${base}.pdf`);
    if (!fs.existsSync(f)) return f;
  }
  throw fail('write');
}

const baseOf = (file) => path.basename(file).replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 60) || 'document';

// ---------- стан вікна й API сторінки ----------
const STATES = new WeakMap();
function stateFor(win) {
  let s = STATES.get(win);
  if (!s) { s = { docs: new Map(), sig: null, last: '' }; STATES.set(win, s); }
  return s;
}

async function describeLocal(file) {
  const bytes = readPdf(file);
  const doc = await loadDoc(bytes);
  return { path: file, name: path.basename(file).slice(0, 120), size: bytes.length, pages: doc.getPageCount() };
}

const describe = (file) => runWorker({ op: 'describe', paths: [file] });

const view = (st) => [...st.docs].map(([id, d]) => ({ id, name: d.name, size: d.size, pages: d.pages }));

function source(win) {
  const tab = win.pdfFrom;
  if (!tab || !win.tabs.includes(tab)) return null;
  try {
    const wc = tab.view.webContents;
    const url = wc.getURL();
    if (wc.isDestroyed() || !isWebUrl(url)) return null;
    return { title: String(wc.getTitle() || '').slice(0, 120), host: new URL(url).host };
  } catch { return null; }
}

// ---------- heavy part: runs in a worker thread (no electron, no UI) ----------
// job: { op, paths, strip, arg, sigPath }. Returns { outputs:[{bytes,pages,removedActions}], name } (name only for single output).
async function execute(job) {
  const op = job.op;
  const arg = job.arg || {};
  const strip = job.strip === true;
  const docs = [];
  for (const p of job.paths) docs.push(await loadDoc(readPdf(p)));
  const first = job.paths[0];
  if (op === 'split') {
    const total = docs[0].getPageCount();
    const parts = arg.mode === 'every' ? chunkEvery(arg.every, total) : splitParts(arg.ranges, total);
    if (!parts) throw fail('range');
    const outputs = [];
    for (const part of parts) outputs.push(await build([{ doc: docs[0], indices: part }], { strip }));
    return { outputs, base: baseOf(first) };
  }
  let sources, opts = { strip }, name;
  if (op === 'merge') {
    sources = docs.map(d => ({ doc: d, indices: Array.from({ length: d.getPageCount() }, (_, i) => i) }));
    name = 'merged.pdf';
  } else {
    const d = docs[0], total = d.getPageCount();
    const sel = parseSelection(arg.pages, total, { allowDesc: true });
    const rem = parseSelection(arg.remove, total);
    if (!sel || !rem) throw fail('range');
    const drop = new Set(rem);
    const result = (sel.length ? sel : Array.from({ length: total }, (_, i) => i)).filter(i => !drop.has(i));
    if (!result.length) throw fail('empty');
    sources = [{ doc: d, indices: result }];
    const angle = Number(arg.angle) || 0;
    if (angle) {
      if (![90, 180, 270].includes(angle)) throw fail('angle');
      const rp = parseSelection(arg.rotatePages, result.length);
      if (!rp) throw fail('range');
      opts.rotate = { angle, set: new Set(rp.length ? rp : result.map((_, i) => i)) };
    }
    if (arg.sig && job.sigPath) {
      const page = Number(arg.sig.page) - 1;
      const width = Number(arg.sig.width);
      if (!(page >= 0 && page < result.length) || !POSITIONS.has(arg.sig.pos) || !(width >= 5 && width <= 80)) throw fail('range');
      opts.sig = { ...readImage(job.sigPath), page, pos: arg.sig.pos, width };
    }
    name = baseOf(first) + '-edited.pdf';
  }
  return { outputs: [await build(sources, opts)], name };
}

// ---------- worker pool: one short-lived worker per job, serialized, with timeout ----------
const WORKER = { file: path.join(__dirname, 'pdf-worker.js'), timeoutMs: 120000, heapMb: 3072 };
let queue = Promise.resolve();

function runWorker(job) {
  const p = queue.then(() => new Promise((resolve, reject) => {
    const { Worker } = require('worker_threads');
    let w, done = false, timer = null;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { w && w.terminate().catch(() => {}); } catch { /* ignore */ }
      fn(v);
    };
    try {
      w = new Worker(WORKER.file, { workerData: null, resourceLimits: { maxOldGenerationSizeMb: WORKER.heapMb } });
    } catch { return reject(fail('worker')); }
    timer = setTimeout(() => finish(reject, fail('timeout')), WORKER.timeoutMs);
    w.once('message', (m) => {
      if (m && m.ok) finish(resolve, m.result);
      else finish(reject, fail(m && typeof m.code === 'string' ? m.code : 'fail'));
    });
    w.once('error', (e) => finish(reject, fail(e && e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'memory' : 'worker')));
    w.once('exit', () => finish(reject, fail('worker')));
    try { w.postMessage(job); } catch { finish(reject, fail('worker')); }
  }));
  queue = p.catch(() => {});
  return p;
}

async function run(win, st, arg) {
  const op = ['merge', 'edit', 'split'].includes(arg.op) ? arg.op : '';
  const ids = Array.isArray(arg.ids) ? arg.ids.slice(0, MAX_FILES).map(String) : [];
  const recs = ids.map(id => st.docs.get(id));
  if (!op || !recs.length || recs.some(r => !r) || new Set(ids).size !== ids.length) throw fail('select');
  if (op === 'merge' ? recs.length < 2 : recs.length !== 1) throw fail('select');
  if (recs.reduce((n, r) => n + r.size, 0) > MAX_TOTAL) throw fail('total');
  const inputs = recs.map(r => r.path);
  const dir = path.dirname(inputs[0]);
  const parent = win.win;
  const a = arg.sig && typeof arg.sig === 'object' ? { page: arg.sig.page, pos: arg.sig.pos, width: arg.sig.width } : null;
  const job = {
    op, paths: inputs, strip: arg.strip === true, sigPath: a && st.sig ? st.sig.path : '',
    arg: { mode: arg.mode, every: arg.every, ranges: String(arg.ranges == null ? '' : arg.ranges).slice(0, 300), pages: String(arg.pages == null ? '' : arg.pages).slice(0, 300), remove: String(arg.remove == null ? '' : arg.remove).slice(0, 300), angle: arg.angle, rotatePages: String(arg.rotatePages == null ? '' : arg.rotatePages).slice(0, 300), sig: a },
  };
  const res = await runWorker(job);
  const outs = res.outputs;
  if (op === 'split') {
    const r = await ui.open(parent, { title: require('./i18n').t('Папка для частин PDF'), defaultPath: dir, properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) throw fail('canceled');
    const outDir = r.filePaths[0];
    if (!path.isAbsolute(outDir)) throw fail('path');
    const files = [];
    let pages = 0, bytes = 0, removedActions = 0;
    for (let i = 0; i < outs.length; i++) {
      const f = uniquePath(outDir, res.base + '-' + (i + 1));
      writeOut(f, outs[i].bytes, inputs);
      files.push(path.basename(f)); pages += outs[i].pages; bytes += outs[i].bytes.length; removedActions += outs[i].removedActions;
    }
    st.last = path.join(outDir, files[0]);
    return { ok: true, files, pages, bytes, removedActions };
  }
  const b = outs[0];
  const r = await ui.save(parent, { title: require('./i18n').t('Зберегти PDF'), defaultPath: path.join(dir, res.name), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (r.canceled || !r.filePath) throw fail('canceled');
  const f = writeOut(r.filePath, b.bytes, inputs);
  st.last = f;
  return { ok: true, files: [path.basename(f)], pages: b.pages, bytes: b.bytes.length, removedActions: b.removedActions };
}

async function api(ctx, entry, name, arg) {
  const win = entry.win;
  const st = stateFor(win);
  arg = arg || {};
  const t = require('./i18n').t;
  try {
    switch (name) {
      case 'pdf:state': return { ok: true, docs: view(st), sig: st.sig ? st.sig.name : '', source: source(win), limits: { files: MAX_FILES, fileMb: MAX_FILE / 1048576, totalMb: MAX_TOTAL / 1048576, pages: MAX_PAGES } };
      case 'pdf:add': {
        const r = await ui.open(win.win, { title: t('Виберіть PDF-файли'), properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF', extensions: ['pdf'] }] });
        const rejected = [];
        if (!r.canceled) {
          for (const f of (r.filePaths || []).slice(0, MAX_FILES)) {
            if (st.docs.size >= MAX_FILES) { rejected.push({ name: path.basename(String(f)).slice(0, 120), error: 'files' }); continue; }
            try { st.docs.set(randomUUID(), await describe(f)); } catch (e) { rejected.push({ name: path.basename(String(f)).slice(0, 120), error: e.code || 'broken' }); }
          }
        }
        return { ok: true, docs: view(st), rejected };
      }
      case 'pdf:remove': st.docs.delete(String(arg.id)); return { ok: true, docs: view(st) };
      case 'pdf:clear': st.docs.clear(); st.sig = null; return { ok: true, docs: view(st) };
      case 'pdf:move': {
        const arr = [...st.docs];
        const i = arr.findIndex(([id]) => id === String(arg.id));
        const j = i + (arg.dir === 'up' ? -1 : 1);
        if (i >= 0 && j >= 0 && j < arr.length) { [arr[i], arr[j]] = [arr[j], arr[i]]; st.docs = new Map(arr); }
        return { ok: true, docs: view(st) };
      }
      case 'pdf:sig': {
        const r = await ui.open(win.win, { title: t('Виберіть зображення підпису'), properties: ['openFile'], filters: [{ name: t('Зображення'), extensions: ['png', 'jpg', 'jpeg'] }] });
        if (r.canceled || !r.filePaths[0]) return { ok: true, sig: st.sig ? st.sig.name : '' };
        readImage(r.filePaths[0]);
        st.sig = { path: r.filePaths[0], name: path.basename(r.filePaths[0]).slice(0, 120) };
        return { ok: true, sig: st.sig.name };
      }
      case 'pdf:sigClear': st.sig = null; return { ok: true, sig: '' };
      case 'pdf:run': return await run(win, st, arg);
      case 'pdf:show': if (st.last && fs.existsSync(st.last)) ui.show(st.last); return { ok: true };
      case 'pdf:savePage': {
        const src = source(win);
        if (!src) return { ok: false, error: 'tab' };
        const r = await pdf.savePageAsPdf(win, win.pdfFrom.view.webContents, { pageRanges: arg.ranges });
        return r.ok ? { ok: true, files: [path.basename(r.file)], bytes: r.bytes } : { ok: false, error: r.error };
      }
      default: throw new Error('unknown');
    }
  } catch (e) { return { ok: false, error: e && e.code ? e.code : 'fail' }; }
}

module.exports = { WORKER, runWorker, execute, describeLocal, api, ui, readPdf, readImage, loadDoc, parseSelection, splitParts, chunkEvery, stripActions, build, stateFor, MAX_FILE, MAX_TOTAL, MAX_FILES, MAX_PAGES, MAX_IMAGE };