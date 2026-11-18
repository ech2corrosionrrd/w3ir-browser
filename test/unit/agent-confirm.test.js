'use strict';
// Unit-тести правил покрокових дозволів ШІ-агента (needsConfirm) і автовимкнення без Electron.
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
const agentMod = require(path.join(__dirname, '..', '..', 'src', 'agent.js'));
const { needsConfirm, confirmModeFor, CONFIRM_MODES } = agentMod;
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

test('автовимкнення: варіанти, типове значення і простій', () => {
  const { AUTO_OFF_HOURS, autoOffHours, idleExpired } = agentMod;
  assert.deepEqual(AUTO_OFF_HOURS, [0, 1, 2, 4, 8, 24]);
  assert.equal(autoOffHours(undefined), 2);
  assert.equal(autoOffHours('3'), 2);
  assert.equal(autoOffHours(0), 0);
  assert.equal(autoOffHours('8'), 8);
  const H = 3600 * 1000;
  assert.equal(idleExpired(0, 2, 2 * H - 1), false);
  assert.equal(idleExpired(0, 2, 2 * H), true);
  assert.equal(idleExpired(5 * H, 2, 6 * H), false);
  assert.equal(idleExpired(0, 0, 1000 * H), false);
});

test('Claude Code: пошук claude.exe, аргументи і приховування токена', () => {
  const { findClaude, claudeArgs, hideToken, CLAUDE_NAME } = agentMod;
  const has = (set) => (p) => set.has(p);
  const win = path.win32;
  const a = win.join('C:\\Tools', 'claude.exe');
  assert.equal(findClaude({ PATH: 'C:\\Windows;C:\\Tools' }, 'win32', has(new Set([a]))), a);
  const home = win.join('C:\\Users\\U', '.local', 'bin', 'claude.exe');
  assert.equal(findClaude({ PATH: '', USERPROFILE: 'C:\\Users\\U' }, 'win32', has(new Set([home]))), home);
  assert.equal(findClaude({ PATH: 'C:\\npm' }, 'win32', has(new Set([win.join('C:\\npm', 'claude.cmd')]))), '');
  assert.equal(findClaude({ PATH: '/usr/bin:/opt/x' }, 'linux', has(new Set(['/opt/x/claude']))), '/opt/x/claude');
  const r = claudeArgs(47821, 'TOK');
  assert.equal(CLAUDE_NAME, 'w3ir-browser');
  assert.deepEqual(r.remove, ['mcp', 'remove', 'w3ir-browser', '--scope', 'user']);
  assert.deepEqual(r.add, ['mcp', 'add', '--transport', 'http', '--scope', 'user', 'w3ir-browser', 'http://127.0.0.1:47821/mcp', '--header', 'Authorization: Bearer TOK']);
  assert.equal(hideToken('claude mcp add … Bearer TOK failed TOK', 'TOK'), 'claude mcp add … Bearer *** failed ***');
  assert.equal(hideToken('x', ''), 'x');
});
