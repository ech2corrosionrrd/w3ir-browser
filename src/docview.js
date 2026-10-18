'use strict';
// Перегляд локальних документів Markdown у вкладці (w3ir://doc): читання файлу з перевірками. Рендер — на сторінці (pages/markdown.js).
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

const MD_NAME = /\.(md|markdown|mdown|mkd)$/i;
const MAX_BYTES = 5 * 1024 * 1024;
const isMarkdownName = (name) => MD_NAME.test(String(name || ''));

// file:-адреса Markdown-файлу → шлях (інакше null); запит і фрагмент ігноруються
function markdownPathFromUrl(url) {
  let u;
  try { u = new URL(String(url || '')); } catch { return null; }
  if (u.protocol !== 'file:' || u.hostname) return null; // мережеві шляхи (\сервер\…) не відкриваємо
  let p;
  try { p = fileURLToPath(u.protocol + '//' + u.pathname); } catch { return null; }
  return isMarkdownName(p) ? p : null;
}

// Прочитати документ: лише звичайний файл, розширення Markdown, до 5 МБ, без нульових байтів (не двійковий)
function loadDoc(file) {
  if (!file || !path.isAbsolute(file) || !isMarkdownName(file)) return { ok: false, error: 'type' };
  let st;
  try { st = fs.statSync(file); } catch { return { ok: false, error: 'missing' }; }
  if (!st.isFile()) return { ok: false, error: 'type' };
  if (st.size > MAX_BYTES) return { ok: false, error: 'size' };
  let buf;
  try { buf = fs.readFileSync(file); } catch { return { ok: false, error: 'read' }; }
  if (buf.includes(0)) return { ok: false, error: 'binary' };
  return { ok: true, name: path.basename(file), file, size: st.size, text: buf.toString('utf8').replace(/^\uFEFF/, '') };
}

module.exports = { isMarkdownName, markdownPathFromUrl, loadDoc, MAX_BYTES };
