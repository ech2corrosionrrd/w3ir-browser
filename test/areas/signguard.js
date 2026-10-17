'use strict';
// SIWE, дозволи (permit/Permit2), ордери Seaport, EIP-7702 і захист буфера обміну: чисті функції без вікон Electron.
const { getAddress } = require('ethers');
const { ok } = require('../lib');

async function signguardTests() {
  const g = require('../../src/wallet-signguard');
  const { ClipGuard } = require('../../src/clip-guard');
  const acct = getAddress('0x00000000000000000000000000000000000000a1');
  const other = getAddress('0x00000000000000000000000000000000000000b2');
  const spender = getAddress('0x00000000000000000000000000000000000000c3');
  const tokenA = getAddress('0x00000000000000000000000000000000000000d4');
  const now = Date.parse('2026-10-18T12:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();

  // --- SIWE ---
  const siweText = (o = {}) => `${o.domain || 'app.example'} wants you to sign in with your Ethereum account:\n${o.address || acct}\n\n${o.statement === undefined ? 'Sign in to App.' : o.statement}\n\nURI: ${o.uri || 'https://app.example/login'}\nVersion: ${o.version || '1'}\nChain ID: ${o.chain || '1'}\nNonce: ${o.nonce || 'abcdef123456'}\nIssued At: ${o.issued || iso(now - 60000)}${o.exp ? '\nExpiration Time: ' + o.exp : ''}`;
  const origin = 'https://app.example';
  const good = g.checkSiwe(siweText(), { origin, account: acct, chainId: 1, now });
  ok(good && !good.danger && good.warnings.length === 0 && good.lines.some(l => l[0] === 'Домен у повідомленні' && l[1] === 'app.example'), 'siwe: правильний вхід — без попереджень, домен показано');
  ok(g.checkSiwe('Привіт, це звичайний текст', { origin, account: acct, now }) === null, 'siwe: звичайне повідомлення не вважається SIWE');
  const phish = g.checkSiwe(siweText({ domain: 'evil.example' }), { origin, account: acct, chainId: 1, now });
  ok(phish.danger && phish.warnings.some(w => /НЕ збігається з сайтом/.test(w)), 'siwe: домен у повідомленні не збігається з сайтом — небезпека (фішинг)');
  ok(g.checkSiwe(siweText({ domain: 'app.example' }), { origin: 'https://app.example.evil.io', account: acct, chainId: 1, now }).danger, 'siwe: схожий піддомен чужого сайту не проходить');
  ok(g.checkSiwe(siweText({ uri: 'https://evil.example/x' }), { origin, account: acct, chainId: 1, now }).danger, 'siwe: URI з іншого домену — небезпека');
  ok(g.checkSiwe(siweText({ address: other }), { origin, account: acct, chainId: 1, now }).danger, 'siwe: адреса у повідомленні не збігається з рахунком — небезпека');
  const w2 = g.checkSiwe(siweText({ chain: '137', nonce: 'x', exp: iso(now - 1000), issued: iso(now - 3 * 24 * 3600000), statement: 'Please transfer all my tokens', version: '2' }), { origin, account: acct, chainId: 1, now });
  ok(!w2.danger && w2.warnings.length >= 6 && w2.warnings.some(w => /Мережа в повідомленні/.test(w)) && w2.warnings.some(w => /Nonce/.test(w)) && w2.warnings.some(w => /минув/.test(w)) && w2.warnings.some(w => /Issued At/.test(w)) && w2.warnings.some(w => /перекази чи дозволи/.test(w)) && w2.warnings.some(w => /версія/.test(w)), 'siwe: мережа, nonce, термін, час, текст про перекази й версія дають попередження');
  ok(g.checkSiwe('x wants you to sign in with your Ethereum account\nбез двокрапки', { origin, account: acct, now }).danger, 'siwe: спотворений формат — небезпека');
  ok(g.checkSiwe(siweText({ domain: 'localhost:3000', uri: 'http://localhost:3000/' }), { origin: 'http://localhost:3000', account: acct, chainId: 1, now }).danger === false, 'siwe: домен із портом порівнюється разом із портом');

  // --- permit / Permit2 ---
  const ctx = (extra = {}) => ({ account: acct, now, isContract: new Map([[spender, true]]), tokens: new Map([[tokenA, { symbol: 'TKN', decimals: 6 }]]), ...extra });
  const permit = (m, vc = tokenA) => ({ domain: { name: 'T', chainId: 1, verifyingContract: vc }, primaryType: 'Permit', types: {}, message: { owner: acct, spender, value: '1000000', nonce: 0, deadline: String(Math.floor(now / 1000) + 3600), ...m } });
  const p1 = g.describeTyped(permit(), ctx());
  ok(p1 && !p1.danger && p1.lines.some(l => l[0] === 'Токен' && l[1] === tokenA) && p1.lines.some(l => l[0] === 'Сума' && /1000000.*TKN/.test(l[1])) && p1.lines.some(l => l[0] === 'Отримувач дозволу' && l[1] === spender), 'permit: звичайний дозвіл — токен, сума з символом, отримувач (контракт) без небезпеки');
  const p2 = g.describeTyped(permit({ value: (2n ** 256n - 1n).toString(), deadline: '115792089237316195423570985008687907853269984665640564039457584007913129639935' }), ctx());
  ok(p2.danger && p2.warnings.some(w => /Необмежений/.test(w)) && p2.warnings.some(w => /довго або без обмеження/.test(w)) && p2.lines.some(l => l[1] === 'НЕОБМЕЖЕНО') && p2.lines.some(l => l[0] === 'Діє до' && l[1] === 'без обмеження'), 'permit: необмежена сума й безстроковий дозвіл — небезпека');
  ok(g.describeTyped(permit({ spender: other }), ctx({ isContract: new Map([[other, false]]) })).danger && g.describeTyped(permit({ spender: other }), ctx({ isContract: new Map([[other, false]]) })).warnings.some(w => /звичайний рахунок, а не контракт/.test(w)), 'permit: отримувач — звичайний рахунок (EOA) — небезпека');
  ok(g.describeTyped(permit({ owner: other }), ctx()).danger, 'permit: власник у даних не ваш рахунок — небезпека');
  const dai = g.describeTyped({ domain: { verifyingContract: tokenA, chainId: 1 }, primaryType: 'Permit', types: {}, message: { holder: acct, spender, nonce: 0, expiry: 0, allowed: true } }, ctx());
  ok(dai.danger && dai.warnings.some(w => /Повний доступ/.test(w)) && dai.lines.some(l => /ДАТИ повний доступ/.test(l[1])), 'permit (DAI): allowed=true — повний доступ, небезпека');
  const PERMIT2 = g.PERMIT2;
  const ps = (m, vc = PERMIT2) => ({ domain: { name: 'Permit2', chainId: 1, verifyingContract: vc }, primaryType: 'PermitSingle', types: {}, message: { details: { token: tokenA, amount: '500', expiration: String(Math.floor(now / 1000) + 86400), nonce: 0 }, spender, sigDeadline: String(Math.floor(now / 1000) + 600), ...m } });
  const q1 = g.describeTyped(ps(), ctx());
  ok(q1 && !q1.danger && q1.lines.some(l => l[0] === 'Сума' && /500.*TKN/.test(l[1])) && q1.lines.some(l => l[0] === 'Підпис дійсний до'), 'permit2: PermitSingle з контрактом-отримувачем і кінцевою сумою — без небезпеки');
  const q2 = g.describeTyped(ps({ details: { token: tokenA, amount: (2n ** 160n - 1n).toString(), expiration: '281474976710655', nonce: 0 } }), ctx());
  ok(q2.danger && q2.warnings.some(w => /Необмежений/.test(w)), 'permit2: максимальна сума (uint160) — необмежений дозвіл, небезпека');
  ok(g.describeTyped(ps({}, getAddress('0x00000000000000000000000000000000000000ee')), ctx()).warnings.some(w => /не є офіційним Permit2/.test(w)), 'permit2: підроблений verifyingContract виявляється');
  const tf = g.describeTyped({ domain: { verifyingContract: PERMIT2, chainId: 1 }, primaryType: 'PermitTransferFrom', types: {}, message: { permitted: { token: tokenA, amount: '10' }, spender: other, nonce: 1, deadline: String(Math.floor(now / 1000) + 60) } }, ctx({ isContract: new Map([[other, false]]) }));
  ok(tf.danger && tf.warnings.some(w => /забрати токени без окремої транзакції/.test(w)) && tf.warnings.some(w => /звичайний рахунок/.test(w)), 'permit2: PermitTransferFrom (переказ за підписом) на EOA — небезпека');
  const batch = g.describeTyped({ domain: { verifyingContract: PERMIT2, chainId: 1 }, primaryType: 'PermitBatch', types: {}, message: { details: [{ token: tokenA, amount: '1', expiration: '1', nonce: 0 }, { token: other, amount: '2', expiration: '1', nonce: 0 }], spender, sigDeadline: '1' } }, ctx());
  ok(batch && batch.lines.filter(l => /^Токен/.test(l[0])).length === 2, 'permit2: PermitBatch показує всі токени');
  const order = (consideration) => ({ domain: { verifyingContract: getAddress('0x00000000000000000000000000000000000000f5'), chainId: 1 }, primaryType: 'OrderComponents', types: {}, message: { offerer: acct, offer: [{ itemType: 2, token: tokenA, identifierOrCriteria: '1', startAmount: '1', endAmount: '1' }], consideration } });
  ok(g.describeTyped(order([{ itemType: 0, token: '0x0', identifierOrCriteria: '0', startAmount: '1000', endAmount: '1000', recipient: other }]), ctx()).danger && !g.describeTyped(order([{ itemType: 0, token: '0x0', identifierOrCriteria: '0', startAmount: '1000', endAmount: '1000', recipient: acct }]), ctx()).danger, 'seaport: ордер, який нічого не дає вам, — небезпека; нормальний продаж — ні');
  ok(g.describeTyped({ domain: {}, primaryType: 'Mail', types: {}, message: {} }, ctx()) === null, 'permit: невідомі типи даних не розшифровуються (лишається загальне підтвердження)');
  ok(g.permitSpenders(permit()).length === 1 && g.permitTokens(permit())[0] === tokenA && g.permitTokens(ps())[0] === tokenA, 'permit: адреси отримувачів і токенів для попередньої перевірки витягуються');

  // --- EIP-7702 і пакетні виклики ---
  ok(['wallet_sendCalls', 'wallet_signAuthorization', 'eth_signAuthorization'].every(m => /./.test(g.rejectReason(m) || '')) && g.rejectReason('eth_chainId') === null, 'eip7702: пакетні виклики й підпис делегування відхиляються, звичайні методи — ні');
  ok(g.hasDelegation({ authorizationList: [] }) && g.hasDelegation({ type: '0x4' }) && g.hasDelegation({ type: 4 }) && g.hasDelegation({ type: '0x04' }) && !g.hasDelegation({ type: '0x2' }) && !g.hasDelegation({ to: acct }) && !g.hasDelegation(null), 'eip7702: транзакція з authorizationList чи типом 0x04 розпізнається');
  ok(g.delegateOf('0xef0100' + tokenA.slice(2)) === tokenA && g.delegateOf('0x') === null && g.delegateOf('0x6080604052') === null && g.delegateOf(null) === null, 'eip7702: код 0xef0100+адреса означає делегований рахунок');

  // --- буфер обміну ---
  let clipText = '', clock = 0;
  const cg = new ClipGuard(() => clipText, () => clock);
  const A = '0x1111111111111111111111111111111111111111', B = '0x2222222222222222222222222222222222222222';
  const SOL1 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  ok(cg.check(A).status === 'none' && !cg.note('привіт') && !cg.note('0x123') && cg.check(A).status === 'none', 'clip: без скопійованих адрес попередження немає; не-адреси не запам’ятовуються');
  cg.note(A);
  ok(cg.check(A).status === 'match' && cg.check(A.toUpperCase().replace('0X', '0x')).status === 'match', 'clip: та сама адреса (будь-який регістр для EVM) — збіг');
  const ch = cg.check(B);
  ok(ch.status === 'changed' && ch.copied === A && ch.similar === false, 'clip: інша адреса — «змінено», показано, що копіювали');
  const twin = '0x1111119999999999999999999999999999991111';
  ok(cg.check(twin).status === 'changed' && cg.check(twin).similar === true, 'clip: адреса з тим самим початком і кінцем — «схожа» (підміна-двійник)');
  ok(cg.check(SOL1).status === 'none', 'clip: адреса Solana не порівнюється з адресою EVM');
  cg.note(SOL1);
  ok(cg.check(SOL1).status === 'match' && cg.check(A).status === 'match', 'clip: EVM і Solana запам’ятовуються окремо');
  cg.note(B);
  ok(cg.check(A).status === 'match' && cg.check(B).status === 'match', 'clip: кілька скопійованих адрес — збіг із будь-якою');
  clock += 16 * 60 * 1000;
  ok(cg.check(A).status === 'none', 'clip: через 15 хвилин пам’ять очищується');
  clipText = A; cg.noteSoon(5);
  await new Promise(r => setTimeout(r, 40));
  ok(cg.check(A).status === 'match', 'clip: після копіювання адресу зчитано з буфера із затримкою');
}

module.exports = { signguardTests };
