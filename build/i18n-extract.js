'use strict';
// Витягує українські рядки інтерфейсу (ключі каталогів locales/*.json) з коду й HTML.
//   node build/i18n-extract.js            — записує locales/_keys.json і показує підсумок
//   node build/i18n-extract.js --check    — звіряє каталоги з ключами (код виходу 1, якщо в мові бракує рядків)
//   node build/i18n-extract.js --concat   — показує місця, де український текст склеєно з іншими частинами через «+»
const fs = require('fs');
const path = require('path');
const espree = require('espree');

const root = path.join(__dirname, '..');
const CYR = /[\u0400-\u04FF]/;
// Файли, де українські рядки бачить користувач. agent.js, injection-guard.js, ollama.js (тексти для моделі) і журнали не перекладаються.
const SKIP = new Set(['agent.js', 'injection-guard.js', 'ollama.js', 'i18n.js', 'i18n-dom.js', 'help-data.js']);
// agent.js здебільшого описи для моделі (не перекладаються); з нього беремо лише видимі користувачу рядки
const AGENT_VISIBLE = new Set(['title', 'label', 'message', 'detail']);
const dirs = [['src', '.js'], ['pages', '.js'], ['ui', '.js'], ['', '.js'], ['pages', '.html'], ['ui', '.html']];

const keys = new Map(); // ключ → [файл:рядок]
const concat = [];
const add = (k, loc) => {
  const key = k.replace(/\s+/g, ' ').trim();
  if (!key || !CYR.test(key) || key.includes('navigator.credentials')) return;
  if (!keys.has(key)) keys.set(key, []);
  keys.get(key).push(loc);
};

// журнали (this.log('error', '…')) не перекладаються
const isLogCall = (n) => n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.property.name === 'log' && n.arguments[0] && n.arguments[0].type === 'Literal';

function walk(node, file, visit) {
  if (!node || typeof node.type !== 'string') return;
  if (isLogCall(node)) return;
  visit(node);
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach(c => c && c.type && walk(c, file, visit)); else if (v && v.type) walk(v, file, visit);
  }
}

function jsFile(file, rel, onlyVisible) {
  const src = fs.readFileSync(file, 'utf8');
  let ast;
  try { ast = espree.parse(src, { ecmaVersion: 2023, loc: true, sourceType: 'commonjs' }); } catch { ast = espree.parse(src, { ecmaVersion: 2023, loc: true, sourceType: 'script' }); }
  const visible = new Set();
  if (onlyVisible) {
    walk(ast, rel, (n) => {
      const mark = (x) => { if (!x) return; if (x.type === 'ConditionalExpression') { mark(x.consequent); mark(x.alternate); } else visible.add(x); };
      if (n.type === 'Property' && !n.computed && AGENT_VISIBLE.has(n.key.name || n.key.value)) mark(n.value);
      if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.property.name === 'toast') mark(n.arguments[0]);
    });
  }
  walk(ast, rel, (n) => {
    if (onlyVisible && !visible.has(n)) return;
    const loc = `${rel}:${n.loc.start.line}`;
    if (n.type === 'Literal' && typeof n.value === 'string') add(n.value, loc);
    else if (n.type === 'TemplateLiteral') {
      let i = 0;
      const s = n.quasis.map((q, qi) => q.value.cooked + (qi < n.expressions.length ? `{${i++}}` : '')).join('');
      add(s, loc);
    } else if (n.type === 'BinaryExpression' && n.operator === '+') {
      const lit = (x) => x.type === 'Literal' && typeof x.value === 'string' && CYR.test(x.value);
      if ((lit(n.left) || lit(n.right)) && !(lit(n.left) && lit(n.right))) concat.push(`${loc}  ${(lit(n.left) ? n.left : n.right).value.slice(0, 60)}`);
    }
  });
}

function htmlFile(file, rel) {
  const src = fs.readFileSync(file, 'utf8');
  src.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/>([^<>]*[\u0400-\u04FF][^<>]*)</g)) add(m[1], `${rel}:${i + 1}`);
    for (const m of line.matchAll(/\b(?:placeholder|title|aria-label|alt)="([^"]*[\u0400-\u04FF][^"]*)"/g)) add(m[1], `${rel}:${i + 1}`);
  });
}

for (const [d, ext] of dirs) {
  const dir = path.join(root, d);
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(ext) || SKIP.has(f) || !fs.statSync(path.join(dir, f)).isFile()) continue;
    const rel = path.posix.join(d, f);
    (ext === '.js' ? jsFile : htmlFile)(path.join(dir, f), rel);
  }
}
// довідка (pages/help-data.js) — великий масив рядків; включаємо окремо, її рядки показуються через DOM
jsFile(path.join(root, 'pages', 'help-data.js'), 'pages/help-data.js');
jsFile(path.join(root, 'src', 'agent.js'), 'src/agent.js', true);

const out = {};
for (const [k, v] of [...keys].sort((a, b) => a[0].localeCompare(b[0], 'uk'))) out[k] = v.slice(0, 3);

if (process.argv.includes('--concat')) { console.log(concat.join('\n')); console.log(`\n${concat.length} місць зі склеєним текстом`); process.exit(0); }

if (process.argv.includes('--check')) {
  let bad = 0;
  for (const f of fs.readdirSync(path.join(root, 'locales'))) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    const cat = JSON.parse(fs.readFileSync(path.join(root, 'locales', f), 'utf8'));
    const missing = Object.keys(out).filter(k => !cat[k]);
    const stale = Object.keys(cat).filter(k => !(k in out));
    console.log(`${f}: ${Object.keys(out).length - missing.length}/${Object.keys(out).length} перекладено, застарілих: ${stale.length}`);
    // підстановки {n} і розмітка (**, `, посилання w3ir://) мають збігатися з оригіналом
    const ph = (x) => (x.match(/\{\d+\}/g) || []).sort().join();
    const mk = (x) => (x.match(/\*\*|`|\]\(w3ir:\/\/[a-z]+\)/g) || []).length;
    const broken = Object.keys(out).filter(k => cat[k] && (ph(k) !== ph(cat[k]) || mk(k) !== mk(cat[k])));
    if (broken.length) { bad++; console.log(broken.slice(0, 10).map(k => '  розмітка/підстановки: ' + k.slice(0, 80)).join('\n')); }
    if (missing.length) { bad++; console.log(missing.slice(0, 15).map(k => '  бракує: ' + k.slice(0, 90)).join('\n')); }
  }
  process.exit(bad ? 1 : 0);
}

fs.writeFileSync(path.join(root, 'locales', '_keys.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`Ключів: ${keys.size}; склеєних місць: ${concat.length} (node build/i18n-extract.js --concat)`);
