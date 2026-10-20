'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { base32Decode, parseOtpAuth, generateTotp } = require(path.join(__dirname, '..', '..', 'src', 'totp.js'));

test('totp: декодування base32 (base32Decode)', () => {
  // Перевірка базового розкодування (ASCII "12345678901234567890")
  const b = base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(b.toString('ascii'), '12345678901234567890');

  // Ігнорування дефісів, пробілів та нижнього регістру
  const b2 = base32Decode('gezd-gnbv-gy3t-qojq gezb====');
  assert.ok(b2.length > 0);

  // Порожній вхід
  assert.equal(base32Decode('').length, 0);
});

test('totp: розбір otpauth URI (parseOtpAuth)', () => {
  const uri = 'otpauth://totp/Example:user@domain.com?secret=JBSWY3DPEHPK3PXP&issuer=Example&digits=6&period=30&algorithm=SHA1';
  const r = parseOtpAuth(uri);
  assert.ok(r);
  assert.equal(r.secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(r.digits, 6);
  assert.equal(r.period, 30);
  assert.equal(r.algo, 'sha1');

  // Кастомні параметри (8 цифр, 45 секунд, SHA256)
  const uriCustom = 'otpauth://totp/Custom?secret=GEZDGNBVGY3TQOJQ&digits=8&period=45&algorithm=SHA256';
  const rCustom = parseOtpAuth(uriCustom);
  assert.equal(rCustom.digits, 8);
  assert.equal(rCustom.period, 45);
  assert.equal(rCustom.algo, 'sha256');

  // Звичайний Base32 ключ без URI
  const raw = parseOtpAuth('HXDM-VJEC-JJWS-RB3H');
  assert.ok(raw);
  assert.equal(raw.secret, 'HXDMVJECJJWSRB3H');
  assert.equal(raw.digits, 6);
  assert.equal(raw.period, 30);

  // Некоректний секрет
  assert.equal(parseOtpAuth(''), null);
  assert.equal(parseOtpAuth('invalid!characters#'), null);
});

test('totp: офіційні тестові вектори RFC 6238 (Appendix B)', () => {
  // Секрет: "12345678901234567890" -> Base32 "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

  // 6-значні коди
  assert.equal(generateTotp(secret, 59).code, '287082');
  assert.equal(generateTotp(secret, 1111111109).code, '081804');
  assert.equal(generateTotp(secret, 1111111111).code, '050471');
  assert.equal(generateTotp(secret, 1234567890).code, '005924');
  assert.equal(generateTotp(secret, 2000000000).code, '279037');

  // Розрахунок залишку секунд
  const res = generateTotp(secret, 59);
  assert.equal(res.remaining, 1); // 59 % 30 = 29 -> 30 - 29 = 1
  assert.equal(res.period, 30);

  const res2 = generateTotp(secret, 60);
  assert.equal(res2.remaining, 30); // 60 % 30 = 0 -> 30 - 0 = 30
});

test('totp: робота з URI та нестандартними періодами', () => {
  const uri = 'otpauth://totp/Test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8&period=60';
  const res = generateTotp(uri, 59);
  // Для period=60 і T=59: counter = 0
  assert.equal(res.code.length, 8);
  assert.equal(res.remaining, 1);
  assert.equal(res.period, 60);
});

test('totp: збереження 2FA у Vault під час exportBackup, importBackup та importCsv', async () => {
  const fs = require('fs');
  const os = require('os');
  const { Vault } = require(path.join(__dirname, '..', '..', 'src', 'vault.js'));
  const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'w3ir-totp1-'));
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'w3ir-totp2-'));
  try {
    const v1 = new Vault({ dir: dir1, usePepper: false });
    await v1.create('StrongMasterPass123!');
    const id = v1.add({ url: 'https://github.com', username: 'alice', password: 'SecretPassword1!', note: 'My note', totp: 'JBSWY3DPEHPK3PXP' });
    assert.equal(v1.getTotp(id).ok, true);
    assert.equal(v1.getTotp(id).code.length, 6);

    const backupFile = path.join(dir1, 'backup.w3irvault');
    const exp = await v1.exportBackup(backupFile, 'BackupPassword123!');
    assert.equal(exp.ok, true);

    const v2 = new Vault({ dir: dir2, usePepper: false });
    await v2.create('AnotherMasterPass123!');
    const imp = await v2.importBackup(backupFile, 'BackupPassword123!');
    assert.equal(imp.ok, true);
    assert.equal(imp.added, 1);
    const list = v2.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].hasTotp, true);
    assert.equal(v2.get(list[0].id).note, 'My note');
    assert.equal(v2.getTotp(list[0].id).ok, true);

    // Перевірка importCsv із стовпцем totp
    const csvRes = v2.importCsv('url,username,password,note,totp\nhttps://gitlab.com,bob,Pass123456!,GitLab note,GEZDGNBVGY3TQOJQ');
    assert.equal(csvRes.ok, true);
    assert.equal(csvRes.added, 1);
    const gitlab = v2.list().find(x => x.host === 'gitlab.com');
    assert.ok(gitlab);
    assert.equal(gitlab.hasTotp, true);
  } finally {
    fs.rmSync(dir1, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});
