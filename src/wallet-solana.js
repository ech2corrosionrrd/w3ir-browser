'use strict';
// Solana-частина гаманця: підключення сайтів, підпис повідомлень і транзакцій, симуляція перед підтвердженням.
// Ключі виводяться з тієї самої фрази відновлення, що й EVM-адреси, лише на мить підпису й ніде не кешуються.
const { Mnemonic } = require('ethers');
const S = require('./solana');
const arweave = require('./arweave');
const { t: tr } = require('./i18n');

const CLUSTERS = {
  'mainnet-beta': { name: 'Mainnet Beta', chain: 'solana:mainnet', rpc: ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'], explorer: 'https://explorer.solana.com' },
  devnet: { name: 'Devnet', chain: 'solana:devnet', rpc: ['https://api.devnet.solana.com'], explorer: 'https://explorer.solana.com?cluster=devnet' },
  testnet: { name: 'Testnet', chain: 'solana:testnet', rpc: ['https://api.testnet.solana.com'], explorer: 'https://explorer.solana.com?cluster=testnet' },
};
const MAX_TXS = 10;
const SIM_TIMEOUT = 9000;

function install(Wallet, { RpcError, isSafeRpc, clip, unauthorized }) {
  const proto = Wallet.prototype;
  const b64 = (v, name, max) => {
    if (typeof v !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(v) || v.length > max) throw new RpcError(-32602, `Некоректне поле ${name}`);
    return Buffer.from(v, 'base64');
  };

  proto.solClusters = function () { return Object.entries(CLUSTERS).map(([id, c]) => ({ id, name: c.name, chain: c.chain })); };
  proto.solCluster = function (hint) {
    if (hint && CLUSTERS[hint]) return hint;
    const s = this.unlocked() && this.data() ? this.section().solCluster : null;
    return CLUSTERS[s] ? s : 'mainnet-beta';
  };
  proto.solClusterFromChain = function (chain) {
    if (chain === undefined || chain === null || chain === '') return null;
    const hit = Object.entries(CLUSTERS).find(([, c]) => c.chain === chain);
    if (!hit) throw new RpcError(-32602, 'Невідома мережа Solana');
    return hit[0];
  };
  proto.setSolCluster = function (id) {
    const s = this.data();
    if (!s || !CLUSTERS[id]) throw new Error('Невідома мережа Solana');
    s.solCluster = id;
    this.vault.persist();
  };
  proto.solRpcUrls = function (cluster) {
    const custom = this.unlocked() && this.data() ? (this.section().solRpc || {})[cluster] : null;
    return [custom, ...CLUSTERS[cluster].rpc].filter(Boolean).filter(u => this.allowInsecureRpc || isSafeRpc(u));
  };
  proto.setSolRpc = function (cluster, url) {
    const s = this.data();
    if (!s || !CLUSTERS[cluster]) throw new Error('Невідома мережа Solana');
    url = String(url || '').trim();
    if (url && !isSafeRpc(url)) throw new Error('RPC має бути https:// (або localhost).');
    s.solRpc = s.solRpc || {};
    if (url) s.solRpc[cluster] = url; else delete s.solRpc[cluster];
    this.vault.persist();
  };

  // JSON-RPC із запасними вузлами й тайм-аутом
  // fallbackOnError: для запитів лише на читання (баланси, токени) відмову вузла (ліміт, блокування методу) обходимо іншим вузлом
  proto.solRpc = async function (cluster, method, params, timeout = 10000, { fallbackOnError = false } = {}) {
    let last = null;
    for (const url of this.solRpcUrls(cluster)) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeout);
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ctl.signal });
        const j = await r.json();
        if (j.error) throw Object.assign(new Error(j.error.message || 'RPC'), { rpc: true, code: j.error.code, data: j.error.data });
        return j.result;
      } catch (e) {
        last = e;
        if (e.rpc && !fallbackOnError) throw e; // відповідь вузла (помилка транзакції) — не привід пробувати інший вузол
      } finally { clearTimeout(timer); }
    }
    throw last || new Error('Немає доступного RPC');
  };

  // ---------- адреси ----------
  proto._solSeed = function () {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    return Buffer.from(Mnemonic.fromPhrase(s.mnemonic).computeSeed().slice(2), 'hex');
  };
  proto.solAddresses = function () {
    const s = this.data();
    if (!s) return [];
    if (!Array.isArray(s.solAddresses) || s.solAddresses.length !== s.addresses.length) {
      const seed = this._solSeed();
      s.solAddresses = s.addresses.map((_, i) => S.deriveAccount(seed, i).address);
      this.vault.persist();
    }
    return s.solAddresses.slice();
  };
  proto._solKeypair = function (address) {
    const i = this.solAddresses().indexOf(address);
    if (i < 0) throw unauthorized('Невідомий рахунок');
    return S.deriveAccount(this._solSeed(), i);
  };
  proto.solAccountsFor = function (origin) {
    if (!this.unlocked() || !this.data()) return [];
    const c = (this.section().solConnections || {})[origin];
    return c && this.solAddresses().includes(c.address) ? [c.address] : [];
  };
  proto.solBalances = async function () {
    const cluster = this.solCluster();
    return Promise.all(this.solAddresses().map(async (address) => {
      try { const r = await this.solRpc(cluster, 'getBalance', [address, { commitment: 'confirmed' }], 8000, { fallbackOnError: true }); return { address, balance: S.sol(r.value), symbol: 'SOL' }; }
      catch { return { address, balance: null, symbol: 'SOL' }; }
    }));
  };
  proto.solInfo = function () {
    const s = this.data();
    if (!s) return null;
    return {
      addresses: this.solAddresses(), cluster: this.solCluster(), clusters: this.solClusters(),
      rpc: { ...(s.solRpc || {}) }, defaultRpc: Object.fromEntries(Object.entries(CLUSTERS).map(([k, v]) => [k, v.rpc[0]])),
      connections: Object.entries(s.solConnections || {}).map(([origin, c]) => ({ origin, address: c.address })),
    };
  };
  proto.solDisconnectSite = function (origin) {
    const s = this.data();
    if (s && s.solConnections && s.solConnections[origin]) { delete s.solConnections[origin]; this.vault.persist(); this.emit(origin, 'sol:disconnect', null); }
  };


  // ---------- токени SPL і NFT Metaplex ----------
  // Назви беруться з рахунків метаданих у блокчейні (їх задає творець токена: це недовірені рядки). Зображення NFT
  // завантажуються лише з шлюзів Arweave/Irys; інші адреси метаданих (https, ipfs) не відкриваються — це розкрило б вашу адресу стороннім.
  const ARWEAVE_URI = /^(?:ar:\/\/|https:\/\/(?:arweave\.net|gateway\.irys\.xyz|arweave\.dev)\/)([A-Za-z0-9_-]{43})(?:[/?#].*)?$/;

  proto.solTokens = async function (address, { maxMints = 60, maxImages = 12 } = {}) {
    if (!this.solAddresses().includes(address)) throw unauthorized('Невідомий рахунок');
    const cluster = this.solCluster();
    const byMint = new Map();
    for (const [programId, label] of [[S.PROGRAMS.TOKEN, 'SPL Token'], [S.PROGRAMS.TOKEN22, 'Token-2022']]) {
      const r = await this.solRpc(cluster, 'getTokenAccountsByOwner', [address, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }], 12000, { fallbackOnError: true });
      for (const acc of (r && r.value) || []) {
        const info = acc && acc.account && acc.account.data && acc.account.data.parsed && acc.account.data.parsed.info;
        if (!info || !S.isAddress(info.mint) || !info.tokenAmount || !/^\d+$/.test(String(info.tokenAmount.amount))) continue;
        const raw = BigInt(info.tokenAmount.amount);
        if (raw === 0n) continue;
        const decimals = Math.min(30, Math.max(0, Number(info.tokenAmount.decimals) | 0));
        const cur = byMint.get(info.mint) || { mint: info.mint, raw: 0n, decimals, program: label };
        cur.raw += raw;
        byMint.set(info.mint, cur);
      }
    }
    const all = [...byMint.values()];
    const list = all.slice(0, maxMints);
    // метадані: один запит getMultipleAccounts за всіма PDA
    if (list.length) {
      const pdas = list.map(t => S.metadataPda(t.mint));
      const r = await this.solRpc(cluster, 'getMultipleAccounts', [pdas, { encoding: 'base64', commitment: 'confirmed' }], 12000, { fallbackOnError: true }).catch(() => null);
      ((r && r.value) || []).forEach((acc, i) => {
        if (!acc || acc.owner !== S.METADATA_PROGRAM || !acc.data || typeof acc.data[0] !== 'string') return;
        const m = S.parseMetadata(Buffer.from(acc.data[0], 'base64'));
        if (m && m.mint === list[i].mint) Object.assign(list[i], { name: m.name, symbol: m.symbol, uri: m.uri });
      });
    }
    const out = list.map(t => ({
      mint: t.mint, program: t.program, decimals: t.decimals, amount: S.formatUnits(t.raw, t.decimals),
      nft: t.decimals === 0 && t.raw === 1n, name: clip(t.name || '', 64), symbol: clip(t.symbol || '', 16), uri: /^(https?:\/\/|ar:\/\/|ipfs:\/\/)/i.test(t.uri || '') ? clip(t.uri, 200) : '',
    }));
    // зображення NFT — лише зі сховища Arweave
    let n = 0;
    await Promise.all(out.filter(t => t.nft).map(async (t) => {
      const m = ARWEAVE_URI.exec(t.uri || '');
      if (!m || n++ >= maxImages) return;
      try {
        const meta = await Promise.race([arweave.fetchMetadata(m[1]), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))]);
        const img = String(meta.imageGateway || '');
        if (/^https:\/\/(arweave\.net|gateway\.irys\.xyz|arweave\.dev)\/[A-Za-z0-9_-]{43}/.test(img)) t.image = img;
        if (meta.name && !t.name) t.name = clip(meta.name, 64);
      } catch { /* метадані недоступні — показуємо без зображення */ }
    }));
    return { cluster, tokens: out, total: all.length, shown: out.length };
  };

  // Переказ SOL зі сторінки гаманця: транзакцію будує сам гаманець, а користувач підтверджує її у довіреному вікні з симуляцією
  proto.solSend = async function (win, sameTab, { index, to, amount }) {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    index = Number(index);
    const addresses = this.solAddresses();
    if (!Number.isInteger(index) || index < 0 || index >= addresses.length) throw new RpcError(-32602, 'Невідомий рахунок');
    if (typeof to !== 'string' || !S.isAddress(to)) throw new RpcError(-32602, 'Некоректна адреса отримувача.');
    let lamports;
    try { lamports = S.parseSol(amount); } catch (e) { throw new RpcError(-32602, e.message); }
    const from = addresses[index];
    if (from === to) throw new RpcError(-32602, 'Не можна надсилати на той самий рахунок.');
    const cluster = this.solCluster();
    let bh;
    try { bh = (await this.solRpc(cluster, 'getLatestBlockhash', [{ commitment: 'confirmed' }], 10000, { fallbackOnError: true })).value.blockhash; }
    catch (e) { throw new RpcError(-32000, `Не вдалося отримати blockhash: ${clip(e.message, 160)}`); }
    const message = S.buildTransferMessage({ from, to, lamports, blockhash: bh });
    const { warnings, danger } = this.recipientWarnings(to, addresses);
    if (!S.isOnCurve(S.b58decode(to))) warnings.push('Ця адреса не має приватного ключа (це адреса програми, PDA): кошти, надіслані на неї, зазвичай неможливо повернути.');
    const r = await this._solSignTransactions(win, 'w3ir://wallet', { transactions: [S.unsignedWire(message).toString('base64')] }, sameTab, true, { address: from, warnings, danger });
    this.rememberRecipient(to);
    return r.signature;
  };

  // ---------- запити сторінок ----------
  proto.solRequest = async function (win, tab, origin, method, p, sameTab) {
    p = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
    switch (method) {
      case 'solana_connect': return this._solConnect(win, origin, p, sameTab);
      case 'solana_disconnect': this.solDisconnectSite(origin); return null;
      case 'solana_signMessage': return this._solSignMessage(win, origin, p, sameTab);
      case 'solana_signTransaction': return this._solSignTransactions(win, origin, p, sameTab, false);
      case 'solana_signAndSendTransaction': return this._solSignTransactions(win, origin, p, sameTab, true);
      default: throw new RpcError(4200, `Метод не підтримується: ${clip(method, 40)}`);
    }
  };

  proto._solConnected = function (origin) {
    const acc = this.solAccountsFor(origin);
    if (!acc.length) throw unauthorized();
    return acc[0];
  };

  proto._solConnect = async function (win, origin, p, sameTab) {
    const have = this.solAccountsFor(origin);
    const pack = (address) => ({ address, publicKey: S.b58decode(address).toString('base64') });
    if (have.length) return pack(have[0]);
    if (p.onlyIfTrusted) throw unauthorized('Сайт ще не підключено до гаманця');
    const address = this.solAddresses()[0];
    await this.approve(win, origin, sameTab, {
      kind: 'connect', title: tr('Підключення до сайту'),
      lines: [['Сайт отримає', 'доступ до публічної адреси Solana та право пропонувати підписи'], ['Рахунок Solana', address], ['Мережа', CLUSTERS[this.solCluster()].name]],
      warnings: ['Сайт не зможе нічого підписати без вашого окремого підтвердження.'],
    });
    const s = this.section();
    s.solConnections = s.solConnections || {};
    s.solConnections[origin] = { address, since: Date.now() };
    this.vault.persist();
    this.log({ origin, action: 'Підключення Solana' });
    this.snapConns();
    this.emit(origin, 'sol:connect', pack(address));
    return pack(address);
  };

  proto._solSignMessage = async function (win, origin, p, sameTab) {
    const address = this._solConnected(origin);
    if (p.address && p.address !== address) throw unauthorized('Рахунок не підключено до цього сайту');
    const bytes = b64(p.message, 'message', 14000);
    if (!bytes.length || bytes.length > 10000) throw new RpcError(-32602, 'Некоректний розмір повідомлення');
    // повідомлення, що насправді є транзакцією, підписувати не можна: так обходять підтвердження транзакцій
    let looksLikeTx = false;
    try { S.parseMessage(bytes); looksLikeTx = true; } catch { /* не повідомлення транзакції */ }
    if (!looksLikeTx) { try { S.parseTransaction(bytes); looksLikeTx = true; } catch { /* не транзакція */ } }
    if (looksLikeTx) throw new RpcError(-32602, 'Дані схожі на транзакцію — підпис як «повідомлення» заборонено (використовуйте signTransaction)');
    let text = null;
    try { const t = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (/^[\P{C}\n\r\t]*$/u.test(t)) text = t; } catch { /* не текст */ }
    await this.approve(win, origin, sameTab, {
      kind: 'sign', title: tr('Підпис повідомлення'),
      lines: [['Рахунок Solana', address], ['Повідомлення', text !== null ? clip(text, 1500) : bytes.toString('hex').slice(0, 300)]],
      warnings: text === null ? ['Дані нечитабельні: підписуйте лише якщо повністю довіряєте сайту.'] : [],
    });
    const kp = this._solKeypair(address);
    const signature = S.sign(kp.secret, bytes);
    this.log({ origin, action: 'Підпис повідомлення Solana' });
    return { signature: signature.toString('base64'), address };
  };

  // Симуляція: що станеться з балансом SOL, перш ніж користувач підтвердить
  proto._solSimulate = async function (cluster, tx, address) {
    try {
      const wire = S.unsignedWire(tx.message).toString('base64');
      const [sim, bal] = await Promise.all([
        this.solRpc(cluster, 'simulateTransaction', [wire, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed', accounts: { encoding: 'base64', addresses: [address] } }], SIM_TIMEOUT),
        this.solRpc(cluster, 'getBalance', [address, { commitment: 'processed' }], SIM_TIMEOUT),
      ]);
      const v = sim && sim.value;
      if (!v) return { ok: false, text: 'немає відповіді' };
      if (v.err) return { ok: false, failed: true, text: clip(JSON.stringify(v.err), 160) };
      const after = v.accounts && v.accounts[0] ? BigInt(v.accounts[0].lamports) : null;
      const delta = after === null ? null : after - BigInt(bal.value);
      return { ok: true, delta, text: 'успішно' };
    } catch (e) { return { ok: false, text: clip(e.message || 'не вдалося виконати', 120) }; }
  };

  // opts.address — переказ зі сторінки гаманця (власний рахунок без підключеного сайту); opts.warnings/danger — додаткові попередження
  proto._solSignTransactions = async function (win, origin, p, sameTab, send, opts = {}) {
    const address = opts.address || this._solConnected(origin);
    if (opts.address && !this.solAddresses().includes(address)) throw unauthorized('Невідомий рахунок');
    if (p.address && p.address !== address) throw unauthorized('Рахунок не підключено до цього сайту');
    const list = Array.isArray(p.transactions) ? p.transactions : [];
    if (!list.length || list.length > MAX_TXS || (send && list.length !== 1)) throw new RpcError(-32602, 'Некоректна кількість транзакцій');
    const cluster = this.solClusterFromChain(p.chain) || this.solCluster();
    const txs = list.map((t) => {
      let tx;
      try { tx = S.parseTransaction(b64(t, 'transaction', 6000)); } catch (e) { throw new RpcError(-32602, `Некоректна транзакція: ${clip(e.message, 120)}`); }
      if (!tx.parsed.keys.slice(0, tx.parsed.numSigs).includes(address)) throw new RpcError(-32602, 'Ця транзакція не потребує підпису вашого рахунку');
      return tx;
    });
    const sims = await Promise.all(txs.map(tx => this._solSimulate(cluster, tx, address)));

    const lines = [['Мережа', CLUSTERS[cluster].name], ['Рахунок Solana', address]];
    const warnings = [...(opts.warnings || [])];
    let danger = !!opts.danger;
    txs.forEach((tx, i) => {
      const d = S.describe(tx.parsed, [address]);
      const head = txs.length > 1 ? `[${i + 1}/${txs.length}] ` : '';
      if (txs.length > 1) lines.push([`${head}Транзакція`, `${tx.parsed.instructions.length} інструкцій`]);
      for (const [k, v] of d.lines.slice(0, 14)) lines.push([head + k, v]);
      if (d.lines.length > 14) lines.push([head + '…', `ще ${d.lines.length - 14} рядків`]);
      d.warnings.forEach(w => warnings.push(head + w));
      if (d.danger) danger = true;
      const sim = sims[i];
      lines.push([head + 'Симуляція', sim.ok ? 'успішно' : `${sim.failed ? 'ПОМИЛКА' : 'не виконано'}: ${sim.text}`]);
      if (sim.ok && sim.delta !== null) lines.push([head + 'Зміна балансу SOL', `${sim.delta >= 0n ? '+' : '-'}${S.sol(sim.delta >= 0n ? sim.delta : -sim.delta)} SOL (разом із комісією)`]);
      if (sim.failed) { warnings.push(head + 'Симуляція показала, що транзакція завершиться помилкою — гроші можуть бути втрачені на комісію.'); danger = true; }
      else if (!sim.ok) warnings.push(head + 'Не вдалося симулювати транзакцію — наслідки не перевірено.');
      if (sim.ok && sim.delta !== null && sim.delta < 0n && -sim.delta > 0n && d.outgoing === 0n && -sim.delta > 5_000_000n) {
        warnings.push(head + `Баланс зменшиться на ${S.sol(-sim.delta)} SOL, хоча явного переказу SOL в інструкціях немає (так працюють і обміни через програми, і шахрайські транзакції).`);
      }
    });
    await this.approve(win, origin, sameTab, {
      kind: 'tx', title: send ? tr('Підтвердження транзакції') : tr('Підпис транзакції'), danger, lines, warnings,
    });

    const kp = this._solKeypair(address);
    const signed = txs.map(tx => S.signTransaction(kp.secret, address, tx.wire));
    if (!send) {
      this.log({ origin, action: `Підпис транзакції Solana (${signed.length})` });
      return { signedTransactions: signed.map(s => s.signedWire.toString('base64')), signatures: signed.map(s => S.b58encode(s.signature)) };
    }
    let signature;
    try {
      signature = await this.solRpc(cluster, 'sendTransaction', [signed[0].signedWire.toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 3 }], 15000);
    } catch (e) { throw new RpcError(-32000, `Не вдалося надіслати транзакцію: ${clip(e.message, 200)}`); }
    this.log({ origin, action: 'Транзакція Solana', hash: signature, chainId: cluster });
    return { signature, signedTransaction: signed[0].signedWire.toString('base64') };
  };
}

module.exports = { install, CLUSTERS };
