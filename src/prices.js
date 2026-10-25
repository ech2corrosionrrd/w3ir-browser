'use strict';
// Орієнтовні ціни в USD для гаманця (CoinGecko, публічний API без ключа). Ціни показуються у вікнах підтвердження й слугують
// для лімітів політики (сума, добовий ліміт, пауза великої суми). Якщо ціни немає, ліміт не блокує переказ, а лише додає попередження.
// На саме підписання вони не впливають. Назовні йдуть лише ідентифікатори монет, адреси
// контрактів токенів (публічні дані) і IP; адреси ваших рахунків не надсилаються. Відповіді недовірені: приймаються тільки
// скінченні додатні числа в розумних межах, розмір відповіді обмежений.
const API = 'https://api.coingecko.com/api/v3';
// Безкоштовний API має жорсткий ліміт запитів (десятки на хвилину), тож кеш довгий, а нативні монети запитуються разом
const TTL = 180000;
const FAIL_TTL = 60000;
const MAX_BODY = 200 * 1024;
const MAX_TOKENS = 50;

// chainId EVM -> ідентифікатор нативної монети CoinGecko (тестові мережі без цін)
const NATIVE_ID = { 1: 'ethereum', 10: 'ethereum', 8453: 'ethereum', 42161: 'ethereum', 56: 'binancecoin', 137: 'polygon-ecosystem-token', 43114: 'avalanche-2' };
// chainId EVM -> платформа токенів CoinGecko
const PLATFORM = { 1: 'ethereum', 10: 'optimistic-ethereum', 56: 'binance-smart-chain', 137: 'polygon-pos', 8453: 'base', 42161: 'arbitrum-one', 43114: 'avalanche' };
const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// нативні монети підтримуваних мереж: одна відповідь оновлює їх усі
const KNOWN_COINS = ['ethereum', 'solana', 'binancecoin', 'polygon-ecosystem-token', 'avalanche-2'];

const sane = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n < 1e12;

class Prices {
  constructor({ fetchImpl = (...a) => fetch(...a), now = () => Date.now(), timeout = 6000 } = {}) {
    this.fetch = fetchImpl;
    this.now = now;
    this.timeout = timeout;
    this.cache = new Map(); // ключ -> { at, value, ok }
    this.inflight = new Map(); // ключ запиту -> Promise (паралельні виклики діляться одним запитом)
  }

  async _get(path) {
    const res = await this.fetch(API + path, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(this.timeout), redirect: 'error' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    if (text.length > MAX_BODY) throw new Error('response too large');
    return JSON.parse(text);
  }

  _cached(key) {
    const c = this.cache.get(key);
    if (!c) return undefined;
    return this.now() - c.at < (c.ok ? TTL : FAIL_TTL) ? c : undefined;
  }

  _once(key, fn) {
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  // ціна нативної монети: coinId — з NATIVE_ID або 'solana'
  async native(coinId) {
    if (!/^[a-z0-9-]{2,40}$/.test(String(coinId || ''))) return null;
    const c = this._cached('n|' + coinId);
    if (c) return c.value;
    const ids = KNOWN_COINS.includes(coinId) ? KNOWN_COINS : [coinId];
    await this._once('n|' + ids.join(','), async () => {
      try {
        const j = await this._get(`/simple/price?ids=${ids.map(encodeURIComponent).join(',')}&vs_currencies=usd`);
        for (const id of ids) {
          const v = j && j[id] && j[id].usd;
          const value = sane(v) ? v : null;
          this.cache.set('n|' + id, { at: this.now(), value, ok: value !== null });
        }
      } catch {
        for (const id of ids) this.cache.set('n|' + id, { at: this.now(), value: null, ok: false });
      }
    });
    const after = this.cache.get('n|' + coinId);
    return after ? after.value : null;
  }

  // ціни токенів платформи: повертає { адреса (як у запиті): ціна }, лише знайдені
  async tokens(platform, addresses) {
    if (!/^[a-z0-9-]{2,40}$/.test(String(platform || ''))) return {};
    const isSol = platform === 'solana';
    const re = isSol ? SOL_ADDR : EVM_ADDR;
    const wanted = [...new Set((addresses || []).filter(a => typeof a === 'string' && re.test(a)))].slice(0, MAX_TOKENS);
    const out = {};
    const need = [];
    for (const a of wanted) {
      const c = this._cached(`t|${platform}|${isSol ? a : a.toLowerCase()}`);
      if (c) { if (c.value !== null) out[a] = c.value; } else need.push(a);
    }
    if (!need.length) return out;
    try {
      const j = await this._get(`/simple/token_price/${platform}?contract_addresses=${need.map(a => encodeURIComponent(isSol ? a : a.toLowerCase())).join(',')}&vs_currencies=usd`);
      for (const a of need) {
        const key = isSol ? a : a.toLowerCase();
        const entry = j && (j[key] || (!isSol && j[a]));
        const v = entry && entry.usd;
        const value = sane(v) ? v : null;
        this.cache.set(`t|${platform}|${key}`, { at: this.now(), value, ok: true });
        if (value !== null) out[a] = value;
      }
    } catch {
      for (const a of need) this.cache.set(`t|${platform}|${isSol ? a : a.toLowerCase()}`, { at: this.now(), value: null, ok: false });
    }
    return out;
  }
}

module.exports = { Prices, NATIVE_ID, PLATFORM };
