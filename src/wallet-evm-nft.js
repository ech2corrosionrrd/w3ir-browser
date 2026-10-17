'use strict';
// NFT на EVM (ERC-721 і ERC-1155): список, додавання за адресою контракту й id, пошук серед недавніх переказів, переказ
// на інший гаманець. Власність завжди перевіряється контрактом (ownerOf / balanceOf), а не журналом чи сторонніми API.
// Назви й зображення беруться лише з безпечних джерел (див. nft-meta.js); це недовірені дані творця NFT.
const { Interface, AbiCoder, getAddress, isAddress, zeroPadValue, id: topicId, ZeroAddress } = require('ethers');
const { injectionClean } = require('./token-text');
const meta = require('./nft-meta');

const ERC721 = new Interface([
  'function ownerOf(uint256) view returns (address)', 'function tokenURI(uint256) view returns (string)',
  'function name() view returns (string)', 'function symbol() view returns (string)',
  'function supportsInterface(bytes4) view returns (bool)',
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
]);
const ERC1155 = new Interface([
  'function balanceOf(address, uint256) view returns (uint256)', 'function uri(uint256) view returns (string)',
  'function supportsInterface(bytes4) view returns (bool)',
  'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)',
]);
const IID_721 = '0x80ac58cd';
const IID_1155 = '0xd9b67a26';
const T_721 = topicId('Transfer(address,address,uint256)');
const T_1155_SINGLE = topicId('TransferSingle(address,address,address,uint256,uint256)');
const T_1155_BATCH = topicId('TransferBatch(address,address,address,uint256[],uint256[])');
const MAX_SAVED = 100;
const MAX_ID = (1n << 256n) - 1n;
const CALL_TIMEOUT = 8000;
const coder = AbiCoder.defaultAbiCoder();

function install(Wallet, { RpcError, clip, unauthorized }) {
  const proto = Wallet.prototype;
  const timed = (p, ms = CALL_TIMEOUT) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

  const parseId = (v) => {
    if (typeof v !== 'string' || !/^\d{1,78}$/.test(v)) throw new RpcError(-32602, 'Некоректний id токена (ціле невід’ємне число).');
    const n = BigInt(v);
    if (n > MAX_ID) throw new RpcError(-32602, 'Занадто великий id токена.');
    return n;
  };
  const key = (c, i) => `${c}|${i}`;
  const savedList = (w, chainId) => { const s = w.section(); s.nfts = s.nfts || {}; return (s.nfts[chainId] = s.nfts[chainId] || []); };
  const hiddenList = (w, chainId) => { const s = w.section(); s.nftHidden = s.nftHidden || {}; return (s.nftHidden[chainId] = s.nftHidden[chainId] || []); };

  async function supports(w, chainId, contract, iid, iface) {
    try { return iface.decodeFunctionResult('supportsInterface', await w._ethCall(chainId, contract, iface.encodeFunctionData('supportsInterface', [iid])))[0] === true; } catch { return false; }
  }
  async function detectStandard(w, chainId, contract) {
    if (await supports(w, chainId, contract, IID_721, ERC721)) return 'erc721';
    if (await supports(w, chainId, contract, IID_1155, ERC1155)) return 'erc1155';
    throw new RpcError(-32602, 'Це не схоже на NFT-контракт (ERC-721 чи ERC-1155) у цій мережі.');
  }

  // { owned, amount } для рахунку owner
  async function ownership(w, chainId, e, owner) {
    if (e.standard === 'erc721') {
      const o = ERC721.decodeFunctionResult('ownerOf', await w._ethCall(chainId, e.contract, ERC721.encodeFunctionData('ownerOf', [BigInt(e.id)])))[0];
      return { owned: getAddress(o) === owner, amount: '1' };
    }
    const b = ERC1155.decodeFunctionResult('balanceOf', await w._ethCall(chainId, e.contract, ERC1155.encodeFunctionData('balanceOf', [owner, BigInt(e.id)])))[0];
    return { owned: b > 0n, amount: b.toString() };
  }

  async function describe(w, chainId, e, withImage) {
    const out = { contract: e.contract, id: e.id, standard: e.standard, name: '', collection: '', image: '', metadata: 'none' };
    try {
      if (e.standard === 'erc721') {
        out.collection = injectionClean(ERC721.decodeFunctionResult('symbol', await w._ethCall(chainId, e.contract, ERC721.encodeFunctionData('symbol')))[0], 24) || '';
        if (!out.collection) out.collection = injectionClean(ERC721.decodeFunctionResult('name', await w._ethCall(chainId, e.contract, ERC721.encodeFunctionData('name')))[0], 32) || '';
      }
    } catch { /* назви колекції немає */ }
    try {
      let uri = e.standard === 'erc721'
        ? ERC721.decodeFunctionResult('tokenURI', await w._ethCall(chainId, e.contract, ERC721.encodeFunctionData('tokenURI', [BigInt(e.id)])))[0]
        : ERC1155.decodeFunctionResult('uri', await w._ethCall(chainId, e.contract, ERC1155.encodeFunctionData('uri', [BigInt(e.id)])))[0];
      uri = meta.expandId(uri, e.id);
      if (!meta.resolveUri(uri)) { out.metadata = 'external'; return out; }
      const j = await timed(meta.loadJson(uri), 12000);
      if (!j) { out.metadata = 'external'; return out; }
      out.metadata = 'ok';
      out.name = injectionClean(String(j.name || ''), 64);
      if (withImage) {
        const img = String(j.image || j.image_url || '');
        try { out.image = img ? await timed(meta.loadImage(meta.expandId(img, e.id)), 12000) : ''; } catch { out.image = ''; }
      }
    } catch { out.metadata = out.metadata === 'none' ? 'unavailable' : out.metadata; }
    return out;
  }

  // NFT рахунку у вибраній мережі: збережені (додані вручну чи знайдені), лише ті, що справді належать рахунку
  proto.evmNfts = async function (index, { maxItems = 40, maxImages = 12 } = {}) {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    const owner = this.evmAccount(index);
    const chainId = this.activeChain();
    const list = savedList(this, chainId).slice(0, maxItems);
    const checked = await Promise.all(list.map(async (e) => {
      try { const o = await ownership(this, chainId, e, owner); return o.owned ? { e, amount: o.amount } : null; } catch { return null; }
    }));
    const owned = checked.filter(Boolean);
    let imgs = 0;
    const items = await Promise.all(owned.map(async ({ e, amount }) => ({ ...(await describe(this, chainId, e, imgs++ < maxImages)), amount })));
    return { chainId, items, saved: list.length };
  };

  proto.addNft = async function (contract, tokenId) {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    if (typeof contract !== 'string' || !isAddress(contract)) throw new RpcError(-32602, 'Некоректна адреса контракту NFT.');
    const idn = parseId(String(tokenId));
    const chainId = this.activeChain();
    const addr = getAddress(contract);
    const list = savedList(this, chainId);
    const existing = list.find(x => x.contract === addr && x.id === idn.toString());
    if (existing) return existing;
    const standard = await detectStandard(this, chainId, addr);
    if (standard === 'erc721') {
      try { await ownership(this, chainId, { contract: addr, id: idn.toString(), standard }, ZeroAddress); }
      catch { throw new RpcError(-32602, 'Такого токена в цьому контракті немає.'); }
    }
    if (list.length >= MAX_SAVED) throw new RpcError(-32602, `Не більше ${MAX_SAVED} збережених NFT на мережу.`);
    const e = { contract: addr, id: idn.toString(), standard };
    list.push(e);
    const h = hiddenList(this, chainId); const hi = h.indexOf(key(addr, e.id)); if (hi >= 0) h.splice(hi, 1);
    this.vault.persist();
    return e;
  };

  proto.removeNft = function (contract, tokenId) {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    const chainId = this.activeChain();
    const list = savedList(this, chainId);
    const i = list.findIndex(x => x.contract === contract && x.id === String(tokenId));
    if (i < 0) return false;
    list.splice(i, 1);
    const h = hiddenList(this, chainId);
    h.push(key(contract, String(tokenId)));
    if (h.length > 500) h.splice(0, h.length - 500); // приховані (щоб пошук не повертав їх) — з обмеженням
    this.vault.persist();
    return true;
  };

  // Пошук NFT серед недавніх вхідних переказів (журнали Transfer). Це наближений пошук: публічні RPC обмежують діапазон журналів,
  // тому охоплюється лише останній проміжок блоків. Усе знайдене перевіряється контрактом.
  proto.discoverNfts = async function (index, { blocks = 40000, chunk = 5000, maxLogs = 1500 } = {}) {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    const owner = this.evmAccount(index);
    const chainId = this.activeChain();
    const provider = this.provider(chainId);
    let head;
    try { head = await timed(provider.getBlockNumber(), 8000); } catch (e) { throw new RpcError(-32000, `Не вдалося отримати номер блоку: ${clip(e.message, 120)}`); }
    const ownerTopic = zeroPadValue(owner, 32);
    const found = new Map();
    let partial = false, logsSeen = 0;
    for (let to = head; to > head - blocks && to >= 0 && logsSeen < maxLogs; to -= chunk) {
      const from = Math.max(0, to - chunk + 1);
      try {
        const [l721, l1155s, l1155b] = await timed(Promise.all([
          provider.getLogs({ fromBlock: from, toBlock: to, topics: [T_721, null, ownerTopic] }),
          provider.getLogs({ fromBlock: from, toBlock: to, topics: [T_1155_SINGLE, null, null, ownerTopic] }),
          provider.getLogs({ fromBlock: from, toBlock: to, topics: [T_1155_BATCH, null, null, ownerTopic] }),
        ]), 20000);
        for (const l of l721) {
          if (l.topics.length !== 4) continue; // ERC-20 Transfer має 3 теми: це не NFT
          logsSeen++;
          found.set(key(getAddress(l.address), BigInt(l.topics[3]).toString()), { contract: getAddress(l.address), id: BigInt(l.topics[3]).toString(), standard: 'erc721' });
        }
        for (const l of l1155s) {
          logsSeen++;
          try { const [idv] = coder.decode(['uint256', 'uint256'], l.data); found.set(key(getAddress(l.address), idv.toString()), { contract: getAddress(l.address), id: idv.toString(), standard: 'erc1155' }); } catch { /* пропускаємо */ }
        }
        for (const l of l1155b) {
          logsSeen++;
          try { const [ids] = coder.decode(['uint256[]', 'uint256[]'], l.data); for (const idv of ids.slice(0, 50)) found.set(key(getAddress(l.address), idv.toString()), { contract: getAddress(l.address), id: idv.toString(), standard: 'erc1155' }); } catch { /* пропускаємо */ }
        }
      } catch { partial = true; break; }
    }
    const list = savedList(this, chainId);
    const hidden = new Set(hiddenList(this, chainId));
    let added = 0, checked = 0;
    for (const e of found.values()) {
      if (checked >= 120 || list.length >= MAX_SAVED) { partial = true; break; }
      if (hidden.has(key(e.contract, e.id)) || list.some(x => x.contract === e.contract && x.id === e.id)) continue;
      checked++;
      try { const o = await ownership(this, chainId, e, owner); if (o.owned) { list.push(e); added++; } } catch { /* токен більше не існує */ }
    }
    if (added) this.vault.persist();
    return { chainId, added, scanned: Math.min(blocks, head + 1), partial, candidates: found.size };
  };

  // Переказ NFT на інший гаманець зі сторінки гаманця: окреме довірене вікно з усіма даними
  proto.sendNft = async function (win, sameTab, { index, contract, tokenId, to, amount, speed }) {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    const owner = this.evmAccount(index);
    if (typeof contract !== 'string' || !isAddress(contract)) throw new RpcError(-32602, 'Некоректна адреса контракту NFT.');
    if (typeof to !== 'string' || !isAddress(to)) throw new RpcError(-32602, 'Некоректна адреса отримувача (або неправильна контрольна сума регістру).');
    const idn = parseId(String(tokenId));
    const nftAddr = getAddress(contract);
    const toAddr = getAddress(to);
    if (toAddr === ZeroAddress) throw new RpcError(-32602, 'Адреса отримувача нульова: NFT було б знищено.');
    if (toAddr === nftAddr) throw new RpcError(-32602, 'Це адреса контракту самого NFT: токен, надісланий на неї, зазвичай втрачається.');
    if (toAddr === owner) throw new RpcError(-32602, 'Не можна надсилати на той самий рахунок.');
    const chainId = this.activeChain();
    const saved = savedList(this, chainId).find(x => x.contract === nftAddr && x.id === idn.toString());
    const standard = saved ? saved.standard : await detectStandard(this, chainId, nftAddr);
    const e = { contract: nftAddr, id: idn.toString(), standard };
    let qty = 1n;
    if (standard === 'erc1155') {
      if (typeof amount !== 'string' || !/^\d{1,30}$/.test(amount) || BigInt(amount) < 1n) throw new RpcError(-32602, 'Кількість має бути цілим числом, більшим за нуль.');
      qty = BigInt(amount);
    }
    let own;
    try { own = await ownership(this, chainId, e, owner); } catch (err) { throw new RpcError(-32000, `Не вдалося перевірити власника NFT: ${clip(err.shortMessage || err.message, 160)}`); }
    if (!own.owned) throw new RpcError(-32602, 'Цей NFT не належить вибраному рахунку.');
    if (qty > BigInt(own.amount)) throw new RpcError(-32602, `Недостатньо: на рахунку ${own.amount} шт.`);
    const { warnings, danger } = this.recipientWarnings(toAddr, this.ownEvm());
    try {
      const code = await timed(this.provider(chainId).getCode(toAddr), 6000);
      if (code && code !== '0x') warnings.push('Отримувач — смарт-контракт: якщо він не вміє приймати NFT, переказ буде відхилено контрактом (комісія за невдалу спробу сплачується). Надсилайте лише якщо впевнені.');
    } catch { /* RPC недоступний: перевірку пропущено */ }
    const net = this.network(chainId);
    const data = standard === 'erc721'
      ? ERC721.encodeFunctionData('safeTransferFrom', [owner, toAddr, idn])
      : ERC1155.encodeFunctionData('safeTransferFrom', [owner, toAddr, idn, qty, '0x']);
    const summary = [['NFT', `${standard === 'erc721' ? 'ERC-721' : 'ERC-1155'} · контракт ${nftAddr}`], ['ID токена', idn.toString()], ...(standard === 'erc1155' ? [['Кількість', qty.toString()]] : []), ['Отримувач', toAddr], ['Мережа NFT', `${net.name} (${chainId})`]];
    const hash = await this.sendTransaction(win, 'w3ir://wallet', { from: owner, to: nftAddr, data }, sameTab, { internal: true, warnings, danger, summary, action: `Переказ NFT #${clip(idn.toString(), 12)}`, speed });
    this.rememberRecipient(toAddr);
    return hash;
  };
}

module.exports = { install, ERC721, ERC1155 };
