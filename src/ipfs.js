'use strict';
// Протоколи ipfs:// та ipns:// через публічні шлюзи (за зразком ar://, src/arweave.js).
// Адреса розбирається суворо; запити йдуть лише до фіксованого переліку шлюзів. Вміст не перевіряється за хешем:
// користувач довіряє шлюзу (див. docs/ARCHITECTURE.md).

// CIDv0 (base58, регістр важливий), CIDv1 base32 (bafy…) і base36-ключі IPNS (k51…)
const CID_RE = '(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,120}|k[a-z0-9]{50,70})';
// Ім'я IPNS: ключ або доменне ім'я (DNSLink)
const DOMAIN_RE = '(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,24}';
const PATH_RE = '(?:/[A-Za-z0-9._~%@+=,:-]{1,200}){0,12}/?';
const URL_RE = new RegExp(`^(ipfs|ipns)://(${CID_RE}|${DOMAIN_RE})(${PATH_RE})(\\?[^#\\s]{0,500})?(#.*)?$`);

const GATEWAYS = ['https://ipfs.io', 'https://dweb.link', 'https://w3s.link'];
const GATEWAY_HOSTS = ['ipfs.io', 'dweb.link', 'w3s.link'];
const TIMEOUT = 15000;

const isCid = (s) => typeof s === 'string' && new RegExp(`^${CID_RE}$`).test(s);

// ipfs://<CID>[/шлях][?запит][#якір] або ipns://<ключ або домен>[…]; ipfs:// допускає лише CID
function parseIpfsUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2000) return null;
  const m = URL_RE.exec(raw.trim());
  if (!m) return null;
  const [, scheme, id, pathname, search = ''] = m;
  if (scheme === 'ipfs' && !isCid(id)) return null;
  if (/(^|\/)\.\.?(\/|$)/.test(pathname)) return null;
  return { scheme, id, pathname, search };
}

const gatewayUrl = (p, i = 0) => `${GATEWAYS[i]}/${p.scheme}/${p.id}${p.pathname}${p.search}`;
const allowedHost = (url) => {
  try { const h = new URL(url).hostname.toLowerCase(); return GATEWAY_HOSTS.some(g => h === g || h.endsWith('.' + g)); } catch { return false; }
};

// Перебирає шлюзи; перенаправлення (наприклад, на піддомен шлюзу) допускаються лише в межах того самого переліку
async function handleProtocolRequest(parsed, fetchFn = globalThis.fetch) {
  let lastErr = null;
  for (let i = 0; i < GATEWAYS.length; i++) {
    try {
      const resp = await fetchFn(gatewayUrl(parsed, i), { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) });
      if (resp.url && !allowedHost(resp.url)) { lastErr = new Error('gateway redirected outside the allowed list'); continue; }
      if (resp.ok) return resp;
      lastErr = new Error(`HTTP ${resp.status} on ${GATEWAYS[i]}`);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('No IPFS gateway responded');
}

module.exports = { parseIpfsUrl, handleProtocolRequest, gatewayUrl, isCid, GATEWAYS };
