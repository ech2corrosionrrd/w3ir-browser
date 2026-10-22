'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { checkUrl, explainTx, translate, summarize, DEFAULT_URL } = require(path.join(__dirname, '..', '..', 'src', 'ollama.js'));

test('ollama: checkUrl валідує локальні адреси та блокує небезпечні', () => {
  // Коректні локальні адреси
  assert.equal(checkUrl().ok, true);
  assert.equal(checkUrl(DEFAULT_URL).ok, true);
  assert.equal(checkUrl('http://127.0.0.1:11434').base, 'http://127.0.0.1:11434');
  assert.equal(checkUrl('http://localhost:11434').base, 'http://localhost:11434');
  assert.equal(checkUrl('http://[::1]:11434').base, 'http://[::1]:11434');

  // Відхилення не-локальних адрес (дані не повинні залишати ПК)
  assert.equal(checkUrl('http://example.com:11434').ok, false);
  assert.equal(checkUrl('http://192.168.1.50:11434').ok, false);
  assert.equal(checkUrl('http://8.8.8.8:11434').ok, false);

  // Відхилення незахищених протоколів або протоколів відмінних від http
  assert.equal(checkUrl('https://127.0.0.1:11434').ok, false);
  assert.equal(checkUrl('ftp://127.0.0.1:11434').ok, false);

  // Відхилення логіна/пароля в URL
  assert.equal(checkUrl('http://admin:secret@127.0.0.1:11434').ok, false);

  // Відхилення шляхів, параметрів та хешів
  assert.equal(checkUrl('http://127.0.0.1:11434/api').ok, false);
  assert.equal(checkUrl('http://127.0.0.1:11434/?q=1').ok, false);
  assert.equal(checkUrl('http://127.0.0.1:11434/#hash').ok, false);

  // Відхилення некоректних портів
  assert.equal(checkUrl('http://127.0.0.1:70000').ok, false);
  assert.equal(checkUrl('http://127.0.0.1:0').ok, false);
});

test('ollama: explainTx, translate, summarize перевіряють вхідні параметри', async () => {
  // explainTx без даних
  await assert.rejects(
    async () => explainTx('http://127.0.0.1:11434', { model: 'qwen2.5:3b', tx: null }),
    /Немає даних транзакції/
  );

  // translate без тексту
  await assert.rejects(
    async () => translate('http://127.0.0.1:11434', { model: 'qwen2.5:3b', text: '' }),
    /Немає тексту для перекладу/
  );

  // summarize без тексту
  await assert.rejects(
    async () => summarize('http://127.0.0.1:11434', { model: 'qwen2.5:3b', text: '' }),
    /Немає тексту/
  );

  // Відхилення виклику без моделі
  await assert.rejects(
    async () => explainTx('http://127.0.0.1:11434', { model: '', tx: { lines: [] } }),
    /Виберіть модель/
  );
});
