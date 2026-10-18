'use strict';
const fs = require('fs');
const path = require('path');
const { BrowserWindow, shell, dialog } = require('electron');
const { ok, sleep, tmp } = require('../lib');

async function pdfTests(ctx) {
  const pdf = require('../../src/pdf');
  const { Downloads } = require('../../src/downloads');
  const dir = tmp('pdf');

  // чисті функції: діапазони сторінок, шляхи, імена
  ok(pdf.parsePageRanges('') === '' && pdf.parsePageRanges(' 1-3, 5 ,8- ') === '1-3,5,8-' && pdf.parsePageRanges('2') === '2', 'pdf: діапазони сторінок — коректні розбираються, порожній = усі сторінки');
  ok(['0', '3-1', 'a', '1;2', '1,,2', '-5', '1-2-3', '1'.repeat(200), '99999999', '1,2,'].every(s => pdf.parsePageRanges(s) === null), 'pdf: некоректні діапазони відхиляються');
  fs.mkdirSync(path.join(dir, 'd.pdf'));
  ok(pdf.safePdfPath('relative.pdf') === null && pdf.safePdfPath('') === null && pdf.safePdfPath(path.join(dir, 'NUL.pdf')) === null && pdf.safePdfPath(path.join(dir, 'd.pdf')) === null, 'pdf: шлях збереження — лише абсолютний, не службове ім’я і не каталог');
  ok(pdf.safePdfPath(path.join(dir, 'a')) === path.join(dir, 'a.pdf') && pdf.safePdfPath(path.join(dir, 'b.PDF')) === path.join(dir, 'b.PDF'), 'pdf: до шляху без розширення додається .pdf');
  ok(pdf.defaultName('A/B:C*?') === 'A B C.pdf' && pdf.defaultName('') === 'page.pdf' && pdf.defaultName('x'.repeat(300)).length === 84, 'pdf: ім’я за замовчуванням очищується від заборонених символів');
  ok(pdf.isPdfName('a.PDF') && !pdf.isPdfName('a.pdf.exe') && !pdf.isPdfName('pdf') && !Downloads.isRisky('a.pdf'), 'pdf: .pdf не входить до ризикованих розширень');

  // збереження сторінки в PDF (справжній printToPDF) + підтримка діапазону
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    const pages = Array.from({ length: 3 }, (_, i) => `<div style="page-break-after:always">Сторінка ${i + 1}</div>`).join('');
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><title>Тест</title>' + pages));
    const f1 = path.join(dir, 'all.pdf'), f2 = path.join(dir, 'one');
    const r1 = await pdf.savePageAsPdf(null, win.webContents, { file: f1 });
    const r2 = await pdf.savePageAsPdf(null, win.webContents, { file: f2, pageRanges: '1' });
    const count = (f) => (fs.readFileSync(f, 'latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    ok(r1.ok && fs.existsSync(f1) && fs.readFileSync(f1).subarray(0, 5).toString() === '%PDF-' && pdf.looksLikePdf(f1), 'pdf: сторінку збережено в справжній PDF (printToPDF)');
    ok(r2.ok && r2.file === f2 + '.pdf' && count(f2 + '.pdf') === 1 && count(f1) >= 3, 'pdf: діапазон сторінок обмежує вміст (1 із 3)');
    const bad = await pdf.savePageAsPdf(null, win.webContents, { file: f1, pageRanges: '3-1' });
    const badPath = await pdf.savePageAsPdf(null, win.webContents, { file: 'rel.pdf' });
    ok(!bad.ok && bad.error === 'ranges' && !badPath.ok && badPath.error === 'path', 'pdf: некоректний діапазон або шлях — збереження відхилено');

    // «відкриття в браузері»: справжній PDF → file:-URL; перейменований HTML і неіснуючий файл → null
    const fake = path.join(dir, 'fake.pdf');
    fs.writeFileSync(fake, '<html><script>1</script></html>');
    ok(/^file:\/\/\/.+all\.pdf$/.test(pdf.pdfFileUrl(f1) || '') && pdf.pdfFileUrl(fake) === null && pdf.pdfFileUrl(path.join(dir, 'none.pdf')) === null && pdf.pdfFileUrl('x.pdf') === null && pdf.pdfFileUrl(path.join(dir, 'x.txt')) === null, 'pdf: у вкладці відкривається лише справжній PDF (сигнатура %PDF-), не перейменований HTML');

    // завантаження → «відкрити»: PDF іде у нову вкладку, зовнішня програма не запускається
    const w = [...ctx.windows].find(x => !x.incognito && !x.agent);
    const od = dialog.showMessageBox, op = shell.openPath;
    let external = 0, asked = 0;
    shell.openPath = async () => { external++; return ''; };
    dialog.showMessageBox = async () => { asked++; return { response: 1 }; };
    const before = w.tabs.length;
    try {
      ctx.downloads.store.data.push({ id: 'pdf-ok', filename: 'all.pdf', path: f1, state: 'completed', received: 1, total: 1, start: Date.now() });
      ctx.downloads.store.data.push({ id: 'pdf-fake', filename: 'fake.pdf', path: fake, state: 'completed', received: 1, total: 1, start: Date.now() });
      ctx.downloads.action('pdf-ok', 'open', w); await sleep(300);
      const tab = w.tabs[w.tabs.length - 1];
      ok(w.tabs.length === before + 1 && external === 0 && asked === 0 && /all\.pdf$/.test(tab.view.webContents.getURL()), 'pdf: «відкрити» PDF із завантажень — у новій вкладці, без запитань і зовнішньої програми');
      // вбудований переглядач Chromium справді підхоплює PDF (кадр розширення), а не віддає порожню сторінку
      let viewer = false;
      for (let i = 0; i < 40 && !viewer; i++) {
        await sleep(250);
        try { viewer = tab.view.webContents.mainFrame.framesInSubtree.some(f => /^chrome-extension:\/\//.test(f.url)); } catch { /* ignore */ }
      }
      ok(viewer, 'pdf: вбудований переглядач Chromium увімкнено — PDF відображається в кадрі розширення (пошук, мініатюри, масштаб, поворот, друк)');
      ctx.downloads.action('pdf-fake', 'open', w); await sleep(300);
      ok(w.tabs.length === before + 1 && external === 1, 'pdf: підроблений .pdf не відкривається у вкладці, а йде звичайним шляхом');
      w.closeTab(tab.id);
    } finally {
      dialog.showMessageBox = od; shell.openPath = op;
      ctx.downloads.store.data = ctx.downloads.store.data.filter(d => !String(d.id).startsWith('pdf-'));
    }
  } finally { try { win.destroy(); } catch { /* ignore */ } }

  // безпекові налаштування вкладок не послаблено
  const root = path.join(__dirname, '..', '..');
  const aw = fs.readFileSync(path.join(root, 'src', 'app-window.js'), 'utf8');
  ok(!/plugins\s*:\s*false/.test(aw) && /sandbox: true, contextIsolation: true, nodeIntegration: false/.test(aw), 'pdf: вкладки лишаються в пісочниці, вбудований переглядач не вимкнено');
  await pdfToolsTests(ctx);
}

// ---------- інструменти PDF (w3ir://pdftools): pdf-lib у головному процесі ----------
async function pdfToolsTests(ctx) {
  const { PDFDocument, PDFName, PDFString, PDFDict, PDFArray } = require('pdf-lib');
  const tools = require('../../src/pdf-tools');
  const { permitted } = require('../../src/ipc');
  const dir = tmp('pdftools');
  const P = (n) => path.join(dir, n);

  // діапазони
  const sel = tools.parseSelection;
  ok(JSON.stringify(sel('1-3, 5', 9)) === '[0,1,2,4]' && JSON.stringify(sel('8-', 9)) === '[7,8]' && JSON.stringify(sel('', 9)) === '[]' && JSON.stringify(sel('3,1-2', 9, { allowDesc: true })) === '[2,0,1]' && JSON.stringify(sel('3-1', 9, { allowDesc: true })) === '[2,1,0]', 'pdf-tools: діапазони — списки, відкриті кінці, зворотний порядок лише за дозволу');
  ok(['0', '10', '3-1', 'a', '1;2', '1,,2', '-2', '1-2-3', '1'.repeat(300), '99999'].every(s => sel(s, 9) === null), 'pdf-tools: некоректні діапазони й вихід за межі відхиляються');
  ok(JSON.stringify(tools.splitParts('1-2, 5', 6)) === '[[0,1],[4]]' && tools.splitParts('', 6) === null && tools.splitParts('1,9', 6) === null && JSON.stringify(tools.chunkEvery(2, 5)) === '[[0,1],[2,3],[4]]' && tools.chunkEvery(0, 5) === null && tools.chunkEvery(9, 5) === null, 'pdf-tools: розділення на частини (діапазони, кожні N), некоректне відхиляється');

  // тестові файли
  const mk = async (sizes, meta, withJs) => {
    const d = await PDFDocument.create();
    sizes.forEach(([w, h]) => d.addPage([w, h]));
    if (meta) { d.setTitle('Назва-T'); d.setAuthor('Автор-A'); }
    if (withJs) {
      const ctxp = d.context;
      const act = ctxp.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') });
      const uri = ctxp.obj({ S: 'URI', URI: PDFString.of('https://example.com/') });
      const mkAnn = (a) => ctxp.register(ctxp.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10], A: a }));
      d.getPage(0).node.set(PDFName.of('Annots'), ctxp.obj([mkAnn(act), mkAnn(uri)]));
      d.getPage(0).node.set(PDFName.of('AA'), ctxp.obj({ O: act }));
    }
    return Buffer.from(await d.save());
  };
  fs.writeFileSync(P('a.pdf'), await mk([[200, 300], [210, 300], [220, 300]], true, true));
  fs.writeFileSync(P('b.pdf'), await mk([[400, 500], [410, 500]], false, false));
  fs.writeFileSync(P('five.pdf'), await mk([[101, 100], [102, 100], [103, 100], [104, 100], [105, 100]], false, false));
  fs.writeFileSync(P('html.pdf'), '<html><script>1</script></html> padding padding');
  fs.writeFileSync(P('broken.pdf'), '%PDF-1.4\nthis is not a pdf at all, just garbage garbage garbage');
  fs.writeFileSync(P('big.pdf'), '%PDF-1.4\n'); fs.truncateSync(P('big.pdf'), tools.MAX_FILE + 1024);
  fs.writeFileSync(P('bad.png'), 'not an image at all not an image');
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  fs.writeFileSync(P('sig.png'), PNG);
  fs.mkdirSync(P('dirx.pdf'));

  const win = { win: null, tabs: [], pdfFrom: null };
  const entry = { win };
  const o = { open: tools.ui.open, save: tools.ui.save, show: tools.ui.show };
  const pick = (files) => { tools.ui.open = async () => ({ canceled: false, filePaths: files }); };
  const saveAs = (f) => { tools.ui.save = async () => ({ canceled: false, filePath: f }); };
  const api = (n, a) => tools.api(ctx, entry, n, a);
  const info = async (f) => { const d = await PDFDocument.load(fs.readFileSync(f)); return { n: d.getPageCount(), sizes: d.getPages().map(p => Math.round(p.getWidth())), rot: d.getPages().map(p => p.getRotation().angle), title: d.getTitle(), author: d.getAuthor() }; };
  try {
    // додавання: перевірки підпису, розміру, пошкоджених, папок, «.html під виглядом .pdf»
    pick([P('a.pdf'), P('b.pdf'), P('five.pdf'), P('html.pdf'), P('broken.pdf'), P('big.pdf'), P('dirx.pdf'), 'rel.pdf', path.join(dir, 'NUL.pdf')]);
    const add = await api('pdf:add');
    const errs = Object.fromEntries(add.rejected.map(r => [r.name, r.error]));
    ok(add.ok && add.docs.length === 3 && add.docs[0].pages === 3 && add.docs[1].pages === 2 && errs['html.pdf'] === 'signature' && errs['broken.pdf'] === 'broken' && errs['big.pdf'] === 'big' && errs['dirx.pdf'] === 'path' && errs['rel.pdf'] === 'path' && errs['NUL.pdf'] === 'path', 'pdf-tools: у список потрапляють лише справжні PDF; підроблені, пошкоджені, завеликі, папки, відносні й зарезервовані імена відхиляються');
    const [A, B, F] = add.docs.map(d => d.id);

    // злиття (порядок B, A), небезпечні дії прибрано, звичайні посилання лишились
    saveAs(P('merged.pdf'));
    const mg = await api('pdf:run', { op: 'merge', ids: [B, A] });
    const mi = await info(P('merged.pdf'));
    ok(mg.ok && mi.n === 5 && mi.sizes.join() === '400,410,200,210,220' && mg.removedActions >= 2, 'pdf-tools: злиття зберігає порядок файлів і сторінок, прибирає JavaScript-дії');
    const md = await PDFDocument.load(fs.readFileSync(P('merged.pdf')));
    const an = md.getPage(2).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    const acts = an ? Array.from({ length: an.size() }, (_, i) => an.lookupMaybe(i, PDFDict).lookupMaybe(PDFName.of('A'), PDFDict)).filter(Boolean).map(d => d.get(PDFName.of('S')).asString()) : [];
    ok(!md.getPage(2).node.has(PDFName.of('AA')) && acts.join() === '/URI' && !/\/JavaScript/.test(fs.readFileSync(P('merged.pdf'), 'latin1')), 'pdf-tools: у результаті немає /JavaScript і /AA, посилання URI збережено');
    ok(mi.title === undefined || mi.title === '' || mi.title === 'Назва-T', 'pdf-tools: метадані перших файлів без назви не вигадуються');

    // редагування: порядок, видалення, поворот, метадані
    saveAs(P('e1.pdf'));
    const e1 = await api('pdf:run', { op: 'edit', ids: [A], pages: '3,1', angle: 90, rotatePages: '1' });
    const i1 = await info(P('e1.pdf'));
    ok(e1.ok && i1.n === 2 && i1.sizes.join() === '220,200' && i1.rot.join() === '90,0' && i1.title === 'Назва-T' && i1.author === 'Автор-A', 'pdf-tools: переставляння (3,1), поворот першої сторінки на 90°, метадані збережено');
    saveAs(P('e2.pdf'));
    const e2 = await api('pdf:run', { op: 'edit', ids: [A], remove: '2', strip: true });
    const i2 = await info(P('e2.pdf'));
    ok(e2.ok && i2.n === 2 && i2.sizes.join() === '200,220' && !i2.title && !i2.author && !/Назва-T|Автор-A|pdf-lib/.test(fs.readFileSync(P('e2.pdf'), 'latin1')), 'pdf-tools: видалення сторінки 2 і видалення метаданих (у файлі немає автора, назви, виробника)');
    const e3 = await api('pdf:run', { op: 'edit', ids: [A], remove: '1-3' });
    const e4 = await api('pdf:run', { op: 'edit', ids: [A], pages: '9' });
    const e5 = await api('pdf:run', { op: 'edit', ids: [A], angle: 45 });
    const e6 = await api('pdf:run', { op: 'edit', ids: [A], angle: 90, rotatePages: '7' });
    ok(e3.error === 'empty' && e4.error === 'range' && e5.error === 'angle' && e6.error === 'range', 'pdf-tools: порожній результат, сторінка поза межами, кут не кратний 90, поворот неіснуючої сторінки — відхиляються');

    // розділення
    const outDir = P('parts'); fs.mkdirSync(outDir);
    tools.ui.open = async () => ({ canceled: false, filePaths: [outDir] });
    const s1 = await api('pdf:run', { op: 'split', ids: [F], mode: 'every', every: 2 });
    const s2 = await api('pdf:run', { op: 'split', ids: [F], mode: 'ranges', ranges: '1-2,5' });
    const parts = fs.readdirSync(outDir).sort();
    ok(s1.ok && s1.files.length === 3 && s2.ok && s2.files.length === 2 && parts.length === 5 && (await info(path.join(outDir, s1.files[2]))).n === 1 && (await info(path.join(outDir, s2.files[0]))).sizes.join() === '101,102' && (await info(path.join(outDir, s2.files[1]))).sizes.join() === '105', 'pdf-tools: розділення за діапазонами та по N сторінок, наявні файли не перезаписуються');
    ok((await api('pdf:run', { op: 'split', ids: [F], mode: 'ranges', ranges: '1-9' })).error === 'range' && (await api('pdf:run', { op: 'split', ids: [F], mode: 'every', every: 0 })).error === 'range', 'pdf-tools: некоректне розділення відхиляється');

    // підпис зображенням (також на повернутій сторінці), поганий файл підпису
    pick([P('sig.png')]);
    const sg = await api('pdf:sig');
    saveAs(P('s1.pdf'));
    const r1 = await api('pdf:run', { op: 'edit', ids: [B], sig: { page: 1, pos: 'br', width: 20 } });
    saveAs(P('s2.pdf'));
    const r2 = await api('pdf:run', { op: 'edit', ids: [B], angle: 90, rotatePages: '2', sig: { page: 2, pos: 'tl', width: 30 } });
    const img = (f) => /\/Subtype\s*\/Image/.test(fs.readFileSync(f, 'latin1'));
    ok(sg.ok && sg.sig === 'sig.png' && r1.ok && r2.ok && img(P('s1.pdf')) && img(P('s2.pdf')) && !img(P('e2.pdf')), 'pdf-tools: зображення підпису накладається на сторінку (і на повернуту)');
    const badSig = await api('pdf:run', { op: 'edit', ids: [B], sig: { page: 9, pos: 'br', width: 20 } });
    const badPos = await api('pdf:run', { op: 'edit', ids: [B], sig: { page: 1, pos: 'zz', width: 20 } });
    const badW = await api('pdf:run', { op: 'edit', ids: [B], sig: { page: 1, pos: 'br', width: 500 } });
    pick([P('bad.png')]);
    const badImg = await api('pdf:sig');
    ok(badSig.error === 'range' && badPos.error === 'range' && badW.error === 'range' && badImg.error === 'image', 'pdf-tools: підпис — сторінка, положення й ширина перевіряються, не-зображення відхиляється');

    // шляхи результату й вибір
    saveAs(P('a.pdf'));
    const same = await api('pdf:run', { op: 'edit', ids: [A], strip: true });
    saveAs('rel.pdf');
    const rel = await api('pdf:run', { op: 'merge', ids: [A, B] });
    saveAs(path.join(dir, 'CON.pdf'));
    const res = await api('pdf:run', { op: 'merge', ids: [A, B] });
    tools.ui.save = async () => ({ canceled: true });
    const cn = await api('pdf:run', { op: 'merge', ids: [A, B] });
    ok(same.error === 'same' && rel.error === 'path' && res.error === 'path' && cn.error === 'canceled' && fs.readFileSync(P('a.pdf')).length > 100 && (await api('pdf:run', { op: 'merge', ids: [A] })).error === 'select' && (await api('pdf:run', { op: 'merge', ids: [A, 'x'] })).error === 'select' && (await api('pdf:run', { op: 'edit', ids: [A, B] })).error === 'select' && (await api('pdf:run', { op: 'merge', ids: [A, A] })).error === 'select' && (await api('pdf:run', { op: 'nope', ids: [A] })).error === 'select', 'pdf-tools: результат не перезаписує вхідний файл, відносні й зарезервовані шляхи відхиляються, скасування, некоректний вибір');
    ok(!fs.readdirSync(dir).some(f => f.endsWith('.w3ir-tmp')), 'pdf-tools: тимчасових файлів не лишається');

    // ліміт кількості файлів і керування списком
    pick(Array.from({ length: tools.MAX_FILES + 3 }, () => P('b.pdf')));
    const many = await api('pdf:add');
    ok(many.docs.length === tools.MAX_FILES && many.rejected.some(r => r.error === 'files'), `pdf-tools: у списку не більше ${tools.MAX_FILES} файлів`);
    const mv = await api('pdf:move', { id: many.docs[1].id, dir: 'up' });
    ok(mv.docs[0].id === many.docs[1].id && (await api('pdf:remove', { id: mv.docs[0].id })).docs.length === tools.MAX_FILES - 1 && (await api('pdf:clear')).docs.length === 0, 'pdf-tools: переміщення, видалення й очищення списку');
    ok((await api('pdf:bogus')).ok === false && (await api('pdf:savePage', { ranges: '1' })).error === 'tab', 'pdf-tools: невідома команда й збереження без вкладки відхиляються');
  } finally { tools.ui.open = o.open; tools.ui.save = o.save; tools.ui.show = o.show; }

  // політика IPC: лише w3ir://pdftools, без запиту в адресі
  ok(permitted('pdf:run', 'w3ir://pdftools') && permitted('pdf:state', 'w3ir://pdftools/') && ['w3ir://settings', 'w3ir://downloads', 'w3ir://history', 'w3ir://wallet', 'w3ir://pdftools?x=1', 'w3ir://pdftools.evil', 'https://pdftools/', ''].every(u => !permitted('pdf:run', u)) && !permitted('pdf:add', 'w3ir://newtab'), 'pdf-tools: IPC pdf:* дозволено лише сторінці w3ir://pdftools (без запиту в адресі)');

  // справжня сторінка: працює, а з чужої сторінки IPC відхиляється
  const w = [...ctx.windows].find(x => !x.incognito && !x.agent);
  const tab = w.createTab('w3ir://pdftools', { activate: false });
  await sleep(1500);
  const wc = tab.view.webContents;
  const st = await wc.executeJavaScript(`w3ir.invoke('pdf:state').then(r => r.ok && Array.isArray(r.docs) && r.limits.fileMb === 200)`);
  const ui1 = await wc.executeJavaScript(`({ h1: document.querySelector('h1').textContent, buttons: document.querySelectorAll('button').length, csp: !!document.querySelector('meta[http-equiv="Content-Security-Policy"]') })`);
  ok(st === true && ui1.h1 === 'PDF-інструменти' && ui1.buttons >= 8 && ui1.csp, 'pdf-tools: сторінка w3ir://pdftools відкривається, будує інтерфейс і отримує стан через IPC');
  w.closeTab(tab.id);
  const other = w.createTab('w3ir://downloads', { activate: false });
  await sleep(1400);
  const denied = await other.view.webContents.executeJavaScript(`w3ir.invoke('pdf:state').then(() => 'ok', () => 'denied')`);
  w.closeTab(other.id);
  ok(denied === 'denied', 'pdf-tools: зі сторінки «Завантаження» pdf:state відхиляється');

  // статично: без innerHTML, CSP як в інших сторінках, mainFrame-перевірка в ipc, межі в коді
  const root = path.join(__dirname, '..', '..');
  const js = fs.readFileSync(path.join(root, 'pages', 'pdftools.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'pages', 'pdftools.html'), 'utf8');
  const dl = fs.readFileSync(path.join(root, 'pages', 'downloads.html'), 'utf8');
  const csp = (s) => (/Content-Security-Policy" content="([^"]+)"/.exec(s) || [])[1];
  ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(js) && csp(html) && csp(html) === csp(dl) && !/<script>[^<]|\son\w+=/.test(html), 'pdf-tools: сторінка без innerHTML/eval, CSP такий самий, як в інших сторінках');
  ok(/frame !== e\.sender\.mainFrame/.test(fs.readFileSync(path.join(root, 'src', 'ipc.js'), 'utf8')) && !/\bw3ir\.invoke\('pdf:[a-zA-Z]+',\s*\{[^}]*(path|file)/.test(js), 'pdf-tools: IPC лише з головного кадру; сторінка не передає шляхів файлів');
  // ?????????: ?????? ? pdf-lib ????? ?????????? ? asar (?????????? ??????? --dir: Worker ????? ? app.asar)
  const bpkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const bfiles = bpkg.build.files;
  const excl = bfiles.filter(x => x.startsWith('!'));
  const pdfLibMain = require('pdf-lib/package.json').main;
  ok(bfiles.includes('src/**') && !excl.some(x => /src\/|pdf-worker|crash-log/.test(x)) && !excl.some(x => x.includes('pdf-lib') && x.includes(pdfLibMain.split('/')[0])) && /^cjs\//.test(pdfLibMain) && !(bpkg.build.asarUnpack || []).length && /__dirname/.test(fs.readFileSync(path.join(root, 'src', 'pdf-tools.js'), 'utf8')), 'pdf: ?????? ? pdf-lib (cjs) ??????? ? ??????; ???? ??????? ????? __dirname, asarUnpack ?? ????????');
}

module.exports = { pdfTests };