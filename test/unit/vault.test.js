'use strict';
// Unit-тести сховища паролів (Vault) без Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Vault, normOrigin, checkMaster, parseCsv } = require(path.join(__dirname, '..', '..', 'src', 'vault.js'));

test('vault: перевірка надійності майстер-пароля (checkMaster)', () => {
  // Коротший за 12 символів
  assert.match(checkMaster(''), /щонайменше 12 символів/);
  assert.match(checkMaster('short'), /щонайменше 12 символів/);
  assert.match(checkMaster('12345678901'), /щонайменше 12 символів/);

  // Одноманітні символи (довші за 20 символів відхиляються правилом регулярного виразу)
  assert.match(checkMaster('a'.repeat(21)), /надто простий/);
  assert.match(checkMaster('1'.repeat(25)), /надто простий/);

  // Менше 20 символів і менше 3 класів
  assert.match(checkMaster('alllowercaseno'), /Додайте великі й малі літери/);
  assert.match(checkMaster('onlylowercase123'), /Додайте великі й малі літери/);

  // Надійний пароль (>= 12 символів, 3+ класи)
  assert.equal(checkMaster('Password123!'), null);
  assert.equal(checkMaster('МайстерПароль123!'), null);
  assert.equal(checkMaster('Correct-Horse-Battery-2026'), null);

  // Довший за 20 символів приймається навіть із 2 класами
  assert.equal(checkMaster('longenoughpasswordwithmorethantwentycharacters'), null);
});

test('vault: нормалізація origin (normOrigin)', () => {
  // Безпечні HTTPS-адреси
  assert.equal(normOrigin('https://example.com/login?ref=1#top'), 'https://example.com');
  assert.equal(normOrigin('https://sub.domain.org:8443/auth'), 'https://sub.domain.org:8443');

  // Локальні адреси дозволені навіть через HTTP
  assert.equal(normOrigin('http://localhost:3000/app'), 'http://localhost:3000');
  assert.equal(normOrigin('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');

  // Відхилення небезпечних публічних HTTP та сторонніх схем
  assert.equal(normOrigin('http://insecure-site.com'), null);
  assert.equal(normOrigin('ftp://ftp.example.com'), null);
  assert.equal(normOrigin('javascript:alert(1)'), null);
  assert.equal(normOrigin('not a valid url'), null);
  assert.equal(normOrigin(''), null);
});

test('vault: парсер CSV (parseCsv)', () => {
  // Простий CSV
  const csv1 = 'url,username,password\nhttps://example.com,alice,Secret123!\nhttps://github.com,bob,Pass456?';
  const r1 = parseCsv(csv1);
  assert.equal(r1.length, 3);
  assert.deepEqual(r1[0], ['url', 'username', 'password']);
  assert.deepEqual(r1[1], ['https://example.com', 'alice', 'Secret123!']);

  // CSV з комами та лапками всередині значень
  const csv2 = 'name,url,note\n"Site, Inc.",https://site.org,"Notes with, comma and ""quotes"""';
  const r2 = parseCsv(csv2);
  assert.equal(r2.length, 2);
  assert.equal(r2[1][0], 'Site, Inc.');
  assert.equal(r2[1][2], 'Notes with, comma and "quotes"');

  // Порожні рядки та перенесення CRLF
  const csv3 = 'a,b\r\n1,2\r\n\r\n3,4\r\n';
  const r3 = parseCsv(csv3);
  assert.equal(r3.length, 3);
  assert.deepEqual(r3[2], ['3', '4']);
});

test('vault: генератор паролів (Vault.prototype.generate)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v-test-'));
  try {
    const v = new Vault({ dir: tmpDir, usePepper: false });

    // Типова довжина 20
    const p1 = v.generate();
    assert.equal(p1.length, 20);

    // Довжина 32
    const p2 = v.generate({ length: 32 });
    assert.equal(p2.length, 32);

    // Межі (мінімум 8, максимум 64)
    assert.equal(v.generate({ length: 2 }).length, 8);
    assert.equal(v.generate({ length: 100 }).length, 64);

    // Без спецсимволів
    const pNoSym = v.generate({ length: 24, symbols: false });
    assert.equal(/^[a-zA-Z0-9]+$/.test(pNoSym), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('vault: життєвий цикл сховища (create, lock, unlock, CRUD)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v-test-'));
  try {
    const v = new Vault({ dir: tmpDir, usePepper: false });

    // Початковий стан — сховища ще немає
    assert.equal(v.exists(), false);
    assert.equal(v.status(), 'none');

    // Спроба створення зі слабким паролем
    const bad = await v.create('short');
    assert.equal(bad.ok, false);
    assert.equal(v.status(), 'none');

    // Успішне створення сховища
    const master = 'MasterPassword123!';
    const ok = await v.create(master);
    assert.equal(ok.ok, true);
    assert.equal(v.exists(), true);
    assert.equal(v.status(), 'unlocked');

    // Додавання запису
    const id = v.add({
      url: 'https://github.com/login',
      username: 'developer',
      password: 'SuperSecretToken777!',
      note: 'My API access'
    });
    assert.ok(typeof id === 'string' && id.length > 0);

    // Список записів (без відкритого пароля)
    const list = v.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, id);
    assert.equal(list[0].host, 'github.com');
    assert.equal(list[0].password, undefined);

    // Отримання запису за id
    const got = v.get(id);
    assert.equal(got.origin, 'https://github.com');
    assert.equal(got.username, 'developer');
    assert.equal(got.password, 'SuperSecretToken777!');

    // Пошук за origin та username
    const found = v.find('https://github.com', 'developer');
    assert.ok(found);
    assert.equal(found.id, id);
    assert.equal(found.username, 'developer');

    // Редагування запису
    v.update(id, {
      url: 'https://github.com',
      username: 'developer-updated',
      password: 'NewSuperPassword999!'
    });
    assert.equal(v.get(id).username, 'developer-updated');
    assert.equal(v.get(id).password, 'NewSuperPassword999!');

    // Заблокувати сховище
    v.lock();
    assert.equal(v.status(), 'locked');
    assert.throws(() => v.list(), /locked/);

    // Розблокування з хибним паролем
    const wrong = await v.unlock('WrongPassword123!');
    assert.equal(wrong.ok, false);
    assert.equal(v.status(), 'locked');
    assert.match(wrong.error, /Хибний майстер-пароль/);

    // Скидаємо обмеження частоти спроб (rate limiting) для продовження тесту
    v.nextAllowed = 0;

    // Розблокування з правильним паролем
    const unlocked = await v.unlock(master);
    assert.equal(unlocked.ok, true);
    assert.equal(v.status(), 'unlocked');
    assert.equal(v.list().length, 1);

    // Видалення запису
    v.remove(id);
    assert.equal(v.list().length, 0);

    v.lock();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
