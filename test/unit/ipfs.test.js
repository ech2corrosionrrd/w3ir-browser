'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseIpfsUrl, handleProtocolRequest, gatewayUrl, GATEWAYS } = require('../../src/ipfs');

const V0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const V1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

test('ipfs: розбір CIDv0 і CIDv1 зі шляхом та запитом', () => {
  assert.deepEqual(parseIpfsUrl(`ipfs://${V0}`), { scheme: 'ipfs', id: V0, pathname: '', search: '' });
  assert.deepEqual(parseIpfsUrl(`ipfs://${V1}/dir/a.png?x=1#f`), { scheme: 'ipfs', id: V1, pathname: '/dir/a.png', search: '?x=1' });
});

test('ipns: ключ і доменне ім’я (DNSLink)', () => {
  assert.equal(parseIpfsUrl('ipns://docs.ipfs.tech/x').id, 'docs.ipfs.tech');
  assert.equal(parseIpfsUrl(`ipns://${V1}`).scheme, 'ipns');
});

test('ipfs: хибні адреси відхиляються', () => {
  for (const bad of ['ipfs://example.com', 'ipfs://Qm123', `ipfs://${V0}/../x`, `ipfs://${V0}/a/../b`, 'ipfs://', 'ipns://UPPER.com', `ipfs://${V0}/%00`.replace('%00', 'a b'), 'http://x', null, 5, `ipfs://${V0}${'/a'.repeat(5000)}`]) {
    assert.equal(parseIpfsUrl(bad), null, String(bad).slice(0, 40));
  }
});

test('ipfs: адреса шлюзу будується з перевіреного розбору', () => {
  const p = parseIpfsUrl(`ipfs://${V0}/a.txt`);
  assert.equal(gatewayUrl(p, 0), `${GATEWAYS[0]}/ipfs/${V0}/a.txt`);
  assert.equal(gatewayUrl(parseIpfsUrl('ipns://docs.ipfs.tech'), 1), `${GATEWAYS[1]}/ipns/docs.ipfs.tech`);
});

test('ipfs: при збої першого шлюзу береться наступний', async () => {
  const seen = [];
  const fetchFn = async (url) => {
    seen.push(url);
    return seen.length === 1 ? { ok: false, status: 504, url } : { ok: true, status: 200, url };
  };
  const r = await handleProtocolRequest(parseIpfsUrl(`ipfs://${V0}`), fetchFn);
  assert.equal(r.ok, true);
  assert.equal(seen.length, 2);
});

test('ipfs: перенаправлення за межі переліку шлюзів відхиляється', async () => {
  const fetchFn = async () => ({ ok: true, status: 200, url: 'https://evil.example/x' });
  await assert.rejects(handleProtocolRequest(parseIpfsUrl(`ipfs://${V0}`), fetchFn), /redirected/);
});

test('ipfs: піддомен шлюзу дозволено', async () => {
  const fetchFn = async () => ({ ok: true, status: 200, url: `https://${V1}.ipfs.dweb.link/` });
  const r = await handleProtocolRequest(parseIpfsUrl(`ipfs://${V1}`), fetchFn);
  assert.equal(r.ok, true);
});
