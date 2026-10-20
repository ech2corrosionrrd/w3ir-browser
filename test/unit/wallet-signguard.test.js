'use strict';
// Unit-тести розбору підписів (Permit, Permit2, Seaport) без Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const guard = require(path.join(__dirname, '..', '..', 'src', 'wallet-signguard.js'));

const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222';
const TOKEN_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const TOKEN_WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

test('signguard: permitSpenders та permitTokens вилучають адреси', () => {
  // permitSpenders
  const tdSpender = {
    message: {
      spender: BOB,
      operator: ALICE,
      other: '0xinvalid',
    },
  };
  const spenders = guard.permitSpenders(tdSpender);
  assert.ok(spenders.includes(BOB));
  assert.ok(spenders.includes(ALICE));
  assert.equal(guard.permitSpenders(null).length, 0);

  // permitTokens
  const tdPermit = {
    primaryType: 'Permit',
    domain: { verifyingContract: TOKEN_USDC },
    message: {},
  };
  assert.deepEqual(guard.permitTokens(tdPermit), [TOKEN_USDC]);

  const tdPermit2 = {
    primaryType: 'PermitSingle',
    domain: { verifyingContract: guard.PERMIT2 },
    message: {
      details: [
        { token: TOKEN_USDC, amount: 100 },
        { token: TOKEN_WETH, amount: 200 },
      ],
    },
  };
  const tokens = guard.permitTokens(tdPermit2);
  assert.ok(tokens.includes(TOKEN_USDC));
  assert.ok(tokens.includes(TOKEN_WETH));

  const tdTransferFrom = {
    primaryType: 'PermitTransferFrom',
    message: {
      permitted: { token: TOKEN_USDC, amount: 50 },
    },
  };
  assert.deepEqual(guard.permitTokens(tdTransferFrom), [TOKEN_USDC]);
});

test('signguard: describeTyped для EIP-2612 Permit', () => {
  const now = 1729000000000;
  const deadline = Math.floor(now / 1000) + 3600; // 1 hour

  // Безпечний стандартний Permit
  const tdSafe = {
    primaryType: 'Permit',
    domain: { verifyingContract: TOKEN_USDC },
    message: {
      owner: ALICE,
      spender: BOB,
      value: '1000000',
      deadline,
    },
  };
  const ctxSafe = {
    account: ALICE,
    now,
    tokens: new Map([[TOKEN_USDC, { symbol: 'USDC', decimals: 6 }]]),
  };
  const resSafe = guard.describeTyped(tdSafe, ctxSafe);
  assert.equal(resSafe.kind, 'Permit');
  assert.equal(resSafe.danger, false);
  assert.deepEqual(resSafe.warnings, []);

  // Необмежений Permit з попередженням
  const tdUnlimited = {
    primaryType: 'Permit',
    domain: { verifyingContract: TOKEN_USDC },
    message: {
      owner: ALICE,
      spender: BOB,
      value: (1n << 255n).toString(),
      deadline,
    },
  };
  const resUnlimited = guard.describeTyped(tdUnlimited, ctxSafe);
  assert.equal(resUnlimited.danger, true);
  assert.ok(resUnlimited.warnings.some(w => w.includes('Необмежений дозвіл')));

  // Spender — звичайний рахунок (не контракт)
  const isContractMap = new Map([[BOB, false]]);
  const resEOA = guard.describeTyped(tdSafe, { ...ctxSafe, isContract: isContractMap });
  assert.equal(resEOA.danger, true);
  assert.ok(resEOA.warnings.some(w => w.includes('звичайний рахунок')));

  // Незбіг власника рахунку
  const resWrongOwner = guard.describeTyped(tdSafe, { ...ctxSafe, account: BOB });
  assert.equal(resWrongOwner.danger, true);
  assert.ok(resWrongOwner.warnings.some(w => w.includes('не збігається з вашим рахунком')));

  // DAI-стиль allowed = true
  const tdDai = {
    primaryType: 'Permit',
    domain: { verifyingContract: TOKEN_USDC },
    message: {
      holder: ALICE,
      spender: BOB,
      allowed: true,
      expiry: deadline,
    },
  };
  const resDai = guard.describeTyped(tdDai, ctxSafe);
  assert.equal(resDai.danger, true);
  assert.ok(resDai.warnings.some(w => w.includes('Повний доступ до токена')));
});

test('signguard: describeTyped для PermitSingle та PermitBatch (Permit2)', () => {
  const now = 1729000000000;
  const deadline = Math.floor(now / 1000) + 3600;

  const td = {
    primaryType: 'PermitSingle',
    domain: { verifyingContract: guard.PERMIT2 },
    message: {
      spender: BOB,
      details: {
        token: TOKEN_USDC,
        amount: '50000000',
        expiration: deadline,
      },
      sigDeadline: deadline,
    },
  };
  const res = guard.describeTyped(td, { now, account: ALICE });
  assert.equal(res.kind, 'PermitSingle');
  assert.equal(res.danger, false);

  // verifyingContract підроблено
  const tdFakePermit2 = {
    ...td,
    domain: { verifyingContract: TOKEN_USDC },
  };
  const resFake = guard.describeTyped(tdFakePermit2, { now, account: ALICE });
  assert.equal(resFake.danger, true);
  assert.ok(resFake.warnings.some(w => w.includes('не є офіційним Permit2')));
});

test('signguard: describeTyped для PermitTransferFrom (небезпечний підпис на вивід)', () => {
  const now = 1729000000000;
  const deadline = Math.floor(now / 1000) + 600;

  const td = {
    primaryType: 'PermitTransferFrom',
    domain: { verifyingContract: guard.PERMIT2 },
    message: {
      spender: BOB,
      permitted: {
        token: TOKEN_USDC,
        amount: '10000000',
      },
      deadline,
    },
  };
  const res = guard.describeTyped(td, { now, account: ALICE });
  assert.equal(res.kind, 'PermitTransferFrom');
  assert.equal(res.danger, true);
  assert.ok(res.warnings.some(w => w.includes('дозволяє отримувачу забрати токени')));
});

test('signguard: describeTyped для Seaport OrderComponents (захист від крадіжки)', () => {
  const now = 1729000000000;

  // Чесний ордер: віддаємо 1 NFT, отримуємо 1 WETH
  const tdFair = {
    primaryType: 'OrderComponents',
    message: {
      offerer: ALICE,
      offer: [{ itemType: 2, token: TOKEN_USDC, identifierOrCriteria: '1', startAmount: '1' }],
      consideration: [{ itemType: 1, token: TOKEN_WETH, identifierOrCriteria: '0', startAmount: '1000000000000000000', recipient: ALICE }],
    },
  };
  const resFair = guard.describeTyped(tdFair, { now, account: ALICE });
  assert.equal(resFair.kind, 'OrderComponents');
  assert.equal(resFair.danger, false);

  // Шахрайський ордер (drainer): активи віддаються, а натомість 0 consideration
  const tdTheft = {
    primaryType: 'OrderComponents',
    message: {
      offerer: ALICE,
      offer: [{ itemType: 2, token: TOKEN_USDC, identifierOrCriteria: '1', startAmount: '1' }],
      consideration: [],
    },
  };
  const resTheft = guard.describeTyped(tdTheft, { now, account: ALICE });
  assert.equal(resTheft.danger, true);
  assert.ok(resTheft.warnings.some(w => w.includes('типова крадіжка')));

  // Невідомий тип підпису повертає null
  assert.equal(guard.describeTyped({ primaryType: 'CustomStruct', message: {} }), null);
});
