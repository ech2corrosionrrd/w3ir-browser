'use strict';
// Запити сайтів до гаманця (EIP-1193): ліміт частоти, підключення, мережі, підписи й відправлення транзакцій.
// Методи змішуються в прототип Wallet (як і в інших wallet-*.js); спільні помічники передає wallet.js.
const { t: tr } = require('./i18n');
const guard = require('./wallet-signguard');
const { IFACE } = require('./wallet-evm-core');
const {
  formatEther, formatUnits, getAddress, isAddress, isHexString, hexlify, getBytes, TypedDataEncoder, toUtf8String, Wallet: EthWallet,
} = require('ethers');

function install(Wallet, { RpcError, rejected, unauthorized, clip, hexChain, isSafeRpc, READ_METHODS, describeCall }) {
  Object.assign(Wallet.prototype, {
    // ---------- запити від сторінок ----------
    throttle(origin) {
      const now = Date.now();
      const r = this.rate.get(origin) || { t: now, n: 0 };
      if (now - r.t > 1000) { r.t = now; r.n = 0; }
      r.n++;
      this.rate.set(origin, r);
      if (r.n > 40) throw new RpcError(-32005, 'Забагато запитів');
    },

    async request(win, tab, origin, req) {
      this.throttle(origin);
      if (!req || typeof req.method !== 'string' || req.method.length > 64) throw new RpcError(-32600, 'Некоректний запит');
      const method = req.method;
      let params = req.params === undefined ? [] : req.params;
      if (!Array.isArray(params)) params = params && typeof params === 'object' ? [params] : [];
      if (JSON.stringify(params).length > 262144) throw new RpcError(-32602, 'Запит надто великий');
      if (!this.exists()) {
        if (method === 'eth_chainId') return hexChain(this.activeChain());
        if (method === 'eth_accounts') return [];
        win.toast('Створіть гаманець у W3IR: меню → Гаманець');
        throw unauthorized('Гаманець не створено');
      }
      this.expireSites();
      this.touchSite(origin);
      const sameTab = () => win.tabs.includes(tab) && (() => { try { return new URL(tab.view.webContents.getURL()).origin === origin; } catch { return false; } })();
      if (method.startsWith('solana_')) return this.solRequest(win, tab, origin, method, params[0], sameTab);
      if (method.startsWith('arweave_')) return this.arRequest(win, tab, origin, method, params[0], sameTab);

      const blocked = guard.rejectReason(method);
      if (blocked) throw new RpcError(4200, blocked);
      switch (method) {
        case 'wallet_getCapabilities': return {};
        case 'eth_chainId': return hexChain(this.chainOf(origin));
        case 'net_version': return String(this.chainOf(origin));
        case 'web3_clientVersion': return 'W3IR-Wallet/1.0';
        case 'eth_accounts': return this.accountsFor(origin);
        case 'eth_requestAccounts': return this.requestAccounts(win, origin, sameTab);
        case 'wallet_getPermissions': return this.accountsFor(origin).length ? [{ parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: this.accountsFor(origin) }] }] : [];
        case 'wallet_requestPermissions': { await this.requestAccounts(win, origin, sameTab); return [{ parentCapability: 'eth_accounts' }]; }
        case 'wallet_switchEthereumChain': return this.switchChain(win, origin, params[0], sameTab);
        case 'wallet_addEthereumChain': return this.addChain(win, origin, params[0], sameTab);
        case 'wallet_watchAsset': {
          const a = params[0] && params[0].options ? params[0].options : {};
          const ok = await this.approve(win, origin, sameTab, {
            kind: 'asset', title: tr('Додати токен'), lines: [['Символ', clip(a.symbol, 20)], ['Контракт', clip(a.address, 60)]],
            warnings: ['Сайт просить показати токен у гаманці. Це не дає йому доступу до коштів.'],
          });
          return ok;
        }
        case 'personal_sign': return this.personalSign(win, origin, params, sameTab);
        case 'eth_signTypedData_v4': case 'eth_signTypedData': return this.signTyped(win, origin, params, sameTab);
        case 'eth_sendTransaction': return this.sendTransaction(win, origin, params[0], sameTab);
        case 'eth_sign': throw new RpcError(4200, 'eth_sign вимкнено з міркувань безпеки (дозволяє підписати довільні дані)');
        case 'eth_signTransaction': case 'eth_subscribe': case 'eth_unsubscribe': throw new RpcError(4200, 'Метод не підтримується');
        default:
          if (READ_METHODS.has(method)) {
            try { return await this.provider(this.chainOf(origin)).send(method, params); }
            catch (e) { throw e instanceof RpcError ? e : new RpcError(e.code || -32603, clip(e.shortMessage || e.message, 300)); }
          }
          throw new RpcError(4200, `Метод не підтримується: ${clip(method, 40)}`);
      }
    },

    accountsFor(origin) {
      if (!this.unlocked() || !this.data()) return [];
      const c = this.section().connections[origin];
      return c ? c.accounts.filter(a => this.isOwnEvm(a)) : [];
    },

    // Показ підтвердження у довіреному вікні; повертає true/кидає 4001
    async approve(win, origin, sameTab, spec) {
      const th = this.ctx.threats && this.ctx.cfg().safeBrowsing !== false ? this.ctx.threats.check(origin) : null;
      if (th && th.severity === 'listed') throw new RpcError(4100, 'Сайт у списку шахрайських ресурсів — гаманець не взаємодіє з ним');
      if (th) spec = { ...spec, danger: true, warnings: ['⚠ ' + th.reason, ...(spec.warnings || [])] };
      const r = await win.requestApproval({ ...spec, origin });
      if (!r.approved) throw rejected();
      if (!sameTab()) throw new RpcError(4001, 'Сторінку закрито або змінено під час підтвердження');
      return r;
    },

    // Авторизація сайту (eth_requestAccounts, wallet_requestPermissions): за налаштуванням walletAskAccount (типово ввімкнено) браузер щоразу
    // питає, яким рахунком увійти, навіть якщо сайт уже підключено. Тихі запити (eth_accounts) підтвердження не потребують.
    askAccountEveryTime() { return this.ctx.cfg().walletAskAccount !== false; },

    async requestAccounts(win, origin, sameTab) {
      const have = this.accountsFor(origin);
      if (have.length && !this.askAccountEveryTime()) return have;
      // один запит на сайт: повторні виклики, поки відкрито вікно підтвердження, отримують ту саму відповідь (без лавини вікон)
      this._connectPending = this._connectPending || new Map();
      if (this._connectPending.has(origin)) return this._connectPending.get(origin);
      const run = this._askConnect(win, origin, sameTab, have).finally(() => this._connectPending.delete(origin));
      this._connectPending.set(origin, run);
      return run;
    },

    async _askConnect(win, origin, sameTab, have) {
      // користувач вибирає серед усіх доступних рахунків, яким авторизуватись (докладно: pickDappAccount у wallet-import.js)
      const curChain = have.length ? this.chainOf(origin) : this.activeChain();
      const popts = {
        chain: 'evm', have, accountLabel: 'Рахунок', intro: 'доступ до адреси вашого рахунку та право пропонувати транзакції',
        network: () => (this.network(curChain) || {}).name || String(curChain),
        chains: { options: this.networks().map(n => ({ value: String(n.chainId), label: `${n.name} · ${n.symbol || ''}`.trim() })), value: String(curChain) },
      };
      const picked = await this.pickDappAccount(win, origin, sameTab, popts);
      const s = this.section();
      const pickedChain = this.network(popts.pickedChain) ? popts.pickedChain : curChain;
      if (have.length && have[0] === picked && pickedChain === curChain) { this.log({ origin, action: 'Авторизація' }); return have; } // той самий рахунок і мережа: підключення не змінюється
      const prevChain = have.length ? (s.connections[origin] || {}).chainId : null;
      s.connections[origin] = { accounts: [picked], chainId: pickedChain, since: Date.now() };
      this.vault.persist();
      this.log({ origin, action: have.length ? 'Авторизація іншим рахунком' : 'Підключення' });
      this.snapConns();
      this.emit(origin, 'accountsChanged', s.connections[origin].accounts);
      if (pickedChain !== prevChain) this.emit(origin, 'chainChanged', hexChain(pickedChain));
      return s.connections[origin].accounts.slice();
    },

    async switchChain(win, origin, p, sameTab) {
      const id = p && p.chainId ? Number(p.chainId) : NaN;
      if (!Number.isInteger(id)) throw new RpcError(-32602, 'Некоректний chainId');
      const net = this.network(id);
      if (!net) throw new RpcError(4902, 'Мережа не додана до гаманця');
      if (this.chainOf(origin) === id) return null;
      await this.approve(win, origin, sameTab, { kind: 'switch', title: tr('Зміна мережі'), lines: [['Нова мережа', `${net.name} (chainId ${id})`]], warnings: [] });
      const s = this.section();
      if (s.connections[origin]) s.connections[origin].chainId = id;
      this.vault.persist();
      this.emit(origin, 'chainChanged', hexChain(id));
      return null;
    },

    async addChain(win, origin, p, sameTab) {
      if (!p || typeof p !== 'object') throw new RpcError(-32602, 'Некоректні параметри');
      const id = Number(p.chainId);
      const rpc = Array.isArray(p.rpcUrls) ? p.rpcUrls.find(u => typeof u === 'string' && (this.allowInsecureRpc ? true : isSafeRpc(u))) : null;
      const sym = p.nativeCurrency && typeof p.nativeCurrency.symbol === 'string' ? p.nativeCurrency.symbol : '';
      const name = typeof p.chainName === 'string' ? p.chainName.replace(/[\u0000-\u001f]/g, ' ').slice(0, 60) : '';
      if (!Number.isInteger(id) || id <= 0 || id > 2 ** 53 || !rpc || !/^[A-Za-z0-9]{2,8}$/.test(sym) || !name) throw new RpcError(-32602, 'Некоректні параметри мережі (потрібні chainId, https rpcUrls, symbol, chainName)');
      const existing = this.network(id);
      if (existing) return this.switchChain(win, origin, { chainId: hexChain(id) }, sameTab);
      const explorer = Array.isArray(p.blockExplorerUrls) && typeof p.blockExplorerUrls[0] === 'string' && /^https:\/\//.test(p.blockExplorerUrls[0]) ? p.blockExplorerUrls[0].slice(0, 200) : '';
      await this.approve(win, origin, sameTab, {
        kind: 'addChain', title: tr('Додати мережу'),
        lines: [['Назва', name], ['chainId', String(id)], ['Валюта', sym], ['RPC', clip(rpc, 120)]],
        warnings: ['Через RPC-сервер мережі проходять усі ваші запити (адреси, баланси). Додавайте мережі лише з надійних джерел.'],
      });
      const s = this.section();
      s.networks.push({ chainId: id, name, symbol: sym, rpc, explorer });
      if (s.connections[origin]) s.connections[origin].chainId = id;
      this.vault.persist();
      this.emit(origin, 'chainChanged', hexChain(id));
      return null;
    },

    requireConnected(origin, address) {
      const acc = this.accountsFor(origin);
      if (!acc.length) throw unauthorized();
      if (address) {
        if (!isAddress(address)) throw new RpcError(-32602, 'Некоректна адреса');
        const a = getAddress(address);
        if (!acc.includes(a)) throw unauthorized('Рахунок не підключено до цього сайту');
        return a;
      }
      return acc[0];
    },

    signerFor(address) {
      const s = this.section();
      const i = s.addresses.indexOf(address);
      if (i < 0) {
        const hw = this.ledgerSigner(address); // рахунок Ledger: підпис на пристрої
        if (hw) return hw;
        const secret = this._importedSecret(address, 'evm'); // імпортований за приватним ключем
        if (!secret) throw unauthorized('Невідомий рахунок');
        if (this.signerEnabled()) return this.remoteEvmSigner({ address }, address);
        return new EthWallet(secret);
      }
      if (this.signerEnabled()) return this.remoteEvmSigner(i, address); // ключ виводить і підписує окремий процес
      return this._derive(s.mnemonic, i);
    },

    async personalSign(win, origin, params, sameTab) {
      let [msg, addr] = params;
      if (typeof msg === 'string' && isAddress(msg) && typeof addr === 'string' && !isAddress(addr)) [msg, addr] = [addr, msg];
      const a = this.requireConnected(origin, addr);
      if (typeof msg !== 'string') throw new RpcError(-32602, 'Некоректне повідомлення');
      let bytes;
      if (isHexString(msg)) bytes = getBytes(msg); else bytes = new TextEncoder().encode(msg);
      if (bytes.length > 10000) throw new RpcError(-32602, 'Повідомлення надто велике');
      let text = null;
      try { const t = toUtf8String(bytes); if (/^[\P{C}\n\r\t]*$/u.test(t)) text = t; } catch { /* не текст */ }
      const siwe = text !== null ? guard.checkSiwe(text, { origin, account: a, chainId: this.chainOf(origin) }) : null;
      const cutMsg = text !== null ? guard.truncationWarning(text.length, 1500) : guard.truncationWarning(bytes.length, 150, true);
      await this.approve(win, origin, sameTab, {
        kind: 'sign', title: siwe ? tr('Вхід через Ethereum (SIWE)') : tr('Підпис повідомлення'), danger: !!(siwe && siwe.danger) || !!cutMsg,
        lines: [['Рахунок', a], ...(siwe ? siwe.lines : []), ['Повідомлення', text !== null ? clip(text, 1500) : hexlify(bytes).slice(0, 300)]],
        warnings: [...(text === null ? ['Дані нечитабельні: підписуйте лише якщо повністю довіряєте сайту.'] : []), ...(cutMsg ? [cutMsg] : []), ...(siwe ? siwe.warnings : [])],
      });
      const sig = await this.signerFor(a).signMessage(bytes);
      this.log({ origin, action: 'Підпис повідомлення' });
      return sig;
    },

    async signTyped(win, origin, params, sameTab) {
      let [addr, data] = params;
      if (typeof addr !== 'string' || !isAddress(addr)) [addr, data] = [data, addr];
      const a = this.requireConnected(origin, addr);
      let td;
      try { td = typeof data === 'string' ? JSON.parse(data) : data; } catch { throw new RpcError(-32602, 'Некоректні типізовані дані'); }
      if (!td || typeof td !== 'object' || !td.types || !td.domain || !td.message || typeof td.primaryType !== 'string') throw new RpcError(-32602, 'Некоректні типізовані дані');
      const types = { ...td.types };
      delete types.EIP712Domain;
      const chain = this.chainOf(origin);
      if (td.domain.chainId !== undefined && Number(td.domain.chainId) !== chain) throw new RpcError(-32602, `chainId у даних (${td.domain.chainId}) не збігається з поточною мережею (${chain})`);
      try { TypedDataEncoder.hash(td.domain, types, td.message); } catch (e) { throw new RpcError(-32602, `Дані не відповідають типам: ${clip(e.message, 120)}`); }
      const warnings = [];
      if (/permit|order|seaport|delegat|approval|listing/i.test(td.primaryType + JSON.stringify(Object.keys(types)))) warnings.push('Цей підпис може дозволити витрату ваших токенів або продаж NFT БЕЗ окремої транзакції. Підписуйте лише на довірених сайтах.');
      // розшифровка дозволів: отримувач — контракт чи звичайний рахунок, токен і сума, термін, власник
      const isContract = new Map(), tokens = new Map();
      const quick = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
      try {
        const prov = this.provider(chain);
        await Promise.all([
          ...guard.permitSpenders(td).map(async (sp) => { try { const c = await quick(prov.getCode(sp), 5000); isContract.set(sp, !!c && c !== '0x'); } catch { /* невідомо */ } }),
          ...guard.permitTokens(td).map(async (t) => { try { const i = await quick(this.tokenInfo(chain, t), 5000); tokens.set(t, { symbol: i.symbol, decimals: i.decimals }); } catch { /* не ERC-20 */ } }),
        ]);
      } catch { /* RPC недоступний: розшифровка без перевірки отримувача */ }
      const g = guard.describeTyped({ ...td, types }, { account: a, isContract, tokens });
      if (g) warnings.push(...g.warnings);
      warnings.push(...guard.typedExtras(td, !!g));
      const dataText = JSON.stringify(td.message, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1);
      const cut = guard.truncationWarning(dataText.length, 2500);
      if (cut) warnings.push(cut);
      await this.approve(win, origin, sameTab, {
        kind: 'typed', title: tr('Підпис структурованих даних'), danger: warnings.length > 0 || !!(g && g.danger),
        lines: [['Рахунок', a], ...(g ? g.lines : []), ['Тип', clip(td.primaryType, 80)], ['Контракт (verifyingContract)', clip(td.domain.verifyingContract || '—', 60)], ['Мережа', String(chain)], ['Дані', clip(JSON.stringify(td.message, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1), 2500)]],
        warnings,
      });
      const sig = await this.signerFor(a).signTypedData(td.domain, types, td.message);
      this.log({ origin, action: `Підпис ${td.primaryType}` });
      return sig;
    },

    // opts.internal — переказ із самої сторінки гаманця (відправник — власний рахунок, а не підключений сайт);
    // opts.warnings/danger — додаткові попередження про отримувача
    async sendTransaction(win, origin, tx, sameTab, opts = {}) {
      if (!tx || typeof tx !== 'object') throw new RpcError(-32602, 'Некоректна транзакція');
      if (guard.hasDelegation(tx)) throw new RpcError(4200, 'Транзакції з делегуванням рахунку (EIP-7702) вимкнено: вони віддають контроль над рахунком коду контракту.');
      const from = opts.internal ? getAddress(tx.from) : this.requireConnected(origin, tx.from);
      if (opts.internal && !this.isOwnEvm(from)) throw unauthorized('Невідомий рахунок');
      const chain = opts.internal ? this.activeChain() : this.chainOf(origin);
      if (tx.chainId !== undefined && Number(tx.chainId) !== chain) throw new RpcError(-32602, 'chainId транзакції не збігається з поточною мережею');
      const net = this.network(chain);
      const num = (v, name) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && /^0x[0-9a-fA-F]*$/.test(v)) return BigInt(v === '0x' ? '0x0' : v);
        if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
        throw new RpcError(-32602, `Некоректне поле ${name}`);
      };
      const to = tx.to ? (isAddress(tx.to) ? getAddress(tx.to) : (() => { throw new RpcError(-32602, 'Некоректна адреса отримувача'); })()) : null;
      const data = tx.data || tx.input || '0x';
      if (typeof data !== 'string' || !isHexString(data) || data.length > 200000) throw new RpcError(-32602, 'Некоректні дані транзакції');
      const value = num(tx.value, 'value') || 0n;
      const req = { from, to, value, data, chainId: chain };
      const gas = num(tx.gas || tx.gasLimit, 'gas');
      if (gas) req.gasLimit = gas;
      for (const k of ['gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas']) { const v = num(tx[k], k); if (v !== undefined) req[k] = v; }
      const nonce = num(tx.nonce, 'nonce');
      if (nonce !== undefined) req.nonce = Number(nonce);

      // Усе, що потрібне для вікна підтвердження, виконується ПАРАЛЕЛЬНО (раніше по черзі: ≈9 раундів мережі до появи вікна):
      // делегування EIP-7702, nonce / газ / комісії, дані токена, симуляція й ціна нативної монети.
      const provider = this.provider(chain);
      const signer = this.signerFor(from).connect(provider);
      const hint = setTimeout(() => { try { win.toast(tr('Готуємо підтвердження…')); } catch { /* вікно закрито */ } }, 500);
      let desc = describeCall(data);
      let populated, delegate = null, ti = null, nativePrice = null;
      let simInfo = { lines: [], warnings: [], danger: false };
      try {
        const timed = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
        const [del, pop, tokenData, sim, price] = await Promise.all([
          timed(provider.getCode(from), 4000).then(c => guard.delegateOf(c), () => null), // RPC недоступний: перевірку пропущено
          this._prepareTx(provider, signer, req),
          desc.token && to && !opts.summary ? this.tokenInfo(chain, to).catch(() => null) : null, // не схоже на ERC-20 або RPC недоступний
          to && data !== '0x' ? this.simulateEvm(chain, { from, to, value, data }).then(r => this.describeSimulation(chain, r, { symbol: net.symbol })).catch(() => this.describeSimulation(chain, null, { symbol: net.symbol })) : null,
          timed(this.priceInfo({ chain: 'evm', chainId: chain, tokens: [] }), 1500).catch(() => null), // ціна лише для показу; повільний сервіс не затримує вікно
        ]);
        populated = pop; delegate = del; ti = tokenData; if (sim) simInfo = sim;
        nativePrice = price && price.enabled && price.native ? price.native : null;
      } finally { clearTimeout(hint); }
      if (delegate) opts = { ...opts, danger: true, warnings: [...(opts.warnings || []), `Ваш рахунок делеговано контракту ${delegate} (EIP-7702): цей контракт керує виконанням транзакцій рахунку. Якщо ви цього не робили — рахунок скомпрометовано, не підтверджуйте.`] };
      this.applySpeed(populated, opts.speed);
      const fee = (populated.maxFeePerGas || populated.gasPrice || 0n) * (populated.gasLimit || 0n);
      if (ti) desc = describeCall(data, ti);
      // Ліміти політики (сума, добовий ліміт, пауза) діють і на транзакції від сайтів, якщо вони передають кошти: нативну валюту чи токен
      let gate = { commit: () => {} };
      const own = (a) => !!a && a.toLowerCase() === from.toLowerCase();
      // Токени без відомих decimals (RPC не відповів або це NFT) теж проходять політику: вартість невідома, тож лишається попередження
      const tokenSpend = !opts.internal && value === 0n && desc.spend && (desc.spend.from === undefined || own(desc.spend.from)) ? desc.spend : null;
      const nftMove = !opts.internal && value === 0n && desc.nft && own(desc.nft.from) ? desc.nft : null;
      if (!opts.internal && (value > 0n || tokenSpend || nftMove)) {
        gate = await this.policyGate({ to: tokenSpend ? tokenSpend.to : nftMove ? nftMove.to : to, chain: 'evm', chainId: chain, token: tokenSpend ? to : undefined, amount: tokenSpend ? (ti ? formatUnits(tokenSpend.amount, ti.decimals) : undefined) : formatEther(value), nft: !!nftMove, contacts: !!(tokenSpend || nftMove) });
        opts = { ...opts, danger: opts.danger || gate.danger, warnings: [...(opts.warnings || []), ...gate.warnings], ...(gate.delay ? { delay: gate.delay } : {}) };
      }
      // Дозвіл витрачати токени понад ваш баланс (зокрема необмежений): пропонуємо обмежити його поточним балансом.
      // Нове значення рахує сам гаманець; вибір перевіряється серед запропонованих варіантів (див. decide)
      let allowChoice = null, allowCap = null;
      if (!opts.internal && value === 0n && desc.approve && ti && to) {
        const bal = await Promise.race([this.tokenBalance(chain, to, from), new Promise(r => setTimeout(() => r(null), 3000))]).catch(() => null);
        if (typeof bal === 'bigint' && bal > 0n && desc.approve.amount > bal) {
          allowCap = bal;
          allowChoice = { label: tr('Сума дозволу'), value: 'asked', options: [
            { value: 'asked', label: tr('Як просить сайт') },
            { value: 'balance', label: tr('Обмежити до вашого балансу ({0} {1})', formatUnits(bal, ti.decimals), clip(ti.symbol, 12)) },
          ] };
        }
      }
      const warnings = [...desc.warnings, ...(opts.warnings || [])];
      if (!to) warnings.push('Створення нового контракту.');
      if (fee > 10n ** 18n) warnings.push('Дуже висока комісія за газ.');
      warnings.push(...simInfo.warnings);
      const usd = (wei) => (nativePrice ? Number(formatEther(wei)) * nativePrice : null);
      const fmtUsd = (n) => (n === null ? null : n > 0 && n < 0.01 ? '< $0.01' : '≈ $' + n.toFixed(2));
      const lines = [
        ...(opts.summary || []),
        ['Мережа', `${net.name} (${chain})`], ['Від', from], ['Кому', to ? (guard.spenderLabel(to) ? `${guard.spenderLabel(to)} (${to})` : to) : 'новий контракт'],
        ...(to && data !== '0x' && this.isFirstInteraction && this.isFirstInteraction(to) ? [['Взаємодія', 'перша взаємодія з цією адресою']] : []),
        ...(ti ? [['Токен', `${ti.symbol}${ti.name ? ' — ' + ti.name : ''}`]] : []),
        ['Сума', `${formatEther(value)} ${net.symbol}`], ...(opts.summary ? [] : desc.lines),
        ...(opts.speed && opts.speed !== 'standard' ? [['Швидкість комісії', opts.speed === 'fast' ? 'швидко (комісія вища)' : 'повільно (комісія нижча, підтвердження може затягнутись)']] : []),
        ...simInfo.lines,
        ['Ліміт газу', String(populated.gasLimit)], ['Макс. комісія', `${formatEther(fee)} ${net.symbol}`], ['Макс. разом', `${formatEther(fee + value)} ${net.symbol}`],
        ...(nativePrice ? [...(value > 0n ? [['Сума, USD', fmtUsd(usd(value))]] : []), ['Комісія, USD', fmtUsd(usd(fee))], ['Разом, USD', fmtUsd(usd(fee + value))]] : []),
      ];
      const answer = await this.approve(win, origin, sameTab, { kind: 'tx', title: tr('Підтвердження транзакції'), danger: !!opts.danger || simInfo.danger || warnings.some(w => /Необмежений|ВСІ/.test(w)), lines, warnings, ...(allowChoice ? { choice: allowChoice } : {}), ...(opts.delay ? { delay: opts.delay } : {}) });
      if (allowChoice && answer && answer.choice === 'balance') {
        populated.data = IFACE.encodeFunctionData(desc.approve.name, [desc.approve.spender, allowCap]);
        this.log({ origin, action: `Дозвіл обмежено до балансу (${formatUnits(allowCap, ti.decimals)} ${clip(ti.symbol, 12)})`, chainId: chain });
      }
      let hash;
      try {
        const signed = await signer.signTransaction(populated);
        hash = (await signer.provider.broadcastTransaction(signed)).hash;
      } catch (e) { throw new RpcError(-32000, `Не вдалося надіслати транзакцію: ${clip(e.shortMessage || e.message, 200)}`); }
      gate.commit();
      this.trackPending(hash, chain, populated);
      if (to && this.rememberRecipient) this.rememberRecipient(to);
      this.log({ origin, action: opts.action || `Транзакція ${formatEther(value)} ${net.symbol}`, hash, chainId: chain });
      return hash;
    },

    // Підготовка транзакції: nonce, оцінка газу й комісії запитуються одночасно (ethers робить це послідовно). Оцінка газу отримує запас 20 %
    // для викликів, складніших за простий переказ: стан між оцінкою й включенням змінюється, а нестача газу коштує комісії. Значення, задані сайтом, не чіпаємо.
    async _prepareTx(provider, signer, req) {
      const needFee = req.maxFeePerGas === undefined && req.gasPrice === undefined && req.maxPriorityFeePerGas === undefined;
      try {
        const [nonce, est, feeData] = await Promise.all([
          req.nonce === undefined ? signer.getNonce('pending') : req.nonce,
          req.gasLimit === undefined ? provider.estimateGas({ from: req.from, to: req.to, value: req.value, data: req.data }) : req.gasLimit,
          needFee ? provider.getFeeData() : null,
        ]);
        const full = { ...req, nonce: Number(nonce), gasLimit: est };
        if (req.gasLimit === undefined && est > 21000n) full.gasLimit = est + est / 5n;
        if (feeData) {
          if (feeData.maxFeePerGas != null && feeData.maxPriorityFeePerGas != null) { full.maxFeePerGas = feeData.maxFeePerGas; full.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas; }
          else if (feeData.gasPrice != null) full.gasPrice = feeData.gasPrice;
        }
        return await signer.populateTransaction(full);
      } catch (e) { throw new RpcError(-32000, `Не вдалося підготувати транзакцію (можливо, вона завершиться помилкою): ${clip(e.shortMessage || e.message, 200)}`); }
    },
  });
}

module.exports = { install };
