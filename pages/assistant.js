'use strict';
// Локальний ШІ-помічник (Ollama): налаштування, запит, перебіг кроків і відповідь.
const urlInput = h('input', { type: 'text', spellcheck: false, placeholder: 'http://127.0.0.1:11434', style: 'flex:1' });
const modelSel = h('select', { style: 'min-width:220px' });
const cfgMsg = h('div', { class: 'note', style: 'margin-top:8px' });
const promptEl = h('textarea', { rows: 4, placeholder: 'Що зробити? Наприклад: «Знайди на сторінці ціни й порівняй їх»', style: 'width:100%;box-sizing:border-box' });
const runBtn = h('button', { class: 'primary', onclick: run }, 'Запитати');
const stopBtn = h('button', { class: 'danger', onclick: async () => { await w3ir.invoke('assistant:stop'); }, disabled: true }, 'Зупинити');
const shareBtn = h('button', { onclick: shareTab }, 'Дати прочитати відкриту вкладку');
const runMsg = h('div', { class: 'note', style: 'margin-top:8px' });
const stepsEl = h('div', { class: 'list' });
const answerEl = h('div', { class: 'card', style: 'max-width:none;white-space:pre-wrap;user-select:text;display:none' });
let timer = null;

app.append(
  h('h1', null, 'ШІ-помічник'),
  h('p', { class: 'note' }, 'Працює на вашому комп’ютері через Ollama: запити й вміст сторінок не залишають ПК. Нові сайти він відкриває лише з вашого дозволу у тимчасовому вікні без ваших входів; паролі й картки не вводить.'),
  h('h2', null, 'Модель'),
  h('div', { class: 'card', style: 'max-width:none;margin:0' },
    h('div', { class: 'bar' }, urlInput, h('button', { onclick: loadModels }, 'Оновити список моделей')),
    h('div', { class: 'bar', style: 'margin-top:8px' }, modelSel, h('button', { onclick: save }, 'Зберегти')),
    cfgMsg),
  h('h2', null, 'Запит'),
  h('div', { class: 'card', style: 'max-width:none;margin:0' },
    promptEl,
    h('div', { class: 'bar', style: 'margin-top:8px' }, runBtn, stopBtn, shareBtn),
    runMsg),
  h('h2', null, 'Кроки'),
  stepsEl,
  h('h2', null, 'Відповідь'),
  answerEl);

function setModels(models, current) {
  modelSel.textContent = '';
  const names = models.map(m => m.name);
  if (current && !names.includes(current)) names.unshift(current);
  if (!names.length) modelSel.append(h('option', { value: '' }, 'Моделей не знайдено'));
  for (const n of names) modelSel.append(h('option', { value: n, selected: n === current }, n));
}

async function loadModels() {
  cfgMsg.textContent = 'Перевіряю Ollama…';
  const r = await w3ir.invoke('assistant:models');
  if (!r.ok) { cfgMsg.textContent = r.error; return; }
  setModels(r.models, modelSel.value);
  cfgMsg.textContent = r.models.length ? `Знайдено моделей: ${r.models.length}` : 'Ollama працює, але моделей немає. Завантажте одну: ollama pull llama3.1';
}

async function save() {
  const r = await w3ir.invoke('assistant:save', { url: urlInput.value, model: modelSel.value });
  cfgMsg.textContent = r.ok ? 'Збережено.' : r.error;
  if (r.ok) urlInput.value = r.config.url;
}

async function shareTab() {
  runMsg.textContent = '';
  const r = await w3ir.invoke('assistant:share');
  runMsg.textContent = r.ok ? 'Помічник може читати вкладку (лише читання, до 30 хвилин). Скажіть у запиті, що її треба прочитати.' : r.error;
}

async function run() {
  runMsg.textContent = '';
  await save();
  const r = await w3ir.invoke('assistant:run', { prompt: promptEl.value });
  if (!r.ok) { runMsg.textContent = r.error; return; }
  poll();
}

function render(s) {
  runBtn.disabled = s.running;
  stopBtn.disabled = !s.running;
  stepsEl.textContent = '';
  if (!s.steps.length) stepsEl.append(h('div', { class: 'row' }, s.running ? 'Модель думає…' : 'Кроків ще немає.'));
  s.steps.forEach((st, i) => stepsEl.append(h('div', { class: 'item' }, h('div', { class: 'main' }, h('div', { class: 't' }, `${i + 1}. ${st.tool}`), h('div', { class: 's' }, st.detail || '')))));
  if (s.running && s.steps.length) stepsEl.append(h('div', { class: 'row' }, 'Модель думає…'));
  const text = s.error || s.answer;
  answerEl.style.display = text ? 'block' : 'none';
  answerEl.textContent = text;
  answerEl.classList.toggle('error', !!s.error);
}

async function poll() {
  clearTimeout(timer);
  const s = await w3ir.invoke('assistant:poll');
  if (!s.ok) { runMsg.textContent = s.error; return; }
  render(s);
  if (s.running) timer = setTimeout(poll, 700);
}

(async () => {
  const st = await w3ir.invoke('assistant:status');
  if (st.ok) {
    urlInput.value = st.config.url;
    setModels([], st.config.model);
    render(st);
    if (st.running) poll();
  }
  loadModels();
})();
