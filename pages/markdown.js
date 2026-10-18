'use strict';
// Markdown → HTML для сторінки w3ir://doc. Увесь текст екранується; сирий HTML у джерелі показується як текст.
// Посилання — лише http(s)/mailto/#, зображення — лише http(s) (CSP сторінки теж це обмежує).
// Підтримано: заголовки, абзаци, списки (вкладені, нумеровані, завдання), цитати, код (блоки з ``` і ~~~), таблиці,
// лінії, виділення, посилання, зображення. Без залежностей, працює і в Node (юніт-тести).
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const SAFE_HREF = /^(https?:|mailto:|#)/i;
const SAFE_SRC = /^https?:/i;

function inline(src) {
  const codes = [];
  let s = String(src).replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (m, q, c) => {
    codes.push('<code>' + esc(c.trim()) + '</code>');
    return '\u0000' + (codes.length - 1) + '\u0000';
  });
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\s*\)/g, (m, alt, url, title) => {
    const u = url.replace(/&amp;/g, '&');
    return SAFE_SRC.test(u) ? `<img src="${esc(u)}" alt="${alt}"${title ? ` title="${title}"` : ''}>` : alt;
  });
  s = s.replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\s*\)/g, (m, text, url, title) => {
    const u = url.replace(/&amp;/g, '&');
    return SAFE_HREF.test(u) ? `<a href="${esc(u)}"${title ? ` title="${title}"` : ''} rel="noopener noreferrer">${text}</a>` : text;
  });
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, (m, pre, url) => `${pre}<a href="${url.replace(/&amp;/g, '&amp;')}" rel="noopener noreferrer">${url}</a>`);
  s = s.replace(/\*\*([^*]+?)\*\*|__([^_]+?)__/g, (m, a, b) => `<strong>${a || b}</strong>`);
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\s][^_]*?)_(?![_\w])/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+?)~~/g, '<del>$1</del>');
  s = s.replace(/ {2,}\n/g, '<br>\n');
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => codes[Number(i)]);
}

const RE = {
  fence: /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/,
  heading: /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/,
  hr: /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/,
  quote: /^ {0,3}>\s?(.*)$/,
  item: /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/,
  tableSep: /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/,
};

function cells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map(c => c.replace(/\\\|/g, '|').trim());
}

function blocks(lines, depth) {
  const out = [];
  let i = 0;
  const blank = (l) => !/\S/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) { i++; continue; }
    let m = RE.fence.exec(line);
    if (m) {
      const fence = m[1], body = [];
      i++;
      while (i < lines.length && !(lines[i].trim().startsWith(fence[0].repeat(fence.length)) && /^\s*[`~]+\s*$/.test(lines[i]))) body.push(lines[i++]);
      i++;
      out.push(`<pre><code${m[2] ? ` class="lang-${esc(m[2])}"` : ''}>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    if ((m = RE.heading.exec(line))) { out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue; }
    if (RE.hr.test(line)) { out.push('<hr>'); i++; continue; }
    if (RE.quote.test(line)) {
      const q = [];
      while (i < lines.length && RE.quote.test(lines[i])) q.push(RE.quote.exec(lines[i++])[1]);
      out.push('<blockquote>' + (depth < 8 ? blocks(q, depth + 1) : esc(q.join('\n'))) + '</blockquote>');
      continue;
    }
    if (i + 1 < lines.length && line.includes('|') && RE.tableSep.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = cells(line), align = cells(lines[i + 1]).map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
      i += 2;
      const rows = [];
      while (i < lines.length && !blank(lines[i]) && lines[i].includes('|')) rows.push(cells(lines[i++]));
      const td = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c)}</${tag}>`;
      out.push('<table><thead><tr>' + head.map((c, k) => td('th', c, k)).join('') + '</tr></thead><tbody>'
        + rows.map(r => '<tr>' + head.map((_, k) => td('td', r[k] || '', k)).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    if ((m = RE.item.exec(line))) {
      const base = m[1].length, ordered = /\d/.test(m[2]);
      const items = [];
      while (i < lines.length) {
        const im = RE.item.exec(lines[i]);
        if (im && im[1].length <= base + 1 && /\d/.test(im[2]) === ordered) { items.push([im[3]]); i++; continue; }
        if (!blank(lines[i]) && items.length && /^ {2,}/.test(lines[i]) && lines[i].search(/\S/) > base) { items[items.length - 1].push(lines[i].slice(Math.min(lines[i].search(/\S/), base + 2))); i++; continue; }
        if (blank(lines[i]) && i + 1 < lines.length && /^ {2,}\S/.test(lines[i + 1]) && items.length) { items[items.length - 1].push(''); i++; continue; }
        break;
      }
      const start = ordered ? Number(/\d+/.exec(m[2])[0]) : 1;
      out.push((ordered ? `<ol${start !== 1 ? ` start="${start}"` : ''}>` : '<ul>') + items.map((it) => {
        let first = it[0], box = '';
        const t = /^\[( |x|X)\]\s+(.*)$/.exec(first);
        if (t) { box = `<input type="checkbox" disabled${t[1] !== ' ' ? ' checked' : ''}> `; first = t[2]; }
        const rest = it.slice(1);
        const inner = depth < 8 && rest.some(l => /\S/.test(l)) ? blocks([first, ...rest], depth + 1) : '<p>' + inline(first) + '</p>';
        return '<li>' + box + inner.replace(/^<p>([\s\S]*?)<\/p>/, '$1') + '</li>';
      }).join('') + (ordered ? '</ol>' : '</ul>'));
      continue;
    }
    // абзац: до порожнього рядка або початку іншого блоку
    const p = [];
    while (i < lines.length && !blank(lines[i]) && !RE.fence.test(lines[i]) && !RE.heading.test(lines[i]) && !RE.hr.test(lines[i]) && !RE.quote.test(lines[i]) && !(p.length && RE.item.test(lines[i]))) p.push(lines[i++]);
    if (!p.length) { p.push(lines[i++]); }
    out.push('<p>' + inline(p.join('\n')) + '</p>');
  }
  return out.join('\n');
}

// Рендер із обмеженням розміру входу (зверху не більше 5 МБ — це робить завантажувач файлу)
function render(src) {
  const text = String(src == null ? '' : src).replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  return blocks(text.split('\n'), 0);
}

// Заголовок документа: перший заголовок першого рівня
function titleOf(src) {
  const m = /^ {0,3}#\s+(.+?)\s*#*\s*$/m.exec(String(src || ''));
  return m ? m[1].replace(/[*_`[\]]/g, '').slice(0, 120) : '';
}

if (typeof module !== 'undefined' && module.exports) module.exports = { render, titleOf, esc };
else window.Markdown = { render, titleOf };
