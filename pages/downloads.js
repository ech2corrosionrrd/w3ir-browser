'use strict';
const act = (id, action) => w3ir.invoke('downloads:action', { id, action }).then(load);
const clearBtn = h('button', { onclick: () => act('', 'clear') }, 'Очистити список');
const listEl = h('div');
app.append(h('h1', null, 'Завантаження'), h('div', { class: 'bar' }, h('span', { style: 'flex:1' }), clearBtn), listEl);

const STATE = { completed: 'Завершено', cancelled: 'Скасовано', interrupted: 'Перервано', paused: 'Призупинено' };

async function load() {
  const items = await w3ir.invoke('downloads:get');
  listEl.textContent = '';
  if (!items.length) { listEl.append(h('div', { class: 'empty' }, 'Завантажень поки немає')); return; }
  listEl.append(h('div', { class: 'list' }, items.map(d => {
    const active = d.state === 'progressing' || d.state === 'paused';
    const status = active
      ? `${fmtBytes(d.received)}${d.total > 0 ? ' з ' + fmtBytes(d.total) : ''}${d.state === 'paused' ? ' · призупинено' : ''}`
      : `${STATE[d.state] || d.state} · ${fmtBytes(d.total || d.received)} · ${fmtDay(d.start)}, ${fmtTime(d.start)}`;
    return h('div', { class: 'item' },
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
load();
setInterval(load, 1000);
