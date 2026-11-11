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
const { needsConfirm, confirmModeFor, CONFIRM_MODES } = require(path.join(__dirname, '..', '..', 'src', 'agent.js'));
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

test('спільна вкладка: кожна дія незалежно від режиму, власне вікно агента — за налаштуванням', () => {
  const share = { id: 1001, mode: 'control' };
  for (const mode of CONFIRM_MODES) {
    assert.equal(confirmModeFor(mode, share), 'all', mode);
    assert.equal(confirmModeFor(mode, null), mode, mode);
    for (const kind of ['click', 'type', 'submit', 'press', 'select']) assert.equal(needsConfirm(confirmModeFor(mode, share), kind, { label: 'Натисни' }), true, mode + ' ' + kind);
  }
  assert.equal(needsConfirm(confirmModeFor('risky', null), 'click', { label: 'Натисни' }), false);
  assert.equal(needsConfirm(confirmModeFor('risky', null), 'type', {}), false);
});
