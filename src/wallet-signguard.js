'use strict';
// Розбір того, що сайт просить підписати: вхід Ethereum (SIWE, EIP-4361), підписи дозволів (EIP-2612 permit, Permit2),
// ордери Seaport, а також транзакції з делегуванням EIP-7702. Це лише підказки й попередження для довіреного вікна підтвердження:
// остаточне рішення завжди за користувачем. Усі дані від сайту недовірені; тут вони лише читаються й показуються.
const { getAddress, isAddress } = require('ethers');

const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
// Відомі перевірені контракти-спендери за реєстром RevokeCash/whois (MIT)
const KNOWN_SPENDERS = new Map([
  [PERMIT2.toLowerCase(), 'Permit2 (Uniswap)'],
  ['0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad', 'Uniswap Universal Router'],
  ['0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b', 'Uniswap Universal Router (v1)'],
  ['0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', 'Uniswap SwapRouter02'],
  ['0x7a250d5630b4cf539739df2c5dacb4c659f2488d', 'Uniswap V2 Router'],
  ['0xe592427a0aece92de3edee1f18e0157c05861564', 'Uniswap V3 Router'],
  ['0x1111111254eeb25477b68fb85ed929f73a960582', '1inch Aggregation Router v5'],
  ['0x111111125421ca6dc452d289314280a0f8842a65', '1inch Aggregation Router v6'],
  ['0xdef1c0ded9bec7f1a1670819833240f027b25eff', '0x Exchange Proxy'],
  ['0x1e0049783f008a0085193e00003d00cd54003c71', 'OpenSea Conduit'],
  ['0x00000000000000adc04c56bf30ac9d3c0aaf14dc', 'OpenSea Seaport 1.5'],
  ['0x0000000000000068f116a894984e2db1123eb395', 'OpenSea Seaport 1.6'],
  ['0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2', 'Aave V3 Pool'],
  ['0x6352a56caad4f1e25cd6c75970fa768a3304e64', 'OpenOcean Exchange'],
  ['0x216b4b4ba9f3e719726886d34a177484278bfcae', 'ParaSwap Augustus'],
  ['0xc92e8bdf79f0507f65a392b0ab4667716bfe0110', 'CoW Protocol GPv2VaultRelayer'],
]);
const spenderLabel = (a) => (typeof a === 'string' ? KNOWN_SPENDERS.get(a.toLowerCase()) || '' : '');
const fmtSpender = (sp, raw) => {
  if (!sp) return clip(raw, 60);
  const lbl = spenderLabel(sp);
  return lbl ? `${lbl} (${sp})` : sp;
};
const UINT160_MAX = (1n << 160n) - 1n;
const UNLIMITED_2612 = 1n << 255n;
const YEAR = 365 * 24 * 3600;
const MAX_SANE_TS = 253402300799n; // 9999-12-31

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const addr = (v) => { try { return typeof v === 'string' && isAddress(v) ? getAddress(v) : null; } catch { return null; } };
const big = (v) => { try { if (typeof v === 'bigint') return v; if (typeof v === 'number') return BigInt(Math.trunc(v)); if (typeof v === 'string' && /^(0x[0-9a-fA-F]+|\d+)$/.test(v)) return BigInt(v); } catch { /* нижче */ } return null; };
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n) + '…' : String(s));

// ---------- SIWE ----------
const SIWE_MARK = 'wants you to sign in with your Ethereum account';
const SIWE_HEAD = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^\s/]+) wants you to sign in with your Ethereum account:$/i;

function parseSiwe(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const m = SIWE_HEAD.exec(lines[0] || '');
  if (!m) return null;
  const out = { scheme: m[1] || '', domain: m[2], address: (lines[1] || '').trim(), statement: '', fields: {}, resources: [] };
  let i = 2;
  if ((lines[i] || '') === '') i++;
  const stmt = [];
  while (i < lines.length && !/^URI: /.test(lines[i])) { if (lines[i] !== '') stmt.push(lines[i]); else break; i++; }
  out.statement = stmt.join('\n');
  while (i < lines.length && lines[i] === '') i++;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === 'Resources:') { for (i++; i < lines.length && /^- /.test(lines[i]); i++) out.resources.push(lines[i].slice(2)); break; }
    const f = /^(URI|Version|Chain ID|Nonce|Issued At|Expiration Time|Not Before|Request ID): (.*)$/.exec(line);
    if (f) out.fields[f[1]] = f[2];
  }
  return out;
}

// Повертає null, якщо це не SIWE; інакше { lines, warnings, danger }
function checkSiwe(text, { origin, account, chainId, now = Date.now() } = {}) {
  const t = String(text);
  if (!t.includes(SIWE_MARK)) return null;
  const p = parseSiwe(t);
  if (!p) return { lines: [], warnings: ['Повідомлення схоже на вхід через Ethereum (SIWE), але має неправильний формат: підписуйте лише якщо повністю довіряєте сайту.'], danger: true };
  const warnings = [];
  let danger = false;
  const bad = (w) => { warnings.push(w); danger = true; };
  let host = '';
  try { host = new URL(origin).host; } catch { /* нижче */ }
  if (!host || p.domain.toLowerCase() !== host.toLowerCase()) bad(`Домен у повідомленні (${clip(p.domain, 80)}) НЕ збігається з сайтом (${host || '—'}). Так діють фішингові сайти: не підписуйте.`);
  if (p.fields.URI) {
    let uh = '';
    try { uh = new URL(p.fields.URI).host; } catch { /* нижче */ }
    if (!uh || uh.toLowerCase() !== p.domain.toLowerCase()) bad(`Адреса URI (${clip(p.fields.URI, 80)}) не належить домену ${clip(p.domain, 80)}.`);
  } else warnings.push('У повідомленні немає поля URI.');
  if (account && !same(p.address, account)) bad(`Адреса у повідомленні (${clip(p.address, 50)}) не збігається з рахунком, яким підписуєте.`);
  if (p.fields.Version !== '1') warnings.push(`Нестандартна версія SIWE (${clip(p.fields.Version || '—', 10)}).`);
  if (chainId !== undefined && p.fields['Chain ID'] !== undefined && Number(p.fields['Chain ID']) !== Number(chainId)) warnings.push(`Мережа в повідомленні (${clip(p.fields['Chain ID'], 12)}) відрізняється від поточної (${chainId}).`);
  if (!p.fields.Nonce || p.fields.Nonce.length < 8) warnings.push('Одноразове число (Nonce) відсутнє або занадто коротке: сайт не захищений від повторного використання підпису.');
  const ts = (k) => { const v = p.fields[k]; const d = v ? Date.parse(v) : NaN; return Number.isFinite(d) ? d : null; };
  const issued = ts('Issued At'), exp = ts('Expiration Time'), nbf = ts('Not Before');
  if (exp !== null && exp < now) warnings.push('Термін дії повідомлення вже минув.');
  if (nbf !== null && nbf > now + 5 * 60000) warnings.push('Повідомлення ще не набуло чинності (Not Before у майбутньому).');
  if (issued !== null && Math.abs(now - issued) > 24 * 3600000) warnings.push('Час створення повідомлення (Issued At) сильно відрізняється від поточного.');
  if (exp !== null && exp - (issued || now) > 30 * 24 * 3600000) warnings.push('Сесія дуже довга (понад 30 днів).');
  if (/\b(transfer|approve|send|spend|all (my|your)|withdraw)\b/i.test(p.statement)) warnings.push('У тексті входу згадуються перекази чи дозволи: звичайний вхід такого не містить.');
  if (p.resources.length > 5) warnings.push(`У повідомленні багато ресурсів (${p.resources.length}): сайт просить широкий доступ.`);
  const lines = [['Тип', 'Вхід через Ethereum (SIWE)'], ['Домен у повідомленні', clip(p.domain, 80)], ['Адреса', clip(p.address, 50)]];
  if (p.statement) lines.push(['Заява', clip(p.statement, 300)]);
  if (p.fields['Chain ID']) lines.push(['Мережа (Chain ID)', clip(p.fields['Chain ID'], 12)]);
  if (p.fields.Nonce) lines.push(['Nonce', clip(p.fields.Nonce, 40)]);
  if (p.fields['Expiration Time']) lines.push(['Діє до', clip(p.fields['Expiration Time'], 40)]);
  if (p.resources.length) lines.push(['Ресурси', clip(p.resources.join(', '), 300)]);
  return { lines, warnings, danger };
}

// ---------- підписи дозволів і ордери ----------
const fmtTs = (v, now) => {
  const n = big(v);
  if (n === null) return { text: '—', far: false, none: false };
  if (n === 0n) return { text: 'одразу минає (0)', far: false, none: false };
  if (n > MAX_SANE_TS) return { text: 'без обмеження', far: true, none: true };
  const far = Number(n) > Math.floor(now / 1000) + YEAR;
  return { text: new Date(Number(n) * 1000).toISOString().replace('.000Z', 'Z') + (far ? ' (понад рік)' : ''), far, none: false };
};
const fmtAmount = (v, max, tk) => {
  const n = big(v);
  if (n === null) return { text: '—', unlimited: false };
  if (n >= max) return { text: 'НЕОБМЕЖЕНО', unlimited: true };
  return { text: tk ? `${n.toString()} (у мінімальних одиницях; ${tk.symbol}, ${tk.decimals} знаків)` : `${n.toString()} (у мінімальних одиницях)`, unlimited: false };
};

// Адреси отримувачів дозволу (spender), щоб заздалегідь перевірити, контракт це чи звичайний рахунок
function permitSpenders(td) {
  const m = (td && td.message) || {};
  const out = new Set();
  for (const k of ['spender', 'operator']) { const a = addr(m[k]); if (a) out.add(a); }
  return [...out];
}
function permitTokens(td) {
  const m = (td && td.message) || {};
  const out = new Set();
  const a0 = addr(td && td.domain && td.domain.verifyingContract);
  if (/^Permit$/i.test(td.primaryType) && a0) out.add(a0);
  const grab = (x) => { const a = addr(x && x.token); if (a) out.add(a); };
  if (m.details) (Array.isArray(m.details) ? m.details : [m.details]).forEach(grab);
  if (m.permitted) (Array.isArray(m.permitted) ? m.permitted : [m.permitted]).forEach(grab);
  return [...out].slice(0, 10);
}

// ctx: { account, now, isContract: Map(адреса -> true|false), tokens: Map(адреса -> { symbol, decimals }) }
function describeTyped(td, ctx = {}) {
  const now = ctx.now || Date.now();
  const m = td.message || {};
  const p = String(td.primaryType || '');
  const lines = [];
  const warnings = [];
  let danger = false;
  const bad = (w) => { warnings.push(w); danger = true; };
  const tokOf = (a) => (ctx.tokens && a ? ctx.tokens.get(a) : null);
  const spenderCheck = (sp) => {
    if (!sp) return;
    const c = ctx.isContract && ctx.isContract.get(sp);
    if (c === false) bad(`Отримувач дозволу (${sp}) — звичайний рахунок, а не контракт. Справжні сервіси дають дозвіл контрактам; так діють шахраї.`);
  };
  const ownerCheck = (o) => { if (o && ctx.account && !same(o, ctx.account)) bad(`Власник токенів у даних (${o}) не збігається з вашим рахунком.`); };
  const permit2Check = () => {
    const vc = td.domain && td.domain.verifyingContract;
    if (!same(vc, PERMIT2)) bad(`verifyingContract (${clip(vc || '—', 50)}) не є офіційним Permit2 (${PERMIT2}).`);
  };

  if (/^Permit$/i.test(p) && (m.spender !== undefined)) {
    // EIP-2612 (value/deadline) або DAI-подібний (allowed/expiry)
    const owner = addr(m.owner || m.holder), spender = addr(m.spender);
    const token = addr(td.domain && td.domain.verifyingContract);
    lines.push(['Дія', 'Дозвіл витрачати токени без транзакції (permit)'], ['Токен', token || '—'], ['Отримувач дозволу', fmtSpender(spender, m.spender)]);
    if (m.allowed !== undefined) lines.push(['Дозвіл', m.allowed ? 'ДАТИ повний доступ до токена' : 'скасувати']);
    else { const a = fmtAmount(m.value, UNLIMITED_2612, tokOf(token)); lines.push(['Сума', a.text]); if (a.unlimited) bad('Необмежений дозвіл: отримувач зможе витратити ВСІ ваші токени цього типу.'); }
    if (m.allowed === true) bad('Повний доступ до токена: отримувач зможе витратити ВСІ ваші токени цього типу.');
    const d = fmtTs(m.deadline !== undefined ? m.deadline : m.expiry, now);
    lines.push(['Діє до', d.text]);
    if (d.far) warnings.push('Дозвіл діє дуже довго або без обмеження.');
    ownerCheck(owner); spenderCheck(spender);
  } else if (/^PermitSingle$|^PermitBatch$/i.test(p)) {
    // Permit2: дозвіл на кілька токенів з терміном
    const spender = addr(m.spender);
    const details = Array.isArray(m.details) ? m.details : [m.details || {}];
    lines.push(['Дія', 'Дозвіл Permit2 витрачати токени'], ['Отримувач дозволу', fmtSpender(spender, m.spender)]);
    details.slice(0, 10).forEach((dt, i) => {
      const t = addr(dt.token), a = fmtAmount(dt.amount, UINT160_MAX, tokOf(t)), e = fmtTs(dt.expiration, now);
      lines.push([details.length > 1 ? `Токен ${i + 1}` : 'Токен', t || clip(dt.token, 60)], ['Сума', a.text], ['Дозвіл діє до', e.text]);
      if (a.unlimited) bad('Необмежений дозвіл: отримувач зможе витратити ВСІ ваші токени цього типу.');
      if (e.far) warnings.push('Дозвіл діє дуже довго або без обмеження.');
    });
    const sd = fmtTs(m.sigDeadline, now);
    lines.push(['Підпис дійсний до', sd.text]);
    permit2Check(); spenderCheck(spender);
  } else if (/^Permit(Batch)?(Witness)?TransferFrom$/i.test(p)) {
    // Permit2: одноразовий переказ за підписом (віддає токени, навіть без approve)
    const spender = addr(m.spender);
    const permitted = Array.isArray(m.permitted) ? m.permitted : [m.permitted || {}];
    lines.push(['Дія', 'Підпис дозволяє ЗАБРАТИ токени (переказ за підписом, Permit2)'], ['Отримувач', fmtSpender(spender, m.spender)]);
    permitted.slice(0, 10).forEach((pt, i) => {
      const t = addr(pt.token), a = fmtAmount(pt.amount, UNLIMITED_2612, tokOf(t));
      lines.push([permitted.length > 1 ? `Токен ${i + 1}` : 'Токен', t || clip(pt.token, 60)], ['Максимальна сума', a.text]);
      if (a.unlimited) bad('Необмежена сума: отримувач зможе забрати ВСІ ваші токени цього типу.');
    });
    lines.push(['Підпис дійсний до', fmtTs(m.deadline, now).text]);
    bad('Цей підпис дозволяє отримувачу забрати токени без окремої транзакції від вас. Підписуйте лише на довіреному сервісі.');
    permit2Check(); spenderCheck(spender);
  } else if (/^OrderComponents$|^Order$/.test(p) && Array.isArray(m.offer) && Array.isArray(m.consideration)) {
    // Seaport: що ви віддаєте й що отримуєте
    const offerer = addr(m.offerer);
    const receives = m.consideration.filter(c => same(c.recipient, offerer)).reduce((s, c) => s + (big(c.startAmount) || 0n), 0n);
    lines.push(['Дія', 'Ордер маркетплейсу (Seaport): продаж чи обмін ваших активів'], ['Віддаєте (позицій)', String(m.offer.length)], ['Ви отримаєте (позицій)', String(m.consideration.filter(c => same(c.recipient, offerer)).length)]);
    if (m.offer.length && receives === 0n) bad('Ордер віддає ваші активи, а вам нічого не дає: це типова крадіжка. Не підписуйте.');
    ownerCheck(offerer);
  } else return null;
  return { lines, warnings, danger, kind: p };
}

// ---------- EIP-7702 ----------
const REJECT_METHODS = new Map([
  ['wallet_sendCalls', 'Пакетні виклики (wallet_sendCalls, EIP-5792) не підтримуються: вони виконують кілька дій одним підтвердженням. Надсилайте транзакції по одній.'],
  ['wallet_signAuthorization', 'Підпис делегування рахунку (EIP-7702) вимкнено: він віддає контроль над рахунком коду контракту.'],
  ['eth_signAuthorization', 'Підпис делегування рахунку (EIP-7702) вимкнено: він віддає контроль над рахунком коду контракту.'],
  ['wallet_sendTransaction', 'Метод не підтримується.'],
]);
function rejectReason(method) { return REJECT_METHODS.get(method) || null; }

// Транзакція з делегуванням (type 0x04 / authorizationList)
function hasDelegation(tx) {
  if (!tx || typeof tx !== 'object') return false;
  if (tx.authorizationList !== undefined || tx.authorization_list !== undefined) return true;
  return tx.type !== undefined && (tx.type === 4 || String(tx.type).toLowerCase() === '0x4' || String(tx.type).toLowerCase() === '0x04');
}
// Код рахунку виду 0xef0100 + адреса — рахунок уже делеговано (EIP-7702)
function delegateOf(code) {
  const m = /^0xef0100([0-9a-fA-F]{40})$/.exec(String(code || ''));
  return m ? getAddress('0x' + m[1]) : null;
}

module.exports = { checkSiwe, parseSiwe, describeTyped, permitSpenders, permitTokens, rejectReason, hasDelegation, delegateOf, PERMIT2, KNOWN_SPENDERS, spenderLabel, REJECT_METHODS };
