'use strict';
// Unit-тести шифрування та відновлення резервної копії гаманця без Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const backup = require(path.join(__dirname, '..', '..', 'src', 'wallet-backup.js'));

test('wallet-backup: валідація пароля при створенні резервної копії', () => {
  const sample = { v: 1, mnemonic: 'test test test test test test test test test test test junk' };

  assert.throws(() => backup.encryptBackup(sample, ''), /щонайменше 12 символів/);
  assert.throws(() => backup.encryptBackup(sample, 'short-pwd'), /щонайменше 12 символів/);
  assert.throws(() => backup.encryptBackup(sample, null), /щонайменше 12 символів/);
  assert.throws(() => backup.encryptBackup(sample, 123456789012), /щонайменше 12 символів/);
  assert.throws(() => backup.encryptBackup(sample, '12345678901'), /щонайменше 12 символів/); // 11 chars
});

test('wallet-backup: успішне шифрування й розшифрування (round trip)', () => {
  const sample = {
    v: 1,
    createdAt: 1729000000000,
    mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    passphrase: 'extra-secret-phrase',
    accounts: 3,
    names: ['Основний', 'Сейф', 'NFT'],
    contacts: [{ name: 'Alice', address: '0x1111111111111111111111111111111111111111' }],
  };
  const password = 'Correct-Horse-Battery-Staple-2026!';

  const encrypted = backup.encryptBackup(sample, password);
  assert.ok(Buffer.isBuffer(encrypted));
  assert.ok(encrypted.length > 50);

  // Перевірка магічного заголовка
  assert.equal(encrypted.subarray(0, 8).toString('latin1'), 'W3IRBK1\n');

  // Успішне розшифрування
  const decrypted = backup.decryptBackup(encrypted, password);
  assert.deepEqual(decrypted, sample);
});

test('wallet-backup: хибний пароль або пошкодження даних відхиляються', () => {
  const sample = { test: 'hello world' };
  const password = 'ValidPassword123!';
  const encrypted = backup.encryptBackup(sample, password);

  // Хибний пароль
  assert.throws(() => backup.decryptBackup(encrypted, 'WrongPassword999!'), /Хибний пароль або файл пошкоджено/);

  // Порожній пароль
  assert.throws(() => backup.decryptBackup(encrypted, ''), /Вкажіть пароль резервної копії/);
  assert.throws(() => backup.decryptBackup(encrypted, null), /Вкажіть пароль резервної копії/);

  // Пошкодження байтів шифротексту
  const corrupted = Buffer.from(encrypted);
  corrupted[corrupted.length - 1] ^= 0x55;
  assert.throws(() => backup.decryptBackup(corrupted, password), /Хибний пароль або файл пошкоджено/);

  // Пошкодження тегу автентифікації
  const corruptedTag = Buffer.from(encrypted);
  corruptedTag[8 + 16 + 12] ^= 0xff;
  assert.throws(() => backup.decryptBackup(corruptedTag, password), /Хибний пароль або файл пошкоджено/);
});

test('wallet-backup: валідація формату та розміру файлу', () => {
  const pwd = 'ValidPassword123!';

  // Не є Buffer
  assert.throws(() => backup.decryptBackup('not a buffer', pwd), /Це не файл резервної копії W3IR/);
  assert.throws(() => backup.decryptBackup(null, pwd), /Це не файл резервної копії W3IR/);

  // Занадто короткий буфер
  assert.throws(() => backup.decryptBackup(Buffer.from('W3IRBK1\nshort'), pwd), /Це не файл резервної копії W3IR/);

  // Неправильний магічний заголовок
  const fake = Buffer.alloc(100);
  assert.throws(() => backup.decryptBackup(fake, pwd), /Це не файл резервної копії W3IR/);

  // Перевищення максимального розміру
  const oversize = Buffer.alloc(backup.MAX_FILE + 1);
  fake.copy(oversize);
  assert.throws(() => backup.decryptBackup(oversize, pwd), /Це не файл резервної копії W3IR/);
});
