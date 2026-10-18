'use strict';
// PDF-інструменти: усі файли обирає діалог головного процесу; сторінка бачить лише id, назви й кількість сторінок.
let docs = [];
const selected = new Set();
let sig = '';
let source = null;
let limits = { files: 20, fileMb: 200, totalMb: 400, pages: 5000 };

const ERR = {
  path: 'Недопустимий шлях або ім\'я файлу', read: 'Не вдалося прочитати файл', big: 'Файл завеликий (максимум {0} МБ)',
  signature: 'Це не PDF-файл (немає сигнатури %PDF-)', encrypted: 'PDF зашифрований: зніміть пароль у джерелі', broken: 'PDF пошкоджений або не читається',
  pages: 'Забагато сторінок', files: 'Забагато файлів у списку', select: 'Виберіть файли для цієї дії', total: 'Сумарний розмір файлів завеликий',
  range: 'Некоректні номери сторінок', empty: 'У результаті не лишилося сторінок', angle: 'Некоректний кут повороту', image: 'Зображення підпису недійсне (потрібен PNG або JPEG до 5 МБ)',
  same: 'Не можна перезаписувати вхідний файл: оберіть інше ім\'я', write: 'Не вдалося записати файл', canceled: 'Скасовано', tab: 'Немає вкладки для збереження: відкрийте цей розділ із меню потрібної сторінки',
  print: 'Не вдалося зберегти сторінку в PDF', ranges: 'Некоректний діапазон сторінок', 'already-pdf': 'Це вже PDF: збережіть його кнопками переглядача', fail: 'Не вдалося виконати дію',
  timeout: 'Обробка PDF перевищила час очікування: спробуйте менший файл', worker: 'Обробка PDF завершилася помилкою: спробуйте менший файл', memory: 'Не вистачило пам\'яті для обробки PDF',
};
const errText = (code) => t(ERR[code] || ERR.fail, limits.fileMb);

const statusEl = h('div', { class: 'note', role: 'status' });
const showBtn = h('button', { class: 'link', hidden: true, onclick: () => w3ir.invoke('pdf:show') }, 'Показати в папці');
const say = (msg, bad) => { statusEl.textContent = msg; statusEl.style.color = bad ? 'var(--danger)' : 'var(--ok)'; showBtn.hidden = true; };
const done = (r) => {
  if (!r.ok) { if (r.error !== 'canceled') say(errText(r.error), true); else say(errText('canceled'), false); return; }
  const n = r.files.length;
  let m = n === 1 ? t('Готово: {0}', r.files[0]) : t('Готово: створено файлів — {0}', n);
  if (r.removedActions) m += ' · ' + t('Прибрано небезпечних дій: {0}', r.removedActions);
  say(m, false);
  showBtn.hidden = false;
};

const text = (ph, w) => h('input', { type: 'text', placeholder: ph, autocomplete: 'off', spellcheck: false, class: w || '' });
const field = (label, input) => h('label', { class: 'mfield' }, h('span', null, label), input);
const sel = (opts) => h('select', null, opts.map(([v, l]) => h('option', { value: v }, l)));

const listEl = h('div');
const chosen = () => docs.filter(d => selected.has(d.id));
const ids = () => chosen().map(d => d.id);
const one = () => { const c = chosen(); if (c.length !== 1) { say(t('Виберіть рівно один файл'), true); return null; } return c[0]; };

function setDocs(next) {
  const old = new Set(docs.map(d => d.id));
  docs = next;
  for (const d of docs) if (!old.has(d.id)) selected.add(d.id);
  for (const id of [...selected]) if (!docs.some(d => d.id === id)) selected.delete(id);
  render();
}

function render() {
  listEl.textContent = '';
  if (!docs.length) { listEl.append(h('div', { class: 'empty' }, 'Додайте один або кілька PDF-файлів')); return; }
  listEl.append(h('div', { class: 'list' }, docs.map((d, i) => h('div', { class: 'item' },
    h('input', { type: 'checkbox', checked: selected.has(d.id), 'aria-label': d.name, onchange: (e) => { if (e.target.checked) selected.add(d.id); else selected.delete(d.id); } }),
    h('div', { class: 'main' }, h('div', { class: 't' }, d.name), h('div', { class: 's' }, t('{0} стор. · {1}', d.pages, fmtBytes(d.size)))),
    h('button', { class: 'link', title: 'Вище', disabled: i === 0, onclick: () => move(d.id, 'up') }, '↑'),
    h('button', { class: 'link', title: 'Нижче', disabled: i === docs.length - 1, onclick: () => move(d.id, 'down') }, '↓'),
    h('button', { class: 'link', title: 'Прибрати зі списку', onclick: () => w3ir.invoke('pdf:remove', { id: d.id }).then(r => setDocs(r.docs)) }, '✕')))));
}

const move = (id, dir) => w3ir.invoke('pdf:move', { id, dir }).then(r => setDocs(r.docs));

async function add() {
  const r = await w3ir.invoke('pdf:add');
  if (!r.ok) return say(errText(r.error), true);
  setDocs(r.docs);
  if (r.rejected && r.rejected.length) say(r.rejected.map(x => `${x.name}: ${errText(x.error)}`).join(' · '), true);
  else say(t('Додано файлів: {0}', r.docs.length), false);
}

// ----- злиття -----
const mergeBtn = h('button', { class: 'primary', onclick: async () => {
  if (ids().length < 2) return say(t('Виберіть щонайменше два файли'), true);
  done(await w3ir.invoke('pdf:run', { op: 'merge', ids: ids(), strip: strip.checked }));
} }, 'Об\'єднати вибрані…');

// ----- редагування -----
const strip = h('input', { type: 'checkbox' });
const pages = text('напр. 3,1-2,5- (порожньо — усі)');
const remove = text('напр. 2,4-6');
const angle = sel([['0', 'Без повороту'], ['90', 'На 90° за годинниковою'], ['180', 'На 180°'], ['270', 'На 90° проти годинникової']]);
const rotPages = text('номери в результаті (порожньо — усі)');
const sigName = h('span', { class: 'note' });
const sigPage = text('1');
sigPage.value = '1';
const sigPos = sel([['br', 'Внизу праворуч'], ['bc', 'Внизу по центру'], ['bl', 'Внизу ліворуч'], ['tr', 'Угорі праворуч'], ['tc', 'Угорі по центру'], ['tl', 'Угорі ліворуч'], ['c', 'По центру']]);
const sigWidth = text('25');
sigWidth.value = '25';
const sigOn = h('input', { type: 'checkbox' });

const setSig = (name) => { sig = name || ''; sigName.textContent = sig ? t('Підпис: {0}', sig) : t('Зображення не вибрано'); if (!sig) sigOn.checked = false; };

const editBtn = h('button', { class: 'primary', onclick: async () => {
  const d = one();
  if (!d) return;
  const arg = { op: 'edit', ids: [d.id], pages: pages.value, remove: remove.value, angle: Number(angle.value), rotatePages: rotPages.value, strip: strip.checked };
  if (sigOn.checked) {
    if (!sig) return say(errText('image'), true);
    arg.sig = { page: Number(sigPage.value), pos: sigPos.value, width: Number(sigWidth.value) };
  }
  done(await w3ir.invoke('pdf:run', arg));
} }, 'Зберегти результат…');

// ----- розділення -----
const splitMode = sel([['ranges', 'За діапазонами (кожен — окремий файл)'], ['every', 'Кожні N сторінок']]);
const splitVal = text('напр. 1-3,4-6,7-');
splitMode.addEventListener('change', () => { splitVal.placeholder = splitMode.value === 'every' ? 'N, напр. 5' : 'напр. 1-3,4-6,7-'; });
const splitBtn = h('button', { class: 'primary', onclick: async () => {
  const d = one();
  if (!d) return;
  done(await w3ir.invoke('pdf:run', { op: 'split', ids: [d.id], mode: splitMode.value, ranges: splitVal.value, every: Number(splitVal.value), strip: strip.checked }));
} }, 'Розділити в папку…');

// ----- вкладка → PDF -----
const srcInfo = h('div', { class: 'note' });
const tabRanges = text('напр. 1-3,5 (порожньо — усі сторінки)');
const tabBtn = h('button', { class: 'primary', onclick: async () => {
  const r = await w3ir.invoke('pdf:savePage', { ranges: tabRanges.value });
  if (r.ok) { say(t('Готово: {0}', r.files[0]), false); showBtn.hidden = true; } else say(errText(r.error), true);
} }, 'Зберегти вкладку як PDF…');

function renderSource() {
  srcInfo.textContent = source ? t('Вкладка: {0} ({1})', source.title || source.host, source.host) : t('Щоб зберегти вкладку, відкрийте цю сторінку з меню потрібної вкладки (меню → PDF-інструменти).');
  tabBtn.disabled = !source;
}

app.append(
  h('h1', null, 'PDF-інструменти'),
  h('p', { class: 'note' }, t('Усе виконується на вашому комп\'ютері, файли нікуди не надсилаються. Ліміти: до {0} файлів, до {1} МБ кожен.', limits.files, limits.fileMb)),
  h('h2', null, 'Файли'),
  h('div', { class: 'bar' }, h('button', { class: 'primary', onclick: add }, 'Додати PDF…'),
    h('button', { onclick: () => w3ir.invoke('pdf:clear').then(r => { setDocs(r.docs); setSig(''); }) }, 'Очистити список')),
  listEl,
  h('div', { class: 'bar' }, statusEl, showBtn),
  h('h2', null, 'Злиття'),
  h('p', { class: 'note' }, 'Файли поєднуються в порядку списку (кнопки ↑ ↓).'),
  h('div', { class: 'tools' }, mergeBtn),
  h('h2', null, 'Сторінки одного файлу'),
  h('p', { class: 'note' }, 'Виберіть один файл. Номери сторінок — з 1: «3,1-2» змінює порядок, «5-1» розвертає. Вилучені сторінки не лишаються у файлі.'),
  field('Залишити/переставити сторінки', pages),
  field('Видалити сторінки', remove),
  field('Поворот', angle), field('Повернути сторінки', rotPages),
  h('h2', null, 'Підпис зображенням'),
  h('div', { class: 'tools' }, h('button', { onclick: async () => { const r = await w3ir.invoke('pdf:sig'); if (r.ok) setSig(r.sig); else say(errText(r.error), true); } }, 'Вибрати зображення (PNG/JPEG)…'),
    h('button', { class: 'link', onclick: () => w3ir.invoke('pdf:sigClear').then(() => setSig('')) }, 'Прибрати'), sigName),
  h('label', { class: 'mfield' }, sigOn, ' Додати підпис до результату'),
  field('Сторінка результату', sigPage), field('Розташування', sigPos), field('Ширина, % сторінки (5–80)', sigWidth),
  h('h2', null, 'Метадані'),
  h('label', { class: 'mfield' }, strip, ' Прибрати метадані (автор, програма, дати, XMP) — для злиття, редагування й розділення'),
  h('div', { class: 'tools' }, editBtn),
  h('h2', null, 'Розділення'),
  field('Режим', splitMode), field('Діапазони або N', splitVal),
  h('div', { class: 'tools' }, splitBtn),
  h('h2', null, 'Вкладка як PDF'),
  srcInfo, field('Діапазон сторінок', tabRanges),
  h('div', { class: 'tools' }, tabBtn),
  h('p', { class: 'note' }, 'Заповнення форм і анотації: відкрийте PDF у вкладці — вбудований переглядач сам заповнює форми, а кнопка збереження в ньому записує копію. Інструменти тут не змінюють оригінал: результат завжди зберігається в новий файл. Закладки, форми й теги в результаті не переносяться; дії JavaScript, запуску файлів і надсилання форм прибираються.'));

w3ir.invoke('pdf:state').then((r) => {
  if (!r.ok) return;
  limits = r.limits || limits;
  source = r.source;
  setDocs(r.docs);
  setSig(r.sig);
  renderSource();
});
render();
setSig('');
renderSource();