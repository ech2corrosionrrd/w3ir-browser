'use strict';
// Solana: імена .sol (Solana Name Service) і пріоритетна комісія. Облегшений клас-замінник гаманця зі своїм solRpc.
const crypto = require('crypto');
const { ok } = require('../lib');

class RpcErr extends Error { constructor(code, msg) { super(msg); this.code = code; } }

async function solanaExtrasTests() {
  const S = require('../../src/solana');
  // --- чисті функції ---
  ok(S.snsAccount('bonfida') === 'Crf8hzfthWGbGbLTVCiqRqV5MVnbpHB1L9KQMd6gsinb', 'sns: адреса акаунта імені bonfida.sol збігається з відомою (звірено з mainnet)');
  ok(S.snsAccount('a') !== S.snsAccount('b') && S.snsAccount('toly') === S.snsAccount('toly'), 'sns: адреса залежить від назви й детермінована');
  const owner = S.deriveAccount(crypto.randomBytes(64), 0).address;
  const nameAcc = Buffer.concat([S.b58decode(S.SOL_TLD), S.b58decode(owner), Buffer.alloc(32), Buffer.alloc(8)]);
  const parsed = S.parseNameAccount(nameAcc);
  ok(parsed.parent === S.SOL_TLD && parsed.owner === owner && S.parseNameAccount(Buffer.alloc(10)) === null && S.parseNameAccount('x') === null, 'sns: розбір акаунта імені (батьківський акаунт і власник), сміття відхиляється');
  const lim = S.ixSetComputeUnitLimit(60000), price = S.ixSetComputeUnitPrice(12345n);
  ok(lim.programId === S.PROGRAMS.BUDGET && lim.keys.length === 0 && lim.data[0] === 2 && lim.data.readUInt32LE(1) === 60000 && price.data[0] === 3 && price.data.readBigUInt64LE(1) === 12345n && price.data.length === 9, 'budget: інструкції ліміту й ціни одиниці мають правильний формат ComputeBudget');
  // повідомлення з бюджетом розбирається й показується в описі
  const from = S.deriveAccount(crypto.randomBytes(64), 0).address, to = S.deriveAccount(crypto.randomBytes(64), 1).address;
  const msg = S.compileMessage({ feePayer: from, instructions: [lim, price, S.ixSystemTransfer(from, to, 1000n)], blockhash: S.b58encode(crypto.randomBytes(32)) });
  const desc = S.describe(S.parseMessage(msg), [from]);
  ok(desc.lines.some(l => l[0] === 'Ліміт обчислень' && l[1] === '60000') && desc.lines.some(l => l[0] === 'Пріоритетна комісія' && /12345/.test(l[1])) && desc.lines.some(l => /Переказ/.test(l[1])), 'budget: опис транзакції показує ліміт обчислень, пріоритетну комісію й сам переказ');

  // --- методи гаманця ---
  const helpers = { RpcError: RpcErr, isSafeRpc: () => true, clip: (s, n) => String(s).slice(0, n), unauthorized: (m) => new Error(m) };
  class FakeWallet {}
  require('../../src/wallet-solana').install(FakeWallet, helpers);
  const w = new FakeWallet();
  w.solCluster = () => 'mainnet-beta';
  const fails = async (fn) => { try { await fn(); return ''; } catch (e) { return e.message; } };
  const accounts = {};
  const putName = (label, { parent = S.SOL_TLD, own = owner, program = S.NAME_PROGRAM } = {}) => {
    const data = Buffer.concat([S.b58decode(parent), S.b58decode(own), Buffer.alloc(32), Buffer.alloc(8)]);
    accounts[S.snsAccount(label)] = { owner: program, data: [data.toString('base64'), 'base64'] };
  };
  w.solRpc = async (cluster, method, params) => {
    if (method === 'getAccountInfo') return { value: accounts[params[0]] || null };
    if (method === 'getRecentPrioritizationFees') return w._fees;
    throw new Error('unexpected ' + method);
  };
  putName('alice');
  putName('badparent', { parent: owner });
  putName('wrongprog', { program: S.PROGRAMS.TOKEN });
  putName('tokenized', { own: S.findProgramAddress([Buffer.from('nft')], S.PROGRAMS.ATA).address }); // власник — PDA
  putName('zeroowner', { own: '11111111111111111111111111111111' });
  ok(await w.resolveSolName('Alice.SOL') === owner && await w.resolveSolName(' alice.sol ') === owner, 'sns: ім’я .sol розв’язується у власника (регістр і пробіли не важливі)');
  ok(/не зареєстроване/.test(await fails(() => w.resolveSolName('nobody.sol'))) && /не зареєстроване/.test(await fails(() => w.resolveSolName('badparent.sol'))) && /не зареєстроване/.test(await fails(() => w.resolveSolName('wrongprog.sol'))) && /не зареєстроване/.test(await fails(() => w.resolveSolName('zeroowner.sol'))), 'sns: незареєстроване ім’я, чужий батьківський акаунт, чужа програма, нульовий власник — відхиляються');
  ok(/токенізовано/.test(await fails(() => w.resolveSolName('tokenized.sol'))), 'sns: домен, власник якого — PDA (токенізований), не розв’язується, щоб не надіслати не туди');
  ok(/прості імена/.test(await fails(() => w.resolveSolName('сайт.sol'))) && /прості імена/.test(await fails(() => w.resolveSolName('a.b.sol'))) && /прості імена/.test(await fails(() => w.resolveSolName('x'.repeat(64) + '.sol'))) && /прості імена/.test(await fails(() => w.resolveSolName('../x.sol'))), 'sns: кирилиця, піддомени, задовгі й сміттєві імена відхиляються (підміна символів неможлива)');
  w.solCluster = () => 'devnet';
  ok(/лише в Mainnet/.test(await fails(() => w.resolveSolName('alice.sol'))), 'sns: поза Mainnet Beta імена не розв’язуються');
  w.solCluster = () => 'mainnet-beta';

  // --- пріоритетна комісія ---
  const none = await w.solPriorityFee('mainnet-beta', 'standard', 1000);
  ok(none.micro === 0n && none.extra === 0n && none.instructions.length === 0 && (await w.solPriorityFee('mainnet-beta', undefined, 1000)).micro === 0n && (await w.solPriorityFee('mainnet-beta', 'low', 1000)).micro === 0n, 'priority: standard/low/без значення — без пріоритетної комісії (типова поведінка)');
  w._fees = [{ slot: 1, prioritizationFee: 0 }, { slot: 2, prioritizationFee: 2000 }, { slot: 3, prioritizationFee: 4000 }, { slot: 4, prioritizationFee: 100000 }, { slot: 5, prioritizationFee: 0 }];
  const fast = await w.solPriorityFee('mainnet-beta', 'fast', 60000);
  ok(fast.micro === 6000n && fast.extra === 360n && fast.instructions.length === 2 && fast.instructions[0].data.readUInt32LE(1) === 60000 && fast.instructions[1].data.readBigUInt64LE(1) === 6000n, 'priority: fast — 1,5 × медіана ненульових комісій; додаткова плата = ціна × ліміт');
  w._fees = [{ prioritizationFee: 9_999_999_999 }];
  ok((await w.solPriorityFee('mainnet-beta', 'fast', 1000)).micro === 1000000n, 'priority: стелю 1 000 000 мікро-лампортів за одиницю не перевищено');
  w._fees = [{ prioritizationFee: 3 }, { prioritizationFee: -5 }, { prioritizationFee: 'сміття' }, null];
  ok((await w.solPriorityFee('mainnet-beta', 'fast', 1000)).micro === 1000n, 'priority: сміттєві значення ігноруються, мінімум 1 000');
  w._fees = [];
  ok((await w.solPriorityFee('mainnet-beta', 'fast', 1000)).micro === 5000n, 'priority: без даних про комісії — запасне значення 5 000');
  w._fees = Array.from({ length: 25 }, () => ({ prioritizationFee: 40000 }));
  const busy = await w.solPriorityFee('mainnet-beta', 'standard', 1000);
  ok(busy.congested === true && busy.micro === 10000n && busy.instructions.length === 2, 'priority: standard при завантаженій мережі (≥20 записів, медіана ≥ 10 000) — захисний поріг ¼ медіани');
  ok((await w.solPriorityFee('mainnet-beta', 'low', 1000)).micro === 0n, 'priority: low лишається без пріоритетної комісії навіть при завантаженій мережі');
  w._fees = Array.from({ length: 25 }, () => ({ prioritizationFee: 100 }));
  const calm = await w.solPriorityFee('mainnet-beta', 'standard', 1000);
  ok(calm.congested === false && calm.micro === 0n && calm.instructions.length === 0, 'priority: standard при спокійній мережі — без комісії');
  w._fees = [{ prioritizationFee: 2000 }, { prioritizationFee: 4000 }, { prioritizationFee: 6000 }];
  ok((await w.solPriorityFee('mainnet-beta', 'dynamic', 1000)).micro === 4000n && (await w.solPriorityFee('mainnet-beta', 'auto', 1000)).micro === 4000n, 'priority: dynamic/auto — медіана недавніх комісій');
  w._fees = Array.from({ length: 25 }, () => ({ prioritizationFee: 9_999_999_999 }));
  ok((await w.solPriorityFee('mainnet-beta', 'standard', 1000)).micro === 1000000n && (await w.solPriorityFee('mainnet-beta', 'dynamic', 1000)).micro === 1000000n, 'priority: стеля 1 000 000 діє й для standard/dynamic');
  w.solRpc = async () => { throw new Error('мережа'); };
  ok((await w.solPriorityFee('mainnet-beta', 'fast', 1000)).micro === 5000n, 'priority: помилка RPC не блокує — запасне значення');
  ok(/Невідомий рівень/.test(await fails(() => w.solPriorityFee('mainnet-beta', 'warp', 1000))) && /Невідомий рівень/.test(await fails(() => w.solPriorityFee('mainnet-beta', {}, 1000))), 'priority: невідомий рівень відхиляється');
}

module.exports = { solanaExtrasTests };
