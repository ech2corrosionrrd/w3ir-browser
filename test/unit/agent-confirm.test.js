'use strict';
// Unit-тести правил покрокових дозволів ШІ-агента (needsConfirm) без Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// agent.js підключає electron; для unit-тесту підставляємо заглушку лише на час завантаження
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { safeStorage: {}, app: {} };
  return origLoad.call(this, request, ...rest);
};
const { needsConfirm, CONFIRM_MODES } = require(path.join(__dirname, '..', '..', 'src', 'agent.js'));
Module._load = origLoad;

test('режими підтверджень', () => {
  assert.deepEqual(CONFIRM_MODES, ['off', 'risky', 'all']);
});

test('off ніколи не питає, all питає про все', () => {
  for (const kind of ['click', 'submit', 'press', 'select']) {
    assert.equal(needsConfirm('off', kind, { submit: true }), false);
    assert.equal(needsConfirm('all', kind, {}), true);
  }
});

test('risky: кнопка надсилання форми і ризикові підписи', () => {
  assert.equal(needsConfirm('risky', 'click', { submit: true, label: 'Далі' }), true);
  for (const label of ['Купити', 'Оплатити замовлення', 'Видалити акаунт', 'Delete', 'Place order', 'Надіслати', 'Confirm transfer', 'Sign in']) {
    assert.equal(needsConfirm('risky', 'click', { label }), true, label);
  }
  for (const label of ['Натисни', 'Докладніше', 'Menu', '']) assert.equal(needsConfirm('risky', 'click', { label }), false, label);
});

test('risky: введення з відправленням завжди, Enter лише у формі, вибір зі списку ні', () => {
  assert.equal(needsConfirm('risky', 'submit', {}), true);
  assert.equal(needsConfirm('risky', 'press', { inForm: true }), true);
  assert.equal(needsConfirm('risky', 'press', { inForm: false }), false);
  assert.equal(needsConfirm('risky', 'select', {}), false);
});
