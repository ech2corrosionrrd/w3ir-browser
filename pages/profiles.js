
'use strict';
const COLORS = ['#5a8dee', '#e5675f', '#4caf8a', '#d8963a', '#a078f0', '#3aa7c9', '#c8639b', '#7a8a99'];
const call = (name, arg) => w3ir.invoke(name, arg);

async function render() {
  const r = await call('profiles:list');
  app.textContent = '';
  const listEl = h('div', { class: 'list' });
  for (const p of r.profiles) {
    const isCurrent = p.id === r.current;
    listEl.append(h('div', { class: 'item' },
      h('span', { class: 'dot', style: 'background:' + p.color }),
      h('div', { class: 'main' },
        h('div', { class: 't' }, p.name, isCurrent ? ' (поточний)' : ''),
        h('div', { class: 's' }, p.id === 'default' ? 'Основний профіль' : 'Окремі закладки, історія, паролі, cookie й налаштування', p.open ? ' · відкрито' : '')),
      isCurrent ? '' : h('button', { class: 'link', onclick: async () => { await call('profiles:open', { id: p.id }); render(); } }, 'Відкрити'),
      h('button', { class: 'link', onclick: async () => {
        const v = await ask('Перейменувати профіль', [{ name: 'name', label: 'Назва', value: p.name }], { okText: 'Зберегти' });
        if (!v) return;
        const x = await call('profiles:rename', { id: p.id, name: v.name });
        if (!x.ok) alert(x.error); else render();
      } }, 'Перейменувати'),
      p.id === 'default' ? '' : h('button', { class: 'link', onclick: async () => {
        const x = await call('profiles:remove', { id: p.id });
        if (!x.ok && x.error) alert(x.error);
        render();
      } }, '✕')));
  }

  let color = COLORS[r.profiles.length % COLORS.length];
  const swatches = h('div', { class: 'swatches' }, COLORS.map(c => {
    const b = h('button', { class: 'swatch' + (c === color ? ' sel' : ''), style: 'background:' + c, title: c, onclick: () => {
      color = c;
      swatches.querySelectorAll('.swatch').forEach(x => x.classList.toggle('sel', x === b));
    } });
    return b;
  }));
  const name = h('input', { type: 'text', placeholder: 'Назва нового профілю (наприклад, Робота)', maxLength: 40 });
  const err = h('div', { class: 'merr' });
  const create = async () => {
    const x = await call('profiles:create', { name: name.value, color, open: true });
    if (!x.ok) { err.textContent = x.error; return; }
    render();
  };
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });

  app.append(
    h('h1', null, 'Профілі'),
    h('p', { class: 'note' }, 'Кожен профіль — окремий «браузер»: власні cookie й вхід на сайтах, закладки, історія, менеджер паролів і синхронізація. Зручно розділяти роботу й особисте.'),
    listEl,
    h('h2', null, 'Новий профіль'),
    h('div', { class: 'card', style: 'max-width:none;margin:0' }, name, swatches, err, h('button', { class: 'primary', onclick: create }, 'Створити та відкрити')));
}
render();
