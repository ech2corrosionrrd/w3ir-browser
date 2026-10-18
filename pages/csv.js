'use strict';
// Розбір CSV/TSV (RFC 4180: лапки, подвоєні лапки, переноси рядків у полях) для сторінки w3ir://doc. Працює і в Node (тести).
function detectDelimiter(text, name) {
  if (/\.(tsv|tab)$/i.test(String(name || ''))) return '\t';
  const head = String(text).slice(0, 4000).split('\n').slice(0, 5).join('\n');
  const count = (d) => head.split(d).length - 1;
  const best = [',', ';', '\t', '|'].map(d => [d, count(d)]).sort((a, b) => b[1] - a[1])[0];
  return best[1] ? best[0] : ',';
}

function parse(text, delim, maxRows) {
  const src = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const rows = [];
  let row = [], field = '', quoted = false, i = 0, truncated = false;
  const endRow = () => { row.push(field); field = ''; if (!(row.length === 1 && row[0] === '')) rows.push(row); row = []; };
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i += 2; continue; } quoted = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === delim) { row.push(field); field = ''; i++; continue; }
    if (c === '\n') { endRow(); i++; if (maxRows && rows.length >= maxRows) { truncated = i < src.length; break; } continue; }
    field += c; i++;
  }
  if (!(maxRows && rows.length >= maxRows) && (field !== '' || row.length)) endRow();
  return { rows, truncated };
}

// Порівняння для сортування: числа за значенням, решта — за локаллю
function compare(a, b) {
  const na = Number(String(a).replace(/\s/g, '').replace(',', '.')), nb = Number(String(b).replace(/\s/g, '').replace(',', '.'));
  if (a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

if (typeof module !== 'undefined' && module.exports) module.exports = { parse, detectDelimiter, compare };
else window.Csv = { parse, detectDelimiter, compare };
