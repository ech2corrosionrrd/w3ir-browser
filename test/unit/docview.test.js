'use strict';
// Перегляд Markdown: рендерер (pages/markdown.js) і завантажувач файлів (src/docview.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { render, titleOf } = require('../../pages/markdown.js');
const docview = require('../../src/docview.js');

test('markdown: заголовки, абзаци, виділення, код', () => {
  const h = render('# Заголовок\n\nТекст з **жирним**, *курсивом*, ~~закресленим~~ і `кодом <b>`.');
  assert.match(h, /<h1>Заголовок<\/h1>/);
  assert.match(h, /<strong>жирним<\/strong>/);
  assert.match(h, /<em>курсивом<\/em>/);
  assert.match(h, /<del>закресленим<\/del>/);
  assert.match(h, /<code>кодом &lt;b&gt;<\/code>/);
});

test('markdown: сирий HTML і небезпечні посилання не потрапляють у розмітку', () => {
  const h = render('<script>alert(1)</script>\n\n[x](javascript:alert(1)) ![i](data:text/html,x) ![ok](https://e.example/a.png) [ok](https://e.example/ "t")\n\n<img src=x onerror=alert(1)>');
  assert.ok(!/<script|onerror=alert|javascript:|data:text/.test(h.replace(/&lt;img src=x onerror=alert\(1\)&gt;/, '')));
  assert.match(h, /&lt;script&gt;/);
  assert.match(h, /<img src="https:\/\/e\.example\/a\.png" alt="ok">/);
  assert.match(h, /<a href="https:\/\/e\.example\/" title="t" rel="noopener noreferrer">ok<\/a>/);
});

test('markdown: списки (вкладені, нумеровані, завдання) і блоки коду', () => {
  const h = render('- один\n- два\n  - вкладений\n\n3. раз\n4. два\n\n- [x] готово\n- [ ] ні\n\n```js\nconst a = "<b>";\n```');
  assert.ok(h.includes('<ul><li>один</li><li>два\n<ul><li>вкладений</li></ul></li></ul>'));
  assert.match(h, /<ol start="3"><li>раз<\/li><li>два<\/li><\/ol>/);
  assert.match(h, /<input type="checkbox" disabled checked> готово/);
  assert.match(h, /<pre><code class="lang-js">const a = &quot;&lt;b&gt;&quot;;<\/code><\/pre>/);
});

test('markdown: таблиці, цитати, лінії, автопосилання', () => {
  const h = render('| А | Б |\n|:-:|--:|\n| 1 | 2 |\n\n> цитата\n\n---\n\nСайт https://example.com/a?b=1&c=2.');
  assert.match(h, /<th style="text-align:center">А<\/th><th style="text-align:right">Б<\/th>/);
  assert.match(h, /<td style="text-align:center">1<\/td>/);
  assert.match(h, /<blockquote><p>цитата<\/p><\/blockquote>/);
  assert.match(h, /<hr>/);
  assert.match(h, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" rel="noopener noreferrer">/);
});

test('markdown: порожній вхід, CRLF, BOM, глибока вкладеність не ламають рендер', () => {
  assert.equal(render(''), '');
  assert.equal(render(null), '');
  assert.match(render('\uFEFF# А\r\n\r\nб'), /<h1>А<\/h1>\n<p>б<\/p>/);
  assert.doesNotThrow(() => render('> '.repeat(500) + 'x'));
  assert.doesNotThrow(() => render('- a\n' + '  '.repeat(1) + '- b\n'.repeat(2000)));
  assert.equal(titleOf('текст\n# Мій *документ*\n'), 'Мій документ');
  assert.equal(titleOf('без заголовка'), '');
});

test('docview: розпізнавання Markdown та file:-адрес', () => {
  assert.ok(docview.isMarkdownName('a.MD') && docview.isMarkdownName('a.markdown') && !docview.isMarkdownName('a.md.exe') && !docview.isMarkdownName('md'));
  assert.equal(docview.docPathFromUrl('https://e.example/a.md'), null);
  assert.equal(docview.docPathFromUrl('file://server/share/a.md'), null);
  assert.equal(docview.docPathFromUrl('file:///C:/x/a.exe'), null);
  const p = docview.docPathFromUrl('file:///C:/My%20Docs/a.md?x=1#h');
  if (process.platform === 'win32') assert.equal(p, ['C:', 'My Docs', 'a.md'].join(path.sep));
});

test('docview: loadDoc — лише текстові файли Markdown до 5 МБ', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3ir-doc-'));
  try {
    const f = path.join(dir, 'a.md');
    fs.writeFileSync(f, '\uFEFF# Привіт');
    const r = docview.loadDoc(f);
    assert.ok(r.ok && r.text === '# Привіт' && r.name === 'a.md');
    fs.writeFileSync(path.join(dir, 'b.md'), Buffer.from([0x23, 0, 0x41]));
    assert.equal(docview.loadDoc(path.join(dir, 'b.md')).error, 'binary');
    fs.writeFileSync(path.join(dir, 'big.md'), Buffer.alloc(docview.MAX_BYTES + 1, 97));
    assert.equal(docview.loadDoc(path.join(dir, 'big.md')).error, 'size');
    fs.mkdirSync(path.join(dir, 'd.md'));
    assert.equal(docview.loadDoc(path.join(dir, 'd.md')).error, 'type');
    assert.equal(docview.loadDoc(path.join(dir, 'none.md')).error, 'missing');
    assert.equal(docview.loadDoc('rel.md').error, 'type');
    assert.equal(docview.loadDoc(path.join(dir, 'x.exe')).error, 'type');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('docview: типи файлів — Markdown, CSV, JSON, текст; виконувані й HTML не входять', () => {
  assert.equal(docview.docKind('a.CSV'), 'csv');
  assert.equal(docview.docKind('a.tsv'), 'csv');
  assert.equal(docview.docKind('a.json'), 'json');
  assert.equal(docview.docKind('a.yaml'), 'text');
  assert.equal(docview.docKind('a.md'), 'md');
  for (const n of ['a.js', 'a.ps1', 'a.bat', 'a.exe', 'a.html', 'a.svg', 'a.txt', 'a.pdf', 'json']) assert.equal(docview.docKind(n), null, n);
  assert.ok(docview.isDownloadDoc('x.csv') && docview.isDownloadDoc('x.json') && docview.isDownloadDoc('x.md') && !docview.isDownloadDoc('x.py') && !docview.isDownloadDoc('x.log'));
});

test('csv: лапки, переноси в полях, роздільники, обмеження рядків', () => {
  const { parse, detectDelimiter, compare } = require('../../pages/csv.js');
  const r = parse('a,b,c\n1,"x, y","рядок1\nрядок2"\n"ц""итата",,3\n', ',');
  assert.deepEqual(r.rows, [['a', 'b', 'c'], ['1', 'x, y', 'рядок1\nрядок2'], ['ц"итата', '', '3']]);
  assert.deepEqual(parse('\uFEFFa;b\r\n1;2\r\n\r\n3;4', ';').rows, [['a', 'b'], ['1', '2'], ['3', '4']]);
  assert.equal(detectDelimiter('a;b;c\n1;2;3', 'x.csv'), ';');
  assert.equal(detectDelimiter('a,b\n1,2', 'x.csv'), ',');
  assert.equal(detectDelimiter('a\tb', 'x.tsv'), '\t');
  assert.equal(detectDelimiter('одне слово', 'x.csv'), ',');
  const t = parse('h\n1\n2\n3\n4\n', ',', 3);
  assert.equal(t.rows.length, 3);
  assert.equal(t.truncated, true);
  assert.deepEqual(['10', '9', '2'].sort(compare), ['2', '9', '10']);
  assert.deepEqual(['b', 'a10', 'a2'].sort(compare), ['a2', 'a10', 'b']);
  assert.equal(parse('', ',').rows.length, 0);
  assert.doesNotThrow(() => parse('"незакрита,лапка\nабв', ','));
});
