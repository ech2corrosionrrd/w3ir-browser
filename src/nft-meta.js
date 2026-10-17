'use strict';
// Метадані й зображення NFT з безпечних джерел: ончейн-дані (data:), IPFS і Arweave через відомі шлюзи. Довільні https-адреси
// метадані не відкриваються (інакше сервер творця дізнався б ваш IP і що ви дивитесь NFT). Зображення завантажує головний
// процес і віддає сторінці як data:-URL після перевірки типу й розміру, тож сторінка гаманця не звертається до мережі сама.
const IPFS_GATEWAYS = ['https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/'];
const AR_GATEWAYS = ['https://arweave.net/', 'https://gateway.irys.xyz/'];
const CID_RE = '(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,120})';
const AR_RE = '[A-Za-z0-9_-]{43}';
const EXT_RE = '(?:\\?ext=[A-Za-z0-9]{2,5})?'; // підказка типу файлу від шлюзів Irys/Arweave; інші запити не дозволені
const PATH_RE = '(?:/(?!\\.+(?:/|$))[A-Za-z0-9._~%@+=,-]{1,120}){0,6}';
const IPFS_URI = new RegExp(`^ipfs://(?:ipfs/)?(${CID_RE})(${PATH_RE})/?${EXT_RE}$`);
const IPFS_HTTP = new RegExp(`^https://(?:ipfs\\.io|dweb\\.link|cloudflare-ipfs\\.com|gateway\\.pinata\\.cloud|nftstorage\\.link)/ipfs/(${CID_RE})(${PATH_RE})/?${EXT_RE}$`);
const AR_URI = new RegExp(`^(?:ar://|https://(?:arweave\\.net|gateway\\.irys\\.xyz|arweave\\.dev)/)(${AR_RE})(${PATH_RE})/?${EXT_RE}$`);
const MAX_JSON = 256 * 1024;
const MAX_IMAGE = 6 * 1024 * 1024; // справжні NFT бувають кількамегабайтними; сторінка зменшує їх у пісочниці й відкидає оригінал
const MAX_DATA_URI = 600 * 1024;

// Повертає { urls: [...] } для шлюзових адрес, { data: Buffer, type } для data:, { https: url } для довільного https (лише з allowHttps —
// налаштуванням користувача) або null, якщо джерело не дозволене
function resolveUri(uri, { allowHttps = false } = {}) {
  if (typeof uri !== 'string' || uri.length > MAX_DATA_URI) return null;
  const u = uri.trim();
  if (/^data:/i.test(u)) {
    const m = /^data:([a-z]+\/[a-z0-9.+-]+)?((?:;[a-z0-9=-]+)*),(.*)$/is.exec(u);
    if (!m) return null;
    const type = (m[1] || 'text/plain').toLowerCase();
    try {
      const data = /;base64/i.test(m[2]) ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
      return data.length <= MAX_DATA_URI ? { data, type } : null;
    } catch { return null; }
  }
  let m = IPFS_URI.exec(u) || IPFS_HTTP.exec(u);
  if (m) return { urls: IPFS_GATEWAYS.map(g => g + m[1] + m[2]) };
  m = AR_URI.exec(u);
  if (m) return { urls: AR_GATEWAYS.map(g => g + m[1] + m[2]) };
  if (allowHttps && /^https:\/\/\S{1,2000}$/i.test(u)) return { https: u };
  return null;
}

async function fetchLimited(url, max, { fetchImpl, timeout = 8000, fetchPublic } = {}) {
  if (!fetchImpl) return (fetchPublic || require('./safe-fetch').fetchPublic)(url, { max, timeout });
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeout), redirect: 'error', headers: { accept: '*/*' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const len = Number(res.headers && res.headers.get && res.headers.get('content-length'));
  if (Number.isFinite(len) && len > max) throw new Error('file too large');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > max) throw new Error('file too large');
  return { buf, type: String((res.headers && res.headers.get && res.headers.get('content-type')) || '').split(';')[0].trim().toLowerCase() };
}

async function bytesOf(uri, max, opts) {
  const r = resolveUri(uri, { allowHttps: !!(opts && opts.allowHttps) });
  if (!r) return null;
  if (r.data) return r.data.length <= max ? { buf: r.data, type: r.type } : null;
  if (r.https) return fetchLimited(r.https, max, { ...opts, fetchImpl: undefined });
  let last;
  for (const url of r.urls) {
    try { return await fetchLimited(url, max, opts); } catch (e) { last = e; }
  }
  throw last || new Error('unavailable');
}

// JSON метадані токена (ERC-721/1155): повертає об'єкт або null, якщо джерело не дозволене
async function loadJson(uri, opts) {
  const b = await bytesOf(uri, MAX_JSON, opts);
  if (!b) return null;
  const j = JSON.parse(b.buf.toString('utf8').replace(/^﻿/, ''));
  return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
}

function sniffImage(buf) {
  if (buf.length < 12) return '';
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  const head = buf.toString('utf8', 0, 512).replace(/^﻿/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return '';
}

// Зображення як data:-URL або '' (недозволене джерело, не картинка, завелика). Тип визначається за вмістом, а не за заголовком
async function loadImage(uri, opts) {
  const b = await bytesOf(uri, MAX_IMAGE, opts);
  if (!b) return '';
  const mime = sniffImage(b.buf);
  if (!mime) return '';
  return `data:${mime};base64,${b.buf.toString('base64')}`;
}

// ERC-1155: у шаблоні адреси {id} підставляється 64 шістнадцяткові символи
const expandId = (uri, tokenId) => String(uri).replace(/\{id\}/g, BigInt(tokenId).toString(16).padStart(64, '0'));

module.exports = { resolveUri, loadJson, loadImage, expandId, sniffImage, IPFS_GATEWAYS, AR_GATEWAYS };
