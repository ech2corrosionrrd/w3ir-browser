'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { CONTAINERS, info, valid } = require(path.join(__dirname, '..', '..', 'src', 'containers.js'));

test('containers: список CONTAINERS містить правильні структури', () => {
  assert.ok(Array.isArray(CONTAINERS));
  assert.ok(CONTAINERS.length >= 4);

  const ids = new Set();
  for (const c of CONTAINERS) {
    assert.ok(typeof c.id === 'string' && c.id.length > 0);
    assert.ok(typeof c.name === 'string' && c.name.length > 0);
    assert.ok(/^#[0-9a-fA-F]{6}$/.test(c.color), `Колір ${c.color} має бути hex`);
    assert.ok(!ids.has(c.id), `ID ${c.id} не повинен дублюватися`);
    ids.add(c.id);
  }

  // Перевірка наявності базових контейнерів
  assert.ok(ids.has('work'));
  assert.ok(ids.has('social'));
  assert.ok(ids.has('shopping'));
  assert.ok(ids.has('finance'));
});

test('containers: valid перевіряє коректність ідентифікатора', () => {
  assert.equal(valid('work'), true);
  assert.equal(valid('social'), true);
  assert.equal(valid('shopping'), true);
  assert.equal(valid('finance'), true);

  assert.equal(valid('unknown'), false);
  assert.equal(valid(''), false);
  assert.equal(valid(null), false);
  assert.equal(valid(undefined), false);
  assert.equal(valid(123), false);
  assert.equal(valid({}), false);
});

test('containers: info повертає метадані або null', () => {
  const w = info('work');
  assert.ok(w);
  assert.equal(w.id, 'work');
  assert.equal(w.name, 'Робота');
  assert.equal(w.color, '#2f7de1');

  const s = info('social');
  assert.ok(s);
  assert.equal(s.id, 'social');
  assert.equal(s.name, 'Соцмережі');

  assert.equal(info('non-existent'), null);
  assert.equal(info(''), null);
  assert.equal(info(null), null);
  assert.equal(info(undefined), null);
});
