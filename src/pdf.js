'use strict';
// PDF: відкриття у вкладці вбудованим переглядачем Chromium (пошук, мініатюри, масштаб, поворот, друк — з самого переглядача)
// та збереження сторінки в PDF. Власного рушія PDF у W3IR немає і нових залежностей він не потребує.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { t: tr } = require('./i18n');

const PDF_NAME = /\.pdf$/i;
const isPdfName = (name) => PDF_NAME.test(String(name || ''));

// Файл із розширенням .pdf відкриваємо у вкладці лише якщо він справді починається з «%PDF-»:
// інакше .html, перейменований у .pdf, завантажився б як сторінка з файловим походженням.
function looksLikePdf(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(1024);
    const n = fs.readSync(fd, buf, 0, 1024, 0);
    return buf.subarray(0, n).includes('%PDF-');
  } catch { return false; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

function pdfFileUrl(file) {
  if (!file || !path.isAbsolute(file) || !isPdfName(file)) return null;
  try { if (!fs.statSync(file).isFile()) return null; } catch { return null; }
  return looksLikePdf(file) ? pathToFileURL(file).href : null;
}

// «1-3, 5, 8-» → безпечний рядок для printToPDF ('1-3,5,8-'); некоректне → null (порожнє → '' = усі сторінки)
function parsePageRanges(input) {
  const s = String(input == null ? '' : input).replace(/\s+/g, '');
  if (!s) return '';
  if (s.length > 100 || !/^\d{1,5}(-\d{0,5})?(,\d{1,5}(-\d{0,5})?)*$/.test(s)) return null;
  for (const part of s.split(',')) {
    const [a, b] = part.split('-');
    if (Number(a) < 1 || (b !== undefined && b !== '' && Number(b) < Number(a))) return null;
  }
  return s;
}

// Шлях збереження: абсолютний, з розширенням .pdf, без службових імен і без каталогу замість файлу
function safePdfPath(p) {
  let f = String(p || '');
  if (!f || f.includes('\0') || !path.isAbsolute(f)) return null;
  f = path.normalize(f);
  if (!isPdfName(f)) f += '.pdf';
  const base = path.basename(f);
  if (!base || base === '.pdf' || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(base)) return null;
  try { if (fs.existsSync(f) && !fs.statSync(f).isFile()) return null; } catch { return null; }
  return f;
}

function defaultName(title) {
  const n = String(title || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return (n || 'page') + '.pdf';
}

// Зберегти вміст вкладки в PDF (webContents.printToPDF) через діалог «Зберегти як…».
// opts.pageRanges — необов’язковий діапазон сторінок; opts.file — готовий шлях (без діалогу, для тестів)
async function savePageAsPdf(win, wc, opts = {}) {
  const { dialog, app } = require('electron');
  if (!wc || wc.isDestroyed()) return { ok: false, error: 'tab' };
  let url = '';
  try { url = wc.getURL(); } catch { /* ignore */ }
  if (isPdfName(url.split(/[?#]/)[0])) return { ok: false, error: 'already-pdf' };
  const ranges = parsePageRanges(opts.pageRanges);
  if (ranges === null) return { ok: false, error: 'ranges' };
  let file = opts.file;
  if (!file) {
    const dir = (win && win.ctx && win.ctx.cfg().downloadDir && fs.existsSync(win.ctx.cfg().downloadDir)) ? win.ctx.cfg().downloadDir : app.getPath('downloads');
    const r = await dialog.showSaveDialog(win && win.win, {
      title: tr('Зберегти сторінку як PDF'), defaultPath: path.join(dir, defaultName(wc.getTitle())), filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, error: 'canceled' };
    file = r.filePath;
  }
  file = safePdfPath(file);
  if (!file) return { ok: false, error: 'path' };
  try {
    const data = await wc.printToPDF({ printBackground: true, preferCSSPageSize: true, ...(ranges ? { pageRanges: ranges } : {}) });
    fs.writeFileSync(file, data);
    return { ok: true, file, bytes: data.length };
  } catch { return { ok: false, error: 'print' }; }
}

module.exports = { isPdfName, looksLikePdf, pdfFileUrl, parsePageRanges, safePdfPath, defaultName, savePageAsPdf };