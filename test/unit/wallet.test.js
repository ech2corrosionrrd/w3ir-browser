'use strict';
// Unit-тести гаманця без Electron: Solana (base58, суми, повідомлення транзакцій) і розбір підписів сайту (SIWE, EIP-7702).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const src = (f) => require(path.join(__dirname, '..', '..', 'src', f));

const addrOf = (seed) => src('solana.js').b58encode(crypto.createHash('sha256').update(seed).digest());

test('solana: base58 туди й назад, адреси', () => {
  const s = src('solana.js');
  const bytes = crypto.randomBytes(32);
  assert.deepEqual(Buffer.from(s.b58decode(s.b58encode(bytes))), bytes);
  assert.equal(s.b58encode(Buffer.from([0, 0, 1])).startsWith('11'), true, 'початкові нулі → «1»');
  assert.equal(s.isAddress(addrOf('a')), true);
  assert.equal(s.isAddress('0OIl'), false, 'символи поза алфавітом');
  assert.equal(s.isAddress(s.b58encode(crypto.randomBytes(31))), false, 'не 32 байти');
  assert.equal(s.isAddress(''), false);
  assert.equal(s.isAddress(null), false);
});

test('solana: суми точні (BigInt) і відхиляють сміття', () => {
  const s = src('solana.js');
  assert.equal(s.parseSol('1'), 1_000_000_000n);
  assert.equal(s.parseSol('0.000000001'), 1n);
  assert.equal(s.parseSol('12.5'), 12_500_000_000n);
  for (const bad of ['0', '0.0', '-1', '1e3', '1.0000000001', '', ' 1', '1,5', 'abc', '1'.repeat(13), null, 5]) {
    assert.throws(() => s.parseSol(bad), undefined, String(bad));
  }
  assert.equal(s.parseUnits('12.5', 6), 12_500_000n);
  assert.equal(s.parseUnits('7', 0), 7n);
  assert.throws(() => s.parseUnits('1.5', 0));
  assert.throws(() => s.parseUnits('1.1234567', 6));
  assert.throws(() => s.parseUnits('1', -1));
  assert.throws(() => s.parseUnits('1', 31));
  assert.throws(() => s.parseUnits('18446744073709551616', 0), undefined, 'більше u64');
  assert.equal(s.parseUnits('18446744073709551615', 0), 0xffffffffffffffffn);
});

test('solana: форматування сум і коротких адрес', () => {
  const s = src('solana.js');
  assert.equal(s.formatUnits(1_500_000n, 6), '1.5');
  assert.equal(s.formatUnits(1n, 9), '0.000000001');
  assert.equal(s.formatUnits(42n, 0), '42');
  assert.equal(s.formatUnits(1_000_000n, 6), '1');
  assert.equal(s.sol(2_000_000_000), '2');
  assert.equal(s.short('1234567890ABCDEFGH'), '1234…EFGH');
  assert.equal(s.short('abc'), 'abc');
  assert.equal(s.short(null), '?');
});

test('solana: короткий вектор довжини (shortvec)', () => {
  const { encodeShortVec } = src('solana.js');
  assert.deepEqual([...encodeShortVec(0)], [0]);
  assert.deepEqual([...encodeShortVec(127)], [127]);
  assert.deepEqual([...encodeShortVec(128)], [0x80, 0x01]);
  assert.deepEqual([...encodeShortVec(16384)], [0x80, 0x80, 0x01]);
});

test('solana: переказ → повідомлення → розбір → опис збігаються', () => {
  const s = src('solana.js');
  const from = addrOf('from'), to = addrOf('to');
  const blockhash = addrOf('blockhash');
  const msg = s.buildTransferMessage({ from, to, lamports: 123_456_789n, blockhash });
  const parsed = s.parseMessage(msg);
  assert.equal(parsed.version, 'legacy');
  assert.ok(parsed.keys.includes(from) && parsed.keys.includes(to));
  const d = s.describe(parsed, [from]);
  assert.equal(d.outgoing, 123_456_789n);
  assert.equal(d.danger, false);
  const wire = s.unsignedWire(msg);
  const tx = s.parseTransaction(wire);
  assert.ok(tx);
  assert.throws(() => s.buildTransferMessage({ from, to: from, lamports: 1n, blockhash }), undefined, 'на той самий рахунок');
});

test('solana: обірвані й спотворені повідомлення відхиляються без збою', () => {
  const s = src('solana.js');
  const msg = s.buildTransferMessage({ from: addrOf('f'), to: addrOf('t'), lamports: 5n, blockhash: addrOf('b') });
  for (let n = 0; n < msg.length; n += 7) {
    try { s.parseMessage(msg.subarray(0, n)); } catch (e) { assert.ok(e instanceof Error); }
  }
  assert.throws(() => s.parseMessage(Buffer.alloc(0)));
  assert.throws(() => s.parseMessage(Buffer.from([0x81, 0, 0, 0])), undefined, 'версія 1 не підтримується');
});

test('solana: isOnCurve, findProgramAddress та metadataPda', () => {
  const s = src('solana.js');
  const kp = s.keypairFromSeed(Buffer.alloc(32, 2));
  assert.equal(s.isOnCurve(s.b58decode(kp.address)), true);

  const mint = s.b58encode(Buffer.alloc(32, 1));
  const pda = s.metadataPda(mint);
  assert.ok(s.isAddress(pda));
  // PDA точки завжди знаходяться поза кривою (не мають закритого ключа)
  assert.equal(s.isOnCurve(s.b58decode(pda)), false);
});

test('solana: parseMetadata розбір метаданих Metaplex NFT', () => {
  const s = src('solana.js');
  const mintBuf = Buffer.alloc(32, 7);
  const updateAuth = Buffer.alloc(32, 8);
  const name = Buffer.from('W3IR Genesis Pass');
  const symbol = Buffer.from('W3IR');
  const uri = Buffer.from('https://arweave.net/tx-w3ir-metadata-001');

  const b = Buffer.concat([
    Buffer.from([4]),
    updateAuth,
    mintBuf,
    Buffer.from([name.length, 0, 0, 0]), name,
    Buffer.from([symbol.length, 0, 0, 0]), symbol,
    Buffer.from([uri.length, 0, 0, 0]), uri,
  ]);
  const meta = s.parseMetadata(b);
  assert.ok(meta);
  assert.equal(meta.name, 'W3IR Genesis Pass');
  assert.equal(meta.symbol, 'W3IR');
  assert.equal(meta.uri, 'https://arweave.net/tx-w3ir-metadata-001');

  // Пошкоджений буфер повертає null
  assert.equal(s.parseMetadata(Buffer.from([1, 2, 3])), null);
});

test('solana: signTransaction підпис і перевірка підписанта', () => {
  const s = src('solana.js');
  const kp = s.keypairFromSeed(Buffer.alloc(32, 3));
  const to = s.b58encode(Buffer.alloc(32, 4));
  const blockhash = s.b58encode(Buffer.alloc(32, 5));
  const msg = s.buildTransferMessage({ from: kp.address, to, lamports: 5000n, blockhash });
  const wire = s.unsignedWire(msg);

  // Успішний підпис
  const signed = s.signTransaction(kp.secret, kp.address, wire);
  assert.equal(signed.signature.length, 64);
  assert.equal(signed.index, 0);

  // Спроба підписати не тим акаунтом викликає виняток
  const wrongKp = s.keypairFromSeed(Buffer.alloc(32, 9));
  assert.throws(() => s.signTransaction(wrongKp.secret, wrongKp.address, wire), /не потребує підпису цього рахунку/);
});

test('solana: describe виявляє шахрайські шаблони (Assign, Token Approve)', () => {
  const s = src('solana.js');
  const kp = s.keypairFromSeed(Buffer.alloc(32, 3));
  const blockhash = s.b58encode(Buffer.alloc(32, 5));

  // 1. Небезпечний System Assign: передача власності над рахунком
  const assignData = Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.alloc(32, 0xef)]);
  const msgAssign = s.compileMessage({
    feePayer: kp.address,
    instructions: [{
      programId: s.PROGRAMS.SYSTEM,
      keys: [{ pubkey: kp.address, isSigner: true, isWritable: true }],
      data: assignData,
    }],
    blockhash,
  });
  const descAssign = s.describe(s.parseMessage(msgAssign), [kp.address]);
  assert.equal(descAssign.danger, true);
  assert.ok(descAssign.warnings.some(w => w.includes('передає власність над ВАШИМ акаунтом')));

  // 2. Небезпечний Token Approve: необмежений дозвіл іншій особі витрачати токени
  const spender = s.b58encode(Buffer.alloc(32, 7));
  const approveData = Buffer.concat([Buffer.from([4]), s.u64(1000000n)]);
  const msgApprove = s.compileMessage({
    feePayer: kp.address,
    instructions: [{
      programId: s.PROGRAMS.TOKEN,
      keys: [
        { pubkey: kp.address, isSigner: false, isWritable: true },
        { pubkey: spender, isSigner: false, isWritable: false },
        { pubkey: kp.address, isSigner: true, isWritable: false },
      ],
      data: approveData,
    }],
    blockhash,
  });
  const descApprove = s.describe(s.parseMessage(msgApprove), [kp.address]);
  assert.equal(descApprove.danger, true);
  assert.ok(descApprove.warnings.some(w => w.includes('право витрачати ваші токени')));
});

const SIWE = (over = {}) => [
  `${over.domain || 'app.example'} wants you to sign in with your Ethereum account:`,
  over.address || '0x1111111111111111111111111111111111111111',
  '',
  over.statement || 'Увійти в застосунок.',
  '',
  `URI: ${over.uri || 'https://app.example/login'}`,
  `Version: ${over.version || '1'}`,
  `Chain ID: ${over.chain || '1'}`,
  `Nonce: ${over.nonce || 'abcdef123456'}`,
  `Issued At: ${over.issued || '2026-10-18T10:00:00.000Z'}`,
].join('\n');
const NOW = Date.parse('2026-10-18T10:05:00.000Z');
const ACC = '0x1111111111111111111111111111111111111111';

test('signguard: коректний SIWE без попереджень про домен', () => {
  const g = src('wallet-signguard.js');
  const p = g.parseSiwe(SIWE());
  assert.equal(p.domain, 'app.example');
  assert.equal(p.fields.Nonce, 'abcdef123456');
  const r = g.checkSiwe(SIWE(), { origin: 'https://app.example', account: ACC, chainId: 1, now: NOW });
  assert.equal(r.danger, false);
  assert.deepEqual(r.warnings, []);
  assert.equal(g.checkSiwe('звичайний текст', { origin: 'https://x.y' }), null);
  assert.equal(g.parseSiwe('hello'), null);
});

test('signguard: SIWE з чужим доменом, чужою адресою й підозрілим текстом', () => {
  const g = src('wallet-signguard.js');
  const phish = g.checkSiwe(SIWE({ domain: 'app.example' }), { origin: 'https://evil.example', account: ACC, chainId: 1, now: NOW });
  assert.equal(phish.danger, true, 'домен ≠ сайт');
  const uri = g.checkSiwe(SIWE({ uri: 'https://evil.example/x' }), { origin: 'https://app.example', account: ACC, now: NOW });
  assert.equal(uri.danger, true, 'URI з іншого домену');
  const acc = g.checkSiwe(SIWE(), { origin: 'https://app.example', account: '0x2222222222222222222222222222222222222222', now: NOW });
  assert.equal(acc.danger, true, 'адреса ≠ рахунок');
  const stmt = g.checkSiwe(SIWE({ statement: 'Approve and transfer all my tokens' }), { origin: 'https://app.example', account: ACC, now: NOW });
  assert.ok(stmt.warnings.length >= 1);
  const old = g.checkSiwe(SIWE({ nonce: 'x' }), { origin: 'https://app.example', account: ACC, now: NOW });
  assert.ok(old.warnings.length >= 1, 'короткий nonce');
});

test('signguard: відхилені методи й делегування EIP-7702', () => {
  const g = src('wallet-signguard.js');
  assert.ok(g.rejectReason('wallet_sendCalls'));
  assert.ok(g.rejectReason('eth_signAuthorization'));
  assert.equal(g.rejectReason('eth_chainId'), null);
  assert.equal(g.hasDelegation({ type: 4 }), true);
  assert.equal(g.hasDelegation({ type: '0x04' }), true);
  assert.equal(g.hasDelegation({ authorizationList: [] }), true);
  assert.equal(g.hasDelegation({ type: 2 }), false);
  assert.equal(g.hasDelegation(null), false);
  const a = '0x' + 'ab'.repeat(20);
  assert.equal(g.delegateOf('0xef0100' + 'ab'.repeat(20)).toLowerCase(), a);
  assert.equal(g.delegateOf('0x'), null);
  assert.equal(g.delegateOf('0xef0100' + 'ab'.repeat(19)), null);
});

test('solana: Stake Program інструкції та виявлення небезпечних змін Withdrawer', () => {
  const sol = src('solana.js');
  const myKey = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
  const otherKey = 'CuieVDEDtLo7FypA9SbLM9saXFdb1dsshveFi796umn7';
  const stakeAcc = '4Nd1mBQtrMJVYVfKf2PJy9NZ268dFY28nFsJm2BaNw28';
  const voteAcc = 'Vote111111111111111111111111111111111111111';

  // 1. Делегування стейку
  const ixDel = sol.ixStakeDelegate({ stakeAccount: stakeAcc, voteAccount: voteAcc, authorizedPubkey: myKey });
  const msgDel = sol.compileMessage({ feePayer: myKey, instructions: [ixDel], blockhash: '4Nd1mBQtrMJVYVfKf2PJy9NZ268dFY28nFsJm2BaNw28' });
  const descDel = sol.describe(sol.parseMessage(msgDel), [myKey]);
  assert.equal(descDel.danger, false);
  assert.ok(descDel.lines.some(l => l[1].includes('Делегування стейку')));

  // 2. Деактивація стейку
  const ixDeact = sol.ixStakeDeactivate({ stakeAccount: stakeAcc, authorizedPubkey: myKey });
  const msgDeact = sol.compileMessage({ feePayer: myKey, instructions: [ixDeact], blockhash: '4Nd1mBQtrMJVYVfKf2PJy9NZ268dFY28nFsJm2BaNw28' });
  const descDeact = sol.describe(sol.parseMessage(msgDeact), [myKey]);
  assert.equal(descDeact.danger, false);
  assert.ok(descDeact.lines.some(l => l[1].includes('Деактивація стейку')));

  // 3. Небезпечна передача Withdrawer на чужу адресу (спроба викрадення стейку)
  const ixAuthBad = sol.ixStakeAuthorize({ stakeAccount: stakeAcc, authorizedPubkey: myKey, newAuthorizedPubkey: otherKey, stakeAuthorizeType: 1 });
  const msgAuthBad = sol.compileMessage({ feePayer: myKey, instructions: [ixAuthBad], blockhash: '4Nd1mBQtrMJVYVfKf2PJy9NZ268dFY28nFsJm2BaNw28' });
  const descAuthBad = sol.describe(sol.parseMessage(msgAuthBad), [myKey]);
  assert.equal(descAuthBad.danger, true);
  assert.ok(descAuthBad.warnings.some(w => w.includes('повної втрати застейканих SOL')));

  // 4. Виведення стейку на чужу адресу
  const ixWithdrawBad = sol.ixStakeWithdraw({ stakeAccount: stakeAcc, to: otherKey, authorizedPubkey: myKey, lamports: 1000000000n });
  const msgWithdrawBad = sol.compileMessage({ feePayer: myKey, instructions: [ixWithdrawBad], blockhash: '4Nd1mBQtrMJVYVfKf2PJy9NZ268dFY28nFsJm2BaNw28' });
  const descWithdrawBad = sol.describe(sol.parseMessage(msgWithdrawBad), [myKey]);
  assert.equal(descWithdrawBad.danger, true);
  assert.ok(descWithdrawBad.warnings.some(w => w.includes('Виведення стейку на чужу адресу')));
});

test('solana: створення стейк-акаунта та генерація ключів (ixSystemCreateAccount, generateKeypair)', () => {
  const sol = src('solana.js');
  const myKey = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
  const kp = sol.generateKeypair();
  assert.ok(kp && kp.secret && kp.address);
  assert.equal(kp.publicKey.length, 32);
  assert.ok(sol.isAddress(kp.address));

  const ixCreate = sol.ixSystemCreateAccount({
    from: myKey,
    newAccount: kp.address,
    lamports: 2282880n,
    space: 200,
    programId: sol.PROGRAMS.STAKE,
  });
  assert.equal(ixCreate.programId, sol.PROGRAMS.SYSTEM);
  assert.equal(ixCreate.keys.length, 2);
  assert.equal(ixCreate.keys[0].pubkey, myKey);
  assert.equal(ixCreate.keys[1].pubkey, kp.address);

  const msg = sol.compileMessage({
    feePayer: myKey,
    instructions: [ixCreate],
    blockhash: '4Nd1mBQtrMJVYVfKf2PJy9NZ268dFY28nFsJm2BaNw28',
  });
  const desc = sol.describe(sol.parseMessage(msg), [myKey]);
  assert.equal(desc.danger, false);
  assert.ok(desc.lines.some(l => l[1].includes('Створення акаунта')));

  const wire0 = sol.unsignedWire(msg);
  const signed1 = sol.signTransaction(kp.secret, kp.address, wire0);
  assert.ok(signed1 && signed1.signedWire);
  assert.equal(signed1.index, 1);

  // Перевірка мультипідпису (платник + створений стейк-акаунт як extraSigner)
  const kp0 = sol.generateKeypair();
  const msgMulti = sol.compileMessage({
    feePayer: kp0.address,
    instructions: [sol.ixSystemCreateAccount({ from: kp0.address, newAccount: kp.address, lamports: 2282880n, space: 200, programId: sol.PROGRAMS.STAKE })],
    blockhash: '4Nd1mBQtrMJVYVfKf2PJy9NZ268dFY28nFsJm2BaNw28',
  });
  const wireMulti = sol.unsignedWire(msgMulti);
  const sFeePayer = sol.signTransaction(kp0.secret, kp0.address, wireMulti);
  const sFinal = sol.signTransaction(kp.secret, kp.address, sFeePayer.signedWire);
  const parsedMulti = sol.parseTransaction(sFinal.signedWire);
  assert.equal(parsedMulti.sigCount, 2);
  const sig0 = parsedMulti.wire.subarray(parsedMulti.sigOffset, parsedMulti.sigOffset + 64);
  const sig1 = parsedMulti.wire.subarray(parsedMulti.sigOffset + 64, parsedMulti.sigOffset + 128);
  assert.ok(sig0.some(b => b !== 0), 'підпис платника комісії присутній');
  assert.ok(sig1.some(b => b !== 0), 'підпис додаткового підписанта (стейк-акаунта) присутній');
});

test('solana: усі варіанти зміни Withdrawer стейку виявляються (Authorize, WithSeed, Checked, CheckedWithSeed, Initialize)', () => {
  const sol = src('solana.js');
  const my = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
  const other = 'CuieVDEDtLo7FypA9SbLM9saXFdb1dsshveFi796umn7';
  const stake = '4Nd1mBQtrMJVYVfKf2PJy9NZ268dFY28nFsJm2BaNw28';
  const bh = '4Nd1mBQtrMJVYVfKf2PJy9NZ268dFY28nFsJm2BaNw28';
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const seed = Buffer.concat([Buffer.alloc(8, 0), Buffer.alloc(32)]); // порожній seed (u64 довжина = 0) + owner
  const acc = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
  const describeIx = (ix) => sol.describe(sol.parseMessage(sol.compileMessage({ feePayer: my, instructions: [ix], blockhash: bh })), [my]);
  const mk = (data, keys) => ({ programId: sol.PROGRAMS.STAKE, keys, data });
  const pk = (a) => sol.b58decode(a);

  for (const type of [1, 0]) { // 1 = Withdrawer, 0 = Staker
    for (const target of [other, my]) {
      const foreignWithdrawer = type === 1 && target === other;
      const cases = {
        'AuthorizeWithSeed (8)': mk(Buffer.concat([u32(8), pk(target), u32(type), seed]), [acc(stake), acc(my, true)]),
        'AuthorizeChecked (10)': mk(Buffer.concat([u32(10), u32(type)]), [acc(stake), acc(my, true), acc(my, true), acc(target, true)]),
        'AuthorizeCheckedWithSeed (11)': mk(Buffer.concat([u32(11), u32(type), Buffer.alloc(8), Buffer.alloc(32)]), [acc(stake), acc(my, true), acc(my), acc(target, true)]),
      };
      for (const [name, ix] of Object.entries(cases)) {
        const d = describeIx(ix);
        assert.equal(d.danger, foreignWithdrawer, `${name}, тип ${type}, отримувач ${target === my ? 'свій' : 'чужий'}: danger`);
        assert.ok(d.lines.some(l => l[1].includes('Зміна повноважень стейку')), `${name}: розпізнано як зміну повноважень`);
      }
    }
  }

  // Initialize / InitializeChecked: чужий Withdrawer — небезпека, свій — ні
  const init = (w) => sol.ixStakeInitialize({ stakeAccount: stake, staker: my, withdrawer: w });
  assert.equal(describeIx(init(other)).danger, true);
  assert.equal(describeIx(init(my)).danger, false);
  const initChecked = (w) => mk(u32(9), [acc(stake), acc(stake), acc(my), acc(w, true)]);
  assert.equal(describeIx(initChecked(other)).danger, true);
  assert.equal(describeIx(initChecked(my)).danger, false);
});

test('solana: переказ токенів зі свого акаунта виноситься нагору підсумком', () => {
  const sol = src('solana.js');
  const my = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
  const other = 'CuieVDEDtLo7FypA9SbLM9saXFdb1dsshveFi796umn7';
  const bh = '4Nd1mBQtrMJVYVfKf2PJy9NZ268dFY28nFsJm2BaNw28';
  const acc = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
  const amount = Buffer.alloc(8); amount.writeBigUInt64LE(5n);
  const transfer = (authority) => ({ programId: sol.PROGRAMS.TOKEN, keys: [acc(other), acc(my), acc(authority, true)], data: Buffer.concat([Buffer.from([3]), amount]) });
  const memo = { programId: sol.PROGRAMS.MEMO, keys: [], data: Buffer.from('x') };
  const run = (instructions) => sol.describe(sol.parseMessage(sol.compileMessage({ feePayer: my, instructions, blockhash: bh })), [my]);

  const hidden = run([...Array(30).fill(memo), transfer(my)]);
  assert.equal(hidden.lines[0][0], 'Токени підуть з ваших акаунтів', 'підсумок — першим рядком, навіть коли дій багато');
  assert.match(hidden.lines[0][1], /1/);
  assert.equal(run([transfer(other)]).lines.some(l => l[0] === 'Токени підуть з ваших акаунтів'), false, 'чужий підпис — не ваші токени');
});

test('solana: створення стейку будується з правильними параметрами', () => {
  const sol = src('solana.js');
  const my = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
  const stake = '4Nd1mBQtrMJVYVfKf2PJy9NZ268dFY28nFsJm2BaNw28';
  const init = sol.ixStakeInitialize({ stakeAccount: stake, staker: my, withdrawer: my });
  assert.equal(Buffer.from(init.data).subarray(36, 68).equals(Buffer.from(sol.b58decode(my))), true);
  const del = sol.ixStakeDelegate({ stakeAccount: stake, voteAccount: 'Vote111111111111111111111111111111111111111', authorizedPubkey: my });
  assert.equal(del.keys[1].pubkey, 'Vote111111111111111111111111111111111111111');
  // сигнатури, якими користується wallet-solana-staking.js
  const src_ = require('fs').readFileSync(path.join(__dirname, '..', '..', 'src', 'wallet-solana-staking.js'), 'utf8');
  assert.match(src_, /ixStakeInitialize\(\{\s*stakeAccount: stakeKp\.address,\s*staker: from,\s*withdrawer: from,/);
  assert.match(src_, /voteAccount: votePubkey/);
});
