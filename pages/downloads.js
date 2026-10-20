'use strict';
const act = (id, action) => w3ir.invoke('downloads:action', { id, action }).then(load);
const search = h('input', { type: 'search', class: 'wfilter-input', placeholder: 'Пошук завантажень…', spellcheck: false });
const clearBtn = h('button', { onclick: () => act('', 'clear') }, 'Очистити список');
const listEl = h('div');
app.append(h('h1', null, 'Завантаження'), h('div', { class: 'bar', style: 'margin-bottom:12px' }, search, clearBtn), listEl);

const STATE = { completed: 'Завершено', cancelled: 'Скасовано', interrupted: 'Перервано', paused: 'Призупинено' };

const fileIcon = (name) => {
  const ext = (name || '').split('.').pop().toLowerCase();
  if (['pdf', 'doc', 'docx', 'txt', 'rtf'].includes(ext)) return '📄';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '📦';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(ext)) return '🖼️';
  if (['mp4', 'webm', 'mkv', 'avi', 'mov'].includes(ext)) return '🎬';
  if (['mp3', 'wav', 'ogg', 'flac'].includes(ext)) return '🎵';
  if (['exe', 'msi', 'bat', 'cmd'].includes(ext)) return '⚙️';
  if (['json', 'csv', 'tsv', 'xml'].includes(ext)) return '📊';
  return '📁';
};

let cached = [];
let lastSig = '';
function render() {
  const q = search.value.toLowerCase().trim();
  const items = cached.filter(d => !q || (d.filename || '').toLowerCase().includes(q));
  listEl.textContent = '';
  if (!items.length) { listEl.append(h('div', { class: 'empty' }, cached.length ? 'Нічого не знайдено' : 'Завантажень поки немає')); return; }
  listEl.append(h('div', { class: 'list' }, items.map(d => {
    const active = d.state === 'progressing' || d.state === 'paused';
    const status = active
      ? `${fmtBytes(d.received)}${d.total > 0 ? ` з ${fmtBytes(d.total)}` : ''}${d.state === 'paused' ? ' · призупинено' : ''}`
      : `${STATE[d.state] || d.state} · ${fmtBytes(d.total || d.received)} · ${fmtDay(d.start)}, ${fmtTime(d.start)}`;
    const icon = fileIcon(d.filename);
    return h('div', { class: 'item' },
      h('div', { class: 'item-avatar', style: 'font-size:16px' }, icon),
      h('div', { class: 'main' },
        h('div', { class: 't' }, d.state === 'completed'
          ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); act(d.id, 'open'); } }, d.filename)
          : d.filename),
        h('div', { class: 's' }, status),
        active && d.total > 0 ? h('progress', { max: d.total, value: d.received }) : null),
      active
        ? [h('button', { class: 'link', onclick: () => act(d.id, d.state === 'paused' ? 'resume' : 'pause') }, d.state === 'paused' ? 'Продовжити' : 'Пауза'),
           h('button', { class: 'link', onclick: () => act(d.id, 'cancel') }, 'Скасувати')]
        : [d.path ? h('button', { class: 'link', onclick: () => act(d.id, 'show') }, 'Показати в папці') : null,
           h('button', { class: 'link', title: 'Прибрати зі списку', onclick: () => act(d.id, 'remove') }, '✕')]);
  })));
}

async function load() {
  const next = await w3ir.invoke('downloads:get');
  const sig = JSON.stringify(next);
  if (sig === lastSig) return;
  lastSig = sig;
  cached = next;
  render();
}
search.addEventListener('input', render);
load();
setInterval(() => { if (document.visibilityState === 'visible') load(); }, 1000);
