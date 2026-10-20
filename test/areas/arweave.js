'use strict';
const { ok } = require('../lib');
const arweave = require('../../src/arweave');

async function arweaveTests(ctx) {
  // 1. Валідація ідентифікаторів транзакцій Arweave (43 символи base64url)
  const validId = 'bNbA1Gm7bYTeWhnvDYAG3L4694u35P-P7rF6gB1Y-3A';
  ok(arweave.isValidTxId(validId), 'arweave: дійсний txId (43 base64url) прийнято');
  ok(arweave.isValidTxId('wtEIL1CXdgchVjI7UDQ0e0TyPBc1owSOfH9X1VgwI6o'), 'arweave: інший дійсний 43-значний txId прийнято');
  ok(!arweave.isValidTxId('shortId123'), 'arweave: закороткий txId відхилено');
  ok(!arweave.isValidTxId('bNbA1Gm7bYTeWhnvDYAG3L4694u35P-P7rF6gB1Y-3A123'), 'arweave: задовгий txId відхилено');
  ok(!arweave.isValidTxId('bNbA1Gm7bYTeWhnvDYAG3L4694u35P+P7rF6gB1Y/3A'), 'arweave: txId з неприпустимими base64-символами (+/) відхилено');
  ok(!arweave.isValidTxId(null) && !arweave.isValidTxId(123), 'arweave: не-рядкові аргументи відхилено');

  // 2. Розбір адреси протоколу ar://
  const p1 = arweave.parseArweaveUrl(`ar://${validId}`);
  ok(p1 && p1.txId === validId && p1.pathname === '', 'arweave: розбір ar://<txId>');
  ok(p1.href === `ar://${validId}`, 'arweave: збереження повної адреси');

  const p2 = arweave.parseArweaveUrl(`ar://${validId}/images/banner.png?size=hd#section`);
  ok(p2 && p2.txId === validId && p2.pathname === '/images/banner.png' && p2.search === '?size=hd#section', 'arweave: розбір ar://<txId>/path?query#hash');

  ok(arweave.parseArweaveUrl('https://example.com') === null, 'arweave: не-ar адреси відхилено');
  ok(arweave.parseArweaveUrl('ar://invalidShort') === null, 'arweave: ar:// з невалідним txId відхилено');

  // 3. Форматування та резолвінг адрес
  ok(arweave.formatArweaveUrl(validId) === `ar://${validId}`, 'arweave: formatArweaveUrl без шляху');
  ok(arweave.formatArweaveUrl(validId, 'icon.png') === `ar://${validId}/icon.png`, 'arweave: formatArweaveUrl зі шляхом');

  const gw0 = arweave.resolveGatewayUrl(validId);
  ok(gw0.startsWith('https://gateway.irys.xyz/') && gw0.includes(validId), 'arweave: resolveGatewayUrl на шлюз Irys');
  const gw1 = arweave.resolveGatewayUrl(validId, '', 1);
  ok(gw1.startsWith('https://arweave.net/') && gw1.includes(validId), 'arweave: resolveGatewayUrl на шлюз Arweave.net');

  const converted = arweave.toGatewayUrl(`ar://${validId}/meta.json`);
  ok(converted === `https://gateway.irys.xyz/${validId}/meta.json`, 'arweave: toGatewayUrl коректно перетворює ar:// в HTTP шлюз');

  // 4. Нормалізація метаданих NFT
  const rawMeta = {
    name: 'CyberPunk #101',
    description: 'Generative art drop',
    image: 'ar://vHAXHLZ6EiCnLXA7ztmYROmE_2mXcdd5WQemo4oEuWg',
    attributes: [
      { trait_type: 'Rarity', value: 'Legendary' },
      { name: 'Power', value: 99 }
    ]
  };
  const norm = arweave.normalizeNftMetadata(rawMeta, validId);
  ok(norm.name === 'CyberPunk #101', 'arweave: назва NFT нормалізована');
  ok(norm.image.startsWith('ar://'), 'arweave: збережено оригінальне ar:// посилання на медіа');
  ok(norm.imageGateway.startsWith('https://gateway.irys.xyz/'), 'arweave: сформовано шлюзове посилання для показу зображення');
  ok(norm.attributes.length === 2 && norm.attributes[0].trait_type === 'Rarity' && norm.attributes[1].trait_type === 'Power', 'arweave: атрибути/трейти нормалізовано');
  const unsafeNorm = arweave.normalizeNftMetadata({ name: 'X', image: 'javascript:alert(1)' }, validId);
  ok(unsafeNorm.image === '' && unsafeNorm.imageGateway === '', 'arweave: небезпечні схеми зображень (javascript:) відхилено');

  // 5. Каскадний fallback при збоях шлюзів (fetchWithFallback)
  const failedCalls = [];
  const mockFetch = async (url) => {
    failedCalls.push(url);
    if (url.includes('gateway.irys.xyz')) {
      return { ok: false, status: 500, json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ name: 'Recovered NFT' })
    };
  };

  const fbRes = await arweave.fetchWithFallback(validId, '', {}, mockFetch);
  ok(fbRes.ok !== false && fbRes.gateway === 'https://arweave.net', 'arweave: каскадний перехід на резервний шлюз при помилці 500 першого');
  ok(failedCalls.length === 2, 'arweave: опитування наступного шлюзу при збої');

  // 6. Інтеграція в context: resolveInput та ключові слова
  if (ctx && ctx.resolveInput) {
    const directUrl = ctx.resolveInput(`ar://${validId}`);
    ok(directUrl === `ar://${validId}`, 'context: введення ar://<txId> розпізнається як нативна адреса');

    const kwUrl = ctx.resolveInput(`ar ${validId}`);
    ok(kwUrl === `ar://${validId}`, 'context: ключове слово «ar <txId>» перетворюється на ar://<txId>');
  }
}

module.exports = { arweaveTests };
