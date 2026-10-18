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
  assert.equal(docview.markdownPathFromUrl('https://e.example/a.md'), null);
  assert.equal(docview.markdownPathFromUrl('file://server/share/a.md'), null);
  assert.equal(docview.markdownPathFromUrl('file:///C:/x/a.txt'), null);
  const p = docview.markdownPathFromUrl('file:///C:/My%20Docs/a.md?x=1#h');
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
    assert.equal(docview.loadDoc(path.join(dir, 'x.txt')).error, 'type');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
