'use strict';
// Unit-тести сховища паролів (Vault) без Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Vault, normOrigin, checkMaster, parseCsv, sha1Password, parseHibpRange } = require(path.join(__dirname, '..', '..', 'src', 'vault.js'));

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

    // Додавання запису з TOTP 2FA
    const id = v.add({
      url: 'https://github.com/login',
      username: 'developer',
      password: 'SuperSecretToken777!',
      note: 'My API access',
      totp: 'JBSWY3DPEHPK3PXP'
    });
    assert.ok(typeof id === 'string' && id.length > 0);

    // Список записів (без відкритого пароля)
    const list = v.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, id);
    assert.equal(list[0].host, 'github.com');
    assert.equal(list[0].password, undefined);
    assert.equal(list[0].hasTotp, true);

    // Отримання запису за id
    const got = v.get(id);
    assert.equal(got.origin, 'https://github.com');
    assert.equal(got.username, 'developer');
    assert.equal(got.password, 'SuperSecretToken777!');
    assert.equal(got.totp, 'JBSWY3DPEHPK3PXP');

    // Генерація TOTP коду
    const t1 = v.getTotp(id);
    assert.equal(t1.ok, true);
    assert.match(t1.code, /^\d{6}$/);
    assert.ok(t1.remaining >= 1 && t1.remaining <= 30);
    assert.equal(v.copyTotp(id), true);

    // Пошук за origin та username
    const found = v.find('https://github.com', 'developer');
    assert.ok(found);
    assert.equal(found.id, id);
    assert.equal(found.username, 'developer');

    // Редагування запису (оновлення пароля та TOTP на URI)
    v.update(id, {
      url: 'https://github.com',
      username: 'developer-updated',
      password: 'NewSuperPassword999!',
      totp: 'otpauth://totp/GitHub:developer?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&period=30'
    });
    assert.equal(v.get(id).username, 'developer-updated');
    assert.equal(v.get(id).password, 'NewSuperPassword999!');
    const t2 = v.getTotp(id);
    assert.equal(t2.ok, true);
    assert.match(t2.code, /^\d{6}$/);

    // Спроба встановити некоректний секрет
    assert.throws(() => v.update(id, { totp: 'invalid!!secret##' }), /Некоректний секрет TOTP/);

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

    // Перевірка паролів на витоки (k-анонімність HIBP Range API)
    const { prefix, suffix } = sha1Password('NewSuperPassword999!');
    assert.equal(prefix.length, 5);
    assert.equal(suffix.length, 35);
    let requestedUrl = '';
    const mockFetch = async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        status: 200,
        text: async () => `00000000000000000000000000000000000:1\r\n${suffix}:42\r\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:5`,
      };
    };
    const br = await v.checkBreaches(mockFetch);
    assert.equal(br.ok, true);
    assert.equal(requestedUrl, `https://api.pwnedpasswords.com/range/${prefix}`);
    assert.ok(!requestedUrl.includes(suffix), 'Суфікс хеша ніколи не передається в URL');
    assert.equal(br.breachedCount, 1);
    assert.equal(br.breached[id], 42);
    assert.equal(parseHibpRange(`${suffix}:0`, suffix), 0);

    // Видалення запису
    v.remove(id);
    assert.equal(v.list().length, 0);

    v.lock();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------- міграція, відкат .bak і цілісність файлу сховища ----------
const FIXTURE = path.join(__dirname, 'fixtures', 'vault-v1.fixture.json'); // заморожений файл формату v1 (тестовий пароль)
const FIXTURE_MASTER = 'Fixture-Master-2026!';
const withVaultDir = async (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v-mig-'));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

test('vault: заморожена фікстура формату v1 відкривається поточним кодом (захист від випадкової зміни формату)', async () => {
  await withVaultDir(async (dir) => {
    fs.copyFileSync(FIXTURE, path.join(dir, 'vault.bin'));
    const v = new Vault({ dir, usePepper: false });
    const r = await v.unlock(FIXTURE_MASTER);
    assert.equal(r.ok, true, 'фікстуру v1 має бути можливо відкрити');
    const [e] = v.list();
    assert.equal(e.host, 'example.com');
    assert.equal(v.get(e.id).password, 'fixture-pass-1');
    assert.equal(v.get(e.id).totp, 'JBSWY3DPEHPK3PXP');
  });
});

test('vault: змінений заголовок чи шифртекст не відкривається; неправильний пароль не відкриває', async () => {
  await withVaultDir(async (dir) => {
    const file = path.join(dir, 'vault.bin');
    const orig = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const tries = {
      'змінено параметр KDF (r)': { ...orig, kdf: { ...orig.kdf, r: orig.kdf.r * 2 } },
      'змінено сіль': { ...orig, kdf: { ...orig.kdf, salt: Buffer.alloc(16, 1).toString('base64') } },
      'змінено шифртекст': { ...orig, ct: Buffer.from(orig.ct, 'base64').map((b, i) => (i === 3 ? b ^ 1 : b)).toString('base64') },
    };
    for (const [name, doc] of Object.entries(tries)) {
      fs.writeFileSync(file, JSON.stringify(doc));
      const v = new Vault({ dir, usePepper: false });
      assert.equal((await v.unlock(FIXTURE_MASTER)).ok, false, name);
      assert.equal(v.status(), 'locked', name);
    }
    fs.copyFileSync(FIXTURE, file);
    const v = new Vault({ dir, usePepper: false });
    assert.equal((await v.unlock('Wrong-Master-2026!')).ok, false);
  });
});

test('vault: обрізаний файл відновлюється з .bak, пошкоджений зберігається окремо', async () => {
  await withVaultDir(async (dir) => {
    const file = path.join(dir, 'vault.bin');
    fs.copyFileSync(FIXTURE, file + '.bak');
    fs.writeFileSync(file, fs.readFileSync(FIXTURE, 'utf8').slice(0, 80)); // обрив запису посеред JSON
    const v = new Vault({ dir, usePepper: false });
    const r = await v.unlock(FIXTURE_MASTER);
    assert.equal(r.ok, true, 'має відкритися з резервної копії');
    assert.equal(v.recoveredFromBackup, true);
    assert.ok(fs.readdirSync(dir).some(n => n.startsWith('vault.bin.corrupt-')), 'пошкоджений файл збережено для розбору');
  });
});

test('vault: файл із хибною структурою не підміняється резервною копією (немає примусового відкату)', async () => {
  await withVaultDir(async (dir) => {
    const file = path.join(dir, 'vault.bin');
    fs.copyFileSync(FIXTURE, file + '.bak');
    const tampered = JSON.stringify({ v: 1, kdf: { n: 2, r: 1, p: 1, salt: 'AAAA' }, pepper: false, iv: '', tag: '', ct: '' }); // небезпечно слабкий KDF
    fs.writeFileSync(file, tampered);
    const v = new Vault({ dir, usePepper: false });
    const r = await v.unlock(FIXTURE_MASTER);
    assert.equal(r.ok, false, 'слабкі параметри KDF відхиляються');
    assert.equal(fs.readFileSync(file, 'utf8'), tampered, 'файл не перезаписано з .bak');
    assert.ok(!fs.readdirSync(dir).some(n => n.includes('.corrupt-')));
  });
});
