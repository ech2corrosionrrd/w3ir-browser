'use strict';

/**
 * W3IR Browser — Модуль децентралізованого сховища Arweave (Irys)
 *
 * Відповідає за:
 * - Валідацію та розбір адрес протоколу ar://<txId>
 * - Резолвінг даних через пул шлюзів (Irys / Arweave)
 * - Отримання та кешування метаданих NFT
 * - Запити до Arweave GraphQL API для отримання тегів транзакцій
 */

// Базовий вираз для валідації 43-значного base64url хешу Arweave
const TXID_RE = /^[a-zA-Z0-9_-]{43}$/;

// Пул шлюзів Arweave: першим стоїть Irys (згідно з директивою проєкту), далі резервні вузли
const DEFAULT_GATEWAYS = [
  'https://gateway.irys.xyz',
  'https://arweave.net',
  'https://arweave.dev'
];

// Кеш метаданих для уникнення повторних мережевих запитів
const metadataCache = new Map();
const MAX_CACHE = 150;

function isValidTxId(id) {
  if (typeof id !== 'string') return false;
  return TXID_RE.test(id.trim());
}

/**
 * Розбирає адресу ar://... на txId, шлях та параметри запиту.
 * Приклад: ar://bNbA1Gm7bYTeWhnvDYAG3L4694u35P-P7rF6gB1Y-3A/image.png?size=large
 */
function parseArweaveUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  const str = rawUrl.trim();
  const m = /^ar:\/\/([a-zA-Z0-9_-]{43})(?:([/?#].*))?$/.exec(str);
  if (!m) return null;
  const txId = m[1];
  const rest = m[2] || '';
  let pathname = '';
  let search = '';

  const qIdx = rest.indexOf('?');
  const hIdx = rest.indexOf('#');
  const splitIdx = (qIdx !== -1 && hIdx !== -1) ? Math.min(qIdx, hIdx) : (qIdx !== -1 ? qIdx : hIdx);

  if (splitIdx !== -1) {
    pathname = rest.slice(0, splitIdx);
    search = rest.slice(splitIdx);
  } else {
    pathname = rest;
  }

  return {
    txId,
    pathname: pathname.startsWith('/') ? pathname : (pathname ? '/' + pathname : ''),
    search,
    href: `ar://${txId}${pathname}${search}`
  };
}

function formatArweaveUrl(txId, pathname = '') {
  if (!isValidTxId(txId)) throw new Error('Invalid Arweave transaction ID');
  const p = pathname ? (pathname.startsWith('/') ? pathname : '/' + pathname) : '';
  return `ar://${txId}${p}`;
}

function resolveGatewayUrl(txId, pathname = '', gatewayIndex = 0) {
  if (!isValidTxId(txId)) throw new Error('Invalid Arweave transaction ID');
  const base = DEFAULT_GATEWAYS[gatewayIndex] || DEFAULT_GATEWAYS[0];
  const p = pathname ? (pathname.startsWith('/') ? pathname : '/' + pathname) : '';
  return `${base}/${txId}${p}`;
}

function toGatewayUrl(url, gatewayIndex = 0) {
  const parsed = parseArweaveUrl(url);
  if (!parsed) return url;
  return resolveGatewayUrl(parsed.txId, parsed.pathname + parsed.search, gatewayIndex);
}

/**
 * Завантажує дані транзакції з каскадним переходом на резервні шлюзи при збоях
 */
async function fetchWithFallback(txId, pathname = '', options = {}, fetchFn = globalThis.fetch) {
  if (!isValidTxId(txId)) throw new Error('Invalid Arweave transaction ID');
  const timeoutMs = options.timeout || 10000;
  let lastErr = null;

  for (let i = 0; i < DEFAULT_GATEWAYS.length; i++) {
    const targetUrl = resolveGatewayUrl(txId, pathname, i);
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const resp = await fetchFn(targetUrl, {
        ...options,
        signal: controller ? controller.signal : undefined
      });
      if (timer) clearTimeout(timer);
      if (resp.ok) {
        return {
          response: resp,
          gateway: DEFAULT_GATEWAYS[i],
          url: targetUrl
        };
      }
      // Якщо 404 на одному шлюзі, інший шлюз може мати закешований блок
      lastErr = new Error(`HTTP ${resp.status} on ${DEFAULT_GATEWAYS[i]}`);
    } catch (err) {
      if (timer) clearTimeout(timer);
      lastErr = err;
    }
  }
  throw lastErr || new Error('All Arweave gateways failed');
}

/**
 * Обробник для protocol.handle('ar', ...) в Electron
 */
async function handleProtocolRequest(parsed, fetchFn = globalThis.fetch) {
  const { response } = await fetchWithFallback(parsed.txId, parsed.pathname + parsed.search, {}, fetchFn);
  // Передаємо відповідь шлюзу безпосередньо у вікно браузера
  return response;
}

/**
 * Завантажує та нормалізує JSON-метадані NFT
 */
async function fetchMetadata(txId, fetchFn = globalThis.fetch) {
  if (!isValidTxId(txId)) throw new Error('Invalid Arweave transaction ID');

  if (metadataCache.has(txId)) {
    return metadataCache.get(txId);
  }

  const { response, gateway } = await fetchWithFallback(txId, '', {}, fetchFn);
  const len = Number((response.headers && typeof response.headers.get === 'function' && response.headers.get('content-length')) || 0);
  if (len > 2 * 1024 * 1024) throw new Error('Arweave metadata payload too large');
  const json = await response.json();
  const normalized = normalizeNftMetadata(json, txId, gateway);

  metadataCache.set(txId, normalized);
  if (metadataCache.size > MAX_CACHE) {
    const firstKey = metadataCache.keys().next().value;
    metadataCache.delete(firstKey);
  }

  return normalized;
}

/**
 * Нормалізація полів NFT (ERC-721/1155, Metaplex)
 */
function normalizeNftMetadata(raw, txId, gateway = DEFAULT_GATEWAYS[0]) {
  if (!raw || typeof raw !== 'object') {
    return { txId, name: 'Untitled Arweave Asset', description: '', image: '', imageGateway: '', attributes: [] };
  }

  let image = String(raw.image || raw.image_url || raw.imageUrl || '').trim();
  let imageGateway = '';

  // Дозволяємо лише безпечні адреси медіа (ar://, 43-символьний txId або https://)
  if (image.startsWith('ar://')) {
    imageGateway = toGatewayUrl(image);
  } else if (isValidTxId(image)) {
    const originalTx = image;
    image = `ar://${originalTx}`;
    imageGateway = `${gateway}/${originalTx}`;
  } else if (/^https:\/\//i.test(image)) {
    imageGateway = image;
  } else {
    image = '';
    imageGateway = '';
  }

  const attributes = Array.isArray(raw.attributes) ? raw.attributes : (Array.isArray(raw.traits) ? raw.traits : []);

  return {
    txId,
    arweaveUrl: `ar://${txId}`,
    gatewayUrl: `${gateway}/${txId}`,
    name: String(raw.name || 'Arweave NFT #' + txId.slice(0, 6)),
    description: String(raw.description || ''),
    image,
    imageGateway,
    attributes: attributes.map(a => ({
      trait_type: String(a.trait_type || a.name || 'Trait'),
      value: String(a.value != null ? a.value : '')
    })),
    raw
  };
}

/**
 * Запитує теги транзакції через Arweave GraphQL API
 */
async function fetchTags(txId, fetchFn = globalThis.fetch) {
  if (!isValidTxId(txId)) throw new Error('Invalid Arweave transaction ID');

  const query = {
    query: `{
      transactions(ids: ["${txId}"]) {
        edges {
          node {
            id
            tags { name value }
            data { size type }
            block { height timestamp }
            owner { address }
          }
        }
      }
    }`
  };

  for (const gw of DEFAULT_GATEWAYS) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 8000) : null;
    try {
      const resp = await fetchFn(`${gw}/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(query),
        signal: controller ? controller.signal : undefined
      });
      if (timer) clearTimeout(timer);
      if (!resp.ok) continue;
      const json = await resp.json();
      const node = json?.data?.transactions?.edges?.[0]?.node;
      if (node) {
        const tagsObj = {};
        for (const t of (node.tags || [])) {
          tagsObj[t.name] = t.value;
        }
        return {
          id: node.id,
          tags: tagsObj,
          dataSize: node.data?.size,
          contentType: tagsObj['Content-Type'] || node.data?.type || 'application/octet-stream',
          blockHeight: node.block?.height,
          timestamp: node.block?.timestamp,
          owner: node.owner?.address
        };
      }
    } catch {
      if (timer) clearTimeout(timer);
      // спробувати наступний шлюз
    }
  }
  return null;
}

module.exports = {
  TXID_RE,
  DEFAULT_GATEWAYS,
  isValidTxId,
  parseArweaveUrl,
  formatArweaveUrl,
  resolveGatewayUrl,
  toGatewayUrl,
  fetchWithFallback,
  handleProtocolRequest,
  fetchMetadata,
  fetchTags,
  normalizeNftMetadata
};
