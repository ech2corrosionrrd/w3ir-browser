'use strict';
// Перегляд Markdown-файлу: відрисований вигляд або вихідний текст, розмір шрифту, тема, друк і збереження в PDF.
// Розмітка будується з екранованого HTML (pages/markdown.js), а потім ще раз проходить через білий список тегів.
const ALLOWED = new Set('a,blockquote,br,code,del,em,h1,h2,h3,h4,h5,h6,hr,img,input,li,ol,p,pre,strong,table,tbody,td,th,thead,tr,ul'.split(','));
const ATTRS = { a: ['href', 'title', 'rel'], img: ['src', 'alt', 'title'], ol: ['start'], td: ['style'], th: ['style'], code: ['class'], input: ['type', 'disabled', 'checked'] };
const ALIGN = /^text-align:(left|center|right)$/;

function clean(parent) {
  for (const n of [...parent.childNodes]) {
    if (n.nodeType === 3) continue;
    if (n.nodeType !== 1) { n.remove(); continue; }
    const tag = n.tagName.toLowerCase();
    if (!ALLOWED.has(tag)) { n.remove(); continue; }
    clean(n);
    for (const a of [...n.attributes]) {
      const name = a.name.toLowerCase(), v = a.value;
      const ok = (ATTRS[tag] || []).includes(name)
        && !(name === 'href' && !/^(https?:|mailto:|#)/i.test(v))
        && !(name === 'src' && !/^https?:/i.test(v))
        && !(name === 'style' && !ALIGN.test(v))
        && !(name === 'type' && v !== 'checkbox')
        && !(name === 'class' && !/^lang-[\w+#.-]*$/.test(v));
      if (!ok) n.removeAttribute(a.name);
    }
    if (tag === 'a') n.setAttribute('target', '_blank');
  }
}

function load(key, def) { try { return localStorage.getItem('doc.' + key) || def; } catch { return def; } }
function save(key, v) { try { localStorage.setItem('doc.' + key, v); } catch { /* ignore */ } }

async function main() {
  const doc = await w3ir.invoke('doc:get');
  const tools = document.getElementById('tools');
  if (!doc) { app.append(h('div', { class: 'empty' }, 'Немає документа для перегляду.')); return; }
  const title = Markdown.titleOf(doc.text) || doc.name;
  document.title = title;

  let size = Number(load('size', 17)), source = false;
  const view = h('article', { class: 'md' });
  const draw = () => {
    document.body.style.setProperty('--size', size + 'px');
    document.body.classList.toggle('light', load('theme', matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') === 'light');
    view.replaceChildren();
    if (source) view.append(h('pre', { class: 'src' }, doc.text));
    else {
      const body = new DOMParser().parseFromString(Markdown.render(doc.text), 'text/html').body;
      clean(body);
      view.append(...body.childNodes);
    }
  };
  const toggleSource = h('button', { onclick: () => { source = !source; toggleSource.textContent = source ? 'Вигляд' : 'Текст'; draw(); }, title: 'Перемкнути між відрисованим виглядом і вихідним текстом' }, 'Текст');
  tools.append(
    h('span', { class: 'name', title: doc.file }, doc.name),
    h('button', { onclick: () => { size = Math.max(12, size - 1); save('size', size); draw(); }, title: 'Менший шрифт' }, 'A−'),
    h('button', { onclick: () => { size = Math.min(30, size + 1); save('size', size); draw(); }, title: 'Більший шрифт' }, 'A+'),
    h('button', { onclick: () => { save('theme', load('theme', 'dark') === 'light' ? 'dark' : 'light'); draw(); }, title: 'Тема' }, '◐'),
    toggleSource,
    h('button', { onclick: () => w3ir.invoke('doc:print'), title: 'Друк (Ctrl+P)' }, 'Друк'),
    h('button', { onclick: () => w3ir.invoke('doc:savePdf'), title: 'Зберегти документ як PDF' }, 'У PDF'));
  app.append(view);
  draw();
}
main();
