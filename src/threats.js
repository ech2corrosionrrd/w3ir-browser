'use strict';
// Захист від шахрайських сайтів — повністю локальний, без надсилання ваших адрес комусь:
//  1) відкриті списки (URLhaus — шкідливі хости, Phishing.Database і MetaMask eth-phishing-detect — фішингові домени) завантажуються на пристрій і зберігаються
//     компактно (8-байтові хеші, бінарний пошук);
//  2) евристики: підміна символів (омогліфи, IDN), схожість із відомими брендами, «paypal.com.evil.net», user@host-обман.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { domainToUnicode } = require('url');
const { parse: parseHost } = require('tldts-experimental');
const { writeAtomic } = require('./crypto-util');

const MAX_LIST_BYTES = 60 * 1024 * 1024;

// the body is read in chunks and cut off at the limit (a server without Content-Length cannot make us buffer more)
async function readCapped(res, max, id) {
  const tooBig = () => new Error(`${id}: список надто великий`);
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    if (Buffer.byteLength(text) > max) throw tooBig();
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { try { await reader.cancel(); } catch { /* ignore */ } throw tooBig(); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
const UPDATE_EVERY = 24 * 60 * 60 * 1000;

const SOURCES = [
  { id: 'urlhaus', kind: 'malware', title: 'URLhaus (abuse.ch)', url: 'https://urlhaus.abuse.ch/downloads/hostfile/' },
  { id: 'phishdb', kind: 'phishing', title: 'Phishing.Database', url: 'https://raw.githubusercontent.com/mitchellkrogza/Phishing.Database/master/phishing-domains-ACTIVE.txt' },
  // web3-фішинг (підроблені OpenSea/Uniswap/MetaMask тощо): JSON {blacklist:[домени]}
  { id: 'ethphish', kind: 'phishing', title: 'MetaMask eth-phishing-detect', format: 'json-blacklist', url: 'https://raw.githubusercontent.com/MetaMask/eth-phishing-detect/main/src/config.json' },
];

// ---------- бренди: назва → легітимні домени ----------
const BRANDS = {
  google: ['google.com', 'googleapis.com', 'gstatic.com', 'googleusercontent.com', 'goo.gl', 'withgoogle.com', 'android.com', 'chrome.com', 'web.dev', 'blogger.com'],
  gmail: ['gmail.com'], youtube: ['youtube.com', 'youtu.be', 'ytimg.com'],
  microsoft: ['microsoft.com', 'live.com', 'office.com', 'outlook.com', 'microsoftonline.com', 'windows.com', 'azure.com', 'bing.com', 'xbox.com', 'skype.com', 'msn.com', 'sharepoint.com', 'onedrive.com', 'office365.com'],
  outlook: [], office365: [],
  apple: ['apple.com', 'icloud.com', 'me.com', 'mzstatic.com'], icloud: [],
  amazon: ['amazon.com', 'amazonaws.com', 'awsstatic.com', 'primevideo.com'],
  paypal: ['paypal.com', 'paypal.me', 'paypalobjects.com'],
  facebook: ['facebook.com', 'fb.com', 'fbcdn.net', 'messenger.com', 'meta.com'], instagram: ['instagram.com', 'cdninstagram.com'],
  whatsapp: ['whatsapp.com', 'whatsapp.net'], twitter: ['twitter.com', 'x.com', 't.co', 'twimg.com'], linkedin: ['linkedin.com', 'licdn.com'],
  netflix: ['netflix.com', 'nflxso.net', 'nflximg.net'], spotify: ['spotify.com', 'scdn.co'],
  github: ['github.com', 'github.io', 'githubusercontent.com', 'githubassets.com', 'github.dev', 'githubapp.com'], gitlab: ['gitlab.com', 'gitlab.io'],
  dropbox: ['dropbox.com', 'dropboxusercontent.com'], adobe: ['adobe.com', 'adobelogin.com', 'typekit.net'],
  steam: ['steampowered.com', 'steamcommunity.com', 'steamstatic.com', 'valvesoftware.com'],
  discord: ['discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media'], telegram: ['telegram.org', 't.me', 'telegram.me', 'telegra.ph'],
  binance: ['binance.com', 'binance.us', 'binance.org', 'bnbstatic.com'], coinbase: ['coinbase.com', 'base.org'], kraken: ['kraken.com'],
  bybit: ['bybit.com'], okx: ['okx.com'], metamask: ['metamask.io', 'consensys.net', 'consensys.io'], trustwallet: ['trustwallet.com'],
  phantom: ['phantom.app', 'phantom.com'], uniswap: ['uniswap.org'], opensea: ['opensea.io'], ledger: ['ledger.com'], trezor: ['trezor.io'],
  blockchain: ['blockchain.com', 'blockchain.info'],
  etherscan: ['etherscan.io', 'bscscan.com', 'polygonscan.com', 'arbiscan.io', 'basescan.org', 'snowtrace.io'],
  privatbank: ['privatbank.ua'], privat24: ['privat24.ua'], monobank: ['monobank.ua'], novaposhta: ['novaposhta.ua', 'novapost.com'],
  olx: ['olx.ua', 'olx.com', 'olx.pl'], diia: ['diia.gov.ua'], rozetka: ['rozetka.com.ua'], ukrposhta: ['ukrposhta.ua'], oschadbank: ['oschadbank.ua'],
};
const LEGIT = new Set(Object.values(BRANDS).flat());
// Офіційні адреси бренду на чужому спільному домені (сервіс deep-link Branch): точний збіг хоста, піддомени не довіряються
const LEGIT_HOSTS = new Set(['metamask.app.link']);
const BRAND_NAMES = Object.keys(BRANDS);
const RISKY_WORDS = ['login', 'signin', 'secure', 'verify', 'verification', 'wallet', 'support', 'airdrop', 'claim', 'account', 'update', 'auth', 'connect', 'free', 'bonus', 'giveaway', 'recover', 'recovery', 'unlock', 'validate', 'confirm', 'helpdesk', 'official', 'vyplat', 'viplat'];

// схожі символи кирилиці/грецької → латиниця
const CONFUSABLE = { а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ї: 'i', ѕ: 's', ј: 'j', ԁ: 'd', һ: 'h', к: 'k', м: 'm', т: 't', в: 'b', н: 'h', ο: 'o', α: 'a', ν: 'v', ρ: 'p', τ: 't', ι: 'i', κ: 'k', ε: 'e', υ: 'u', χ: 'x', ɡ: 'g', ǃ: 'l', ⅼ: 'l', 'ı': 'i' };

const leet = (s) => s.replace(/0/g, 'o').replace(/1/g, 'l').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/\$/g, 's').replace(/rn/g, 'm').replace(/vv/g, 'w');
function within1(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (a.length < b.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

const isIp = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');
const hash8 = (s) => crypto.createHash('sha256').update(s).digest().readBigUInt64LE(0);
function has(sorted, h) {
  let lo = 0, hi = sorted.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; const v = sorted[mid]; if (v === h) return true; if (v < h) lo = mid + 1; else hi = mid - 1; }
  return false;
}

function parseList(text) {
  const out = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const tok = line.split(/\s+/).pop().toLowerCase().replace(/\.$/, '');
    if (tok.length <= 253 && /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(tok) && tok.includes('.') && tok !== 'localhost') out.add(tok);
  }
  return out;
}

class Threats {
  // shared: { lists, meta } — спільні для всіх профілів (завантажуються один раз)
  constructor({ dir, cfg, history, bookmarks, onChange = () => {}, sources = SOURCES, allowInsecure = false, shared }) {
    this.shared = shared || { lists: { malware: new BigUint64Array(0), phishing: new BigUint64Array(0) }, meta: { updated: 0, counts: {}, error: '' }, loaded: false };
    this.dir = dir;
    this.cfg = cfg;
    this.history = history;
    this.bookmarks = bookmarks;
    this.onChange = onChange;
    this.sources = sources;
    this.allowInsecure = allowInsecure;
    this.bypass = new Set();
    this.timer = null;
    this.running = null;
    this._known = null;
    if (!this.shared.loaded) { this.shared.loaded = true; this.load(); }
  }

  get lists() { return this.shared.lists; }
  set lists(v) { this.shared.lists = v; }
  get meta() { return this.shared.meta; }
  set meta(v) { this.shared.meta = v; }

  file(kind) { return path.join(this.dir, `threats-${kind}.bin`); }
  metaFile() { return path.join(this.dir, 'threats-meta.json'); }

  load() {
    try {
      this.meta = { ...this.meta, ...JSON.parse(fs.readFileSync(this.metaFile(), 'utf8')) };
      for (const kind of ['malware', 'phishing']) {
        const buf = fs.readFileSync(this.file(kind));
        this.lists[kind] = new BigUint64Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength - (buf.byteLength % 8)));
      }
    } catch { /* списків ще немає */ }
  }

  setLists({ malware = [], phishing = [] }) {
    const mk = (arr) => { const a = BigUint64Array.from(new Set(arr.map(d => hash8(String(d).toLowerCase())))); a.sort(); return a; };
    this.lists = { malware: mk(malware), phishing: mk(phishing) };
  }

  status() {
    return { updated: this.meta.updated, counts: { malware: this.lists.malware.length, phishing: this.lists.phishing.length }, error: this.meta.error, sources: this.sources.map(s => s.title) };
  }

  start() {
    this.stop();
    const age = Date.now() - (this.meta.updated || 0);
    setTimeout(() => { if (age > UPDATE_EVERY) this.update(); }, 15000);
    this.timer = setInterval(() => this.update(), UPDATE_EVERY);
  }
  stop() { clearInterval(this.timer); this.timer = null; }

  async update() {
    if (this.running) return this.running;
    this.running = (async () => {
      await null;
      try {
        const fresh = {};
        const counts = {};
        for (const src of this.sources) {
          if (!this.allowInsecure && !src.url.startsWith('https://')) throw new Error('insecure source');
          const res = await fetch(src.url, { signal: AbortSignal.timeout(90000), redirect: 'follow', headers: { 'User-Agent': 'W3IR-Browser' } });
          if (!res.ok) throw new Error(`${src.id}: HTTP ${res.status}`);
          if (!this.allowInsecure && res.url && !res.url.startsWith('https://')) throw new Error('insecure redirect');
          const len = Number(res.headers.get('content-length') || 0);
          if (len > MAX_LIST_BYTES) throw new Error(`${src.id}: список надто великий`);
          const text = await readCapped(res, MAX_LIST_BYTES, src.id);
          const set = src.format === 'json-blacklist' ? parseBlacklistJson(text) : parseList(text);
          if (set.size < 1) throw new Error(`${src.id}: порожній список`);
          const target = (fresh[src.kind] = fresh[src.kind] || new Set());
          for (const d of set) target.add(hash8(d));
          counts[src.id] = set.size;
        }
        for (const kind of Object.keys(fresh)) {
          const arr = BigUint64Array.from(fresh[kind]);
          arr.sort();
          writeAtomic(fs, this.file(kind), Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
          this.lists[kind] = arr;
        }
        this.meta = { updated: Date.now(), counts, error: '' };
        writeAtomic(fs, this.metaFile(), JSON.stringify(this.meta));
      } catch (e) {
        this.meta.error = String(e.message || e).slice(0, 200); // старі списки лишаються в силі
      } finally {
        this.running = null;
        this.onChange();
      }
    })();
    return this.running;
  }

  // Домени, якими користувач уже користується (закладки / часті відвідування) — для них евристики вимкнено
  knownDomains() {
    const h = this.history(), b = this.bookmarks();
    const stamp = (h.stamp !== undefined ? h.stamp : h.length) + ':' + b.length;
    if (this._known && this._known.stamp === stamp) return this._known.set;
    const counts = new Map();
    const dom = (u) => { try { return parseHost(new URL(u).hostname).domain || ''; } catch { return ''; } };
    for (const x of b) { const d = dom(x.url); if (d) counts.set(d, 99); }
    for (const x of h) { const d = dom(x.url); if (d) counts.set(d, (counts.get(d) || 0) + (x.n || 1)); }
    const set = new Set([...counts].filter(([, n]) => n >= 3).map(([d]) => d));
    this._known = { stamp, set };
    return set;
  }

  trusted(host) {
    const allow = (this.cfg().safeAllow || []);
    const dom = parseHost(host).domain || host;
    return allow.includes(dom) || allow.includes(host);
  }

  check(url) {
    let u;
    try { u = new URL(url); } catch { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase();
    if (this.bypass.has(host)) return null;

    // 1) списки: сам хост і його батьківські домени до зареєстрованого домену включно
    const parsed = parseHost(host);
    const base = parsed.domain || host;
    const labels = host.split('.');
    const stop = isIp(host) ? labels.length - 1 : Math.max(0, labels.length - base.split('.').length);
    const chain = isIp(host) ? [host] : labels.map((_, i) => labels.slice(i).join('.')).filter((_, i) => i <= stop);
    for (const d of chain) {
      const hh = hash8(d);
      if (has(this.lists.phishing, hh)) return { kind: 'phishing', severity: 'listed', host, reason: 'Сайт є у списках фішингових (шахрайських) ресурсів: він намагається виманити паролі, платіжні дані або доступ до гаманця.', canTrust: false };
      if (has(this.lists.malware, hh)) return { kind: 'malware', severity: 'listed', host, reason: 'Сайт розповсюджує шкідливе програмне забезпечення (за списком URLhaus).', canTrust: false };
    }

    // 2) евристики (не для користувацьких доменів із довіреного списку чи тих, якими ви часто користуєтесь)
    if (this.trusted(host)) return null;
    if (u.username && u.username.includes('.')) {
      return { kind: 'userinfo', severity: 'suspicious', host, reason: `Адреса містить «${u.username.slice(0, 40)}@» — це відомий обман: насправді ви відкриваєте сайт «${host}», а не те, що написано перед @.`, canTrust: true };
    }
    if (isIp(host)) return null;
    if (LEGIT.has(base) || (parsed.domain && LEGIT.has(parsed.domain)) || LEGIT_HOSTS.has(host)) return null;
    if (this.knownDomains().has(base)) return null;

    const uni = domainToUnicode(host);
    const uniLabels = uni.split('.');
    for (const label of uniLabels) {
      const scripts = ['Latin', 'Cyrillic', 'Greek'].filter(s => new RegExp(`\\p{Script=${s}}`, 'u').test(label));
      if (scripts.length > 1) return { kind: 'homograph', severity: 'suspicious', host, reason: `Назва домену «${uni}» змішує літери різних алфавітів (${scripts.join(' + ')}). Так підробляють відомі сайти: символи виглядають однаково, але це інша адреса.`, canTrust: true };
    }
    // уся назва з «двійників» латиниці, що збігається з брендом
    const nameUni = (domainToUnicode(base).split('.')[0] || '');
    if (/[^\x00-\x7f]/.test(nameUni)) {
      const mapped = [...nameUni].map(c => CONFUSABLE[c] || c).join('').replace(/-/g, '');
      const brand = BRAND_NAMES.find(b => mapped === b || (b.length >= 6 && within1(mapped, b)));
      if (brand && !/^[\x00-\x7f]*$/.test(nameUni)) return { kind: 'homograph', severity: 'suspicious', host, reason: `Назва домену «${nameUni}» складена з літер, що імітують «${brand}». Це може бути підробка.`, canTrust: true };
    }

    const name = base.split('.')[0];
    const sub = host.slice(0, Math.max(0, host.length - base.length)).split('.').filter(Boolean);
    // бренд у піддомені чужого домену: paypal.com.evil.net
    for (const label of sub) {
      const l = label.replace(/-/g, '');
      const b = BRAND_NAMES.find(x => x.length >= 4 && (l === x || label.startsWith(x + '-') || label.endsWith('-' + x)));
      if (b) return { kind: 'lookalike', severity: 'suspicious', host, reason: `Назва «${b}» стоїть у піддомені, але справжній домен сайту — «${base}». Це поширений прийом фішингу.`, canTrust: true };
    }
    const flat = name.replace(/-/g, '');
    const norm = leet(flat);
    for (const b of BRAND_NAMES) {
      if (name === b) continue;
      const typo = (norm === b && flat !== b) || (b.length >= 6 && within1(norm, b) && Math.abs(flat.length - b.length) <= 1 && flat !== b);
      if (typo) return { kind: 'lookalike', severity: 'suspicious', host, reason: `Домен «${base}» схожий на «${BRANDS[b][0] || b}», але ним не є. Перевірте адресу уважно.`, canTrust: true };
      if (b.length >= 5 && name.includes(b) && RISKY_WORDS.some(w => name.includes(w))) {
        return { kind: 'lookalike', severity: 'suspicious', host, reason: `Домен «${base}» поєднує назву «${b}» зі словами на кшталт «${RISKY_WORDS.find(w => name.includes(w))}» — типова ознака шахрайського сайту.`, canTrust: true };
      }
    }
    return null;
  }

  warningUrl(th, url) {
    const q = new URLSearchParams({ kind: th.kind, sev: th.severity, host: th.host, reason: th.reason, trust: th.canTrust ? '1' : '0', url: String(url).slice(0, 1500) });
    return 'w3ir://warning?' + q.toString();
  }
}

// JSON-конфіг eth-phishing-detect: беремо лише blacklist (whitelist і fuzzylist ігноруємо)
function parseBlacklistJson(text) {
  let j;
  try { j = JSON.parse(text); } catch { return new Set(); }
  return parseList(Array.isArray(j && j.blacklist) ? j.blacklist.filter(x => typeof x === 'string').join('\n') : '');
}

module.exports = { Threats, SOURCES, parseList, parseBlacklistJson, BRANDS };
