'use strict';
const BAD_TAGS = 'script,style,iframe,object,embed,form,input,button,select,textarea,link,meta,base,svg,math,noscript,audio,source';

function sanitize(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll(BAD_TAGS).forEach(n => n.remove());
  doc.querySelectorAll('*').forEach(n => {
    for (const a of [...n.attributes]) {
      const name = a.name.toLowerCase();
      if (name.startsWith('on') || name === 'style' || name === 'srcdoc') n.removeAttribute(a.name);
      else if ((name === 'href' || name === 'src') && !/^(https?:|data:image\/|#|\/)/i.test(a.value.trim())) n.removeAttribute(a.name);
    }
    if (n.tagName === 'A') { n.removeAttribute('target'); n.setAttribute('rel', 'noopener noreferrer'); }
  });
  return doc.body;
}

function load(key, def) {
  if (key === 'theme') def = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  try { return localStorage.getItem('reader.' + key) || def; } catch { return def; }
}
function save(key, v) { try { localStorage.setItem('reader.' + key, v); } catch {} }

async function main() {
  const art = await w3ir.invoke('reader:get');
  const tools = document.getElementById('tools');
  if (!art) { app.append(h('div', { class: 'empty' }, 'Немає даних для режиму читання.')); return; }
  document.title = art.title || 'Режим читання';

  let size = Number(load('size', 19));
  const apply = () => {
    document.body.style.setProperty('--size', size + 'px');
    document.body.classList.toggle('light', load('theme', 'dark') === 'light');
    document.body.classList.toggle('sepia', load('theme', 'dark') === 'sepia');
    document.body.classList.toggle('sans', load('font', 'serif') === 'sans');
  };
  const cycle = (key, values) => () => { save(key, values[(values.indexOf(load(key, values[0])) + 1) % values.length]); apply(); };
  tools.append(
    h('button', { onclick: () => { size = Math.max(13, size - 1); save('size', size); apply(); }, title: 'Менший шрифт' }, 'A−'),
    h('button', { onclick: () => { size = Math.min(32, size + 1); save('size', size); apply(); }, title: 'Більший шрифт' }, 'A+'),
    h('button', { onclick: cycle('font', ['serif', 'sans']), title: 'Шрифт' }, 'Aa'),
    h('button', { onclick: cycle('theme', ['dark', 'light', 'sepia']), title: 'Тема' }, '◐'),
    h('button', { onclick: () => { location.href = art.url; }, title: 'Оригінал сторінки' }, 'Оригінал'));

  app.append(
    h('h1', null, art.title || ''),
    h('div', { class: 'meta' }, [art.byline, art.siteName].filter(Boolean).join(' · ')));
  const body = sanitize(art.content);
  const box = h('div');
  while (body.firstChild) box.append(body.firstChild);
  app.append(box);
  apply();
}
main();
