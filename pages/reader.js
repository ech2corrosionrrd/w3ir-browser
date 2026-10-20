'use strict';
// Білий список: усе, чого тут немає, прибирається; невідомі теги замінюються своїм вмістом (текст зберігається)
const ALLOWED = new Set('a,abbr,article,aside,b,blockquote,br,caption,cite,code,dd,del,details,div,dl,dt,em,figcaption,figure,h1,h2,h3,h4,h5,h6,hr,i,img,ins,kbd,li,main,mark,ol,p,picture,pre,q,s,samp,section,small,span,strong,sub,summary,sup,table,tbody,td,tfoot,th,thead,time,tr,u,ul,var,wbr'.split(','));
// Ці теги прибираються разом із вмістом
const DROP = new Set('script,style,iframe,object,embed,form,input,button,select,textarea,link,meta,base,svg,math,noscript,audio,video,source,template,frame,frameset,applet,canvas,dialog,title,head'.split(','));
const ATTRS = { a: ['href', 'title'], img: ['src', 'alt', 'title', 'width', 'height'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'], '*': ['title', 'lang', 'dir'] };
const SAFE_HREF = /^(https?:|#)/i;
const SAFE_SRC = /^(https?:|data:image\/(png|jpeg|gif|webp);)/i;

function cleanNode(parent) {
  for (const n of [...parent.childNodes]) {
    if (n.nodeType === 3) continue; // текст
    if (n.nodeType !== 1) { n.remove(); continue; } // коментарі, інструкції тощо
    const tag = n.tagName.toLowerCase();
    if (DROP.has(tag)) { n.remove(); continue; }
    cleanNode(n);
    if (!ALLOWED.has(tag)) { n.replaceWith(...n.childNodes); continue; }
    const allow = new Set([...(ATTRS[tag] || []), ...ATTRS['*']]);
    for (const a of [...n.attributes]) {
      const name = a.name.toLowerCase();
      const v = a.value.trim();
      if (!allow.has(name) || (name === 'href' && !SAFE_HREF.test(v)) || (name === 'src' && !SAFE_SRC.test(v))) n.removeAttribute(a.name);
    }
    if (tag === 'a') n.setAttribute('rel', 'noopener noreferrer');
  }
}

function sanitize(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  cleanNode(doc.body);
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
  const origHtml = box.innerHTML;
  let translatedText = '';
  let showingTranslated = false;
  const trBtn = h('button', { onclick: async () => {
    if (translatedText) {
      showingTranslated = !showingTranslated;
      if (showingTranslated) {
        box.textContent = '';
        for (const p of translatedText.split(/\n{2,}/)) if (p.trim()) box.append(h('p', null, p.trim()));
        trBtn.textContent = t('Оригінал');
      } else {
        box.textContent = '';
        const restored = sanitize(origHtml);
        while (restored.firstChild) box.append(restored.firstChild);
        trBtn.textContent = t('Перекласти (ШІ)');
      }
      return;
    }
    trBtn.disabled = true;
    const r = await w3ir.invoke('reader:translate', { text: box.innerText || box.textContent || '' });
    trBtn.disabled = false;
    if (!r || !r.ok) { alert((r && r.error) || t('Помилка')); return; }
    translatedText = r.text || '';
    showingTranslated = true;
    box.textContent = '';
    for (const p of translatedText.split(/\n{2,}/)) if (p.trim()) box.append(h('p', null, p.trim()));
    trBtn.textContent = t('Оригінал');
  }, title: 'Локальний переклад через Ollama' }, 'Перекласти (ШІ)');
  tools.append(trBtn);
  app.append(box);
  apply();
}
main();
