'use strict';
// Перегляд локальних документів у вкладці (w3ir://doc): Markdown, CSV/TSV, JSON і текст/код. Тут лише читання файлу з перевірками,
// розбір і відображення — на сторінці (pages/markdown.js, pages/csv.js, pages/doc.js).
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

const KINDS = {
  md: 'md', markdown: 'md', mdown: 'md', mkd: 'md',
  csv: 'csv', tsv: 'csv', tab: 'csv',
  json: 'json',
  // текст і код без підсвітки (з номерами рядків); виконувані типи (.js, .ps1, .bat…) сюди не входять навмисно
  log: 'text', ini: 'text', cfg: 'text', conf: 'text', toml: 'text', yml: 'text', yaml: 'text', env: 'text', sql: 'text', css: 'text',
  py: 'text', ts: 'text', rs: 'text', go: 'text', java: 'text', c: 'text', h: 'text', cpp: 'text', cs: 'text', rb: 'text', php: 'text', sh: 'text', diff: 'text', patch: 'text',
};
const MAX_BYTES = 5 * 1024 * 1024;

function docKind(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? (KINDS[m[1].toLowerCase()] || null) : null;
}
const isMarkdownName = (name) => docKind(name) === 'md';
// Типи, які відкриваються у вкладці з «Завантажень» (код і логи лишаються за системною програмою)
const isDownloadDoc = (name) => ['md', 'csv', 'json'].includes(docKind(name));

// file:-адреса документа → шлях (інакше null); запит і фрагмент ігноруються
function docPathFromUrl(url) {
  let u;
  try { u = new URL(String(url || '')); } catch { return null; }
  if (u.protocol !== 'file:' || u.hostname) return null; // мережеві шляхи (\сервер\…) не відкриваємо
  let p;
  try { p = fileURLToPath(u.protocol + '//' + u.pathname); } catch { return null; }
  return docKind(p) ? p : null;
}

// Прочитати документ: лише звичайний файл відомого типу, до 5 МБ, без нульових байтів (не двійковий)
function loadDoc(file) {
  if (!file || !path.isAbsolute(file) || !docKind(file)) return { ok: false, error: 'type' };
  let st;
  try { st = fs.statSync(file); } catch { return { ok: false, error: 'missing' }; }
  if (!st.isFile()) return { ok: false, error: 'type' };
  if (st.size > MAX_BYTES) return { ok: false, error: 'size' };
  let buf;
  try { buf = fs.readFileSync(file); } catch { return { ok: false, error: 'read' }; }
  if (buf.includes(0)) return { ok: false, error: 'binary' };
  return { ok: true, name: path.basename(file), file, kind: docKind(file), size: st.size, text: buf.toString('utf8').replace(/^\uFEFF/, '') };
}

module.exports = { docKind, isMarkdownName, isDownloadDoc, docPathFromUrl, loadDoc, MAX_BYTES };
