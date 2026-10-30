'use strict';
// Preload для вкладок (виконується в ізольованому світі, сторінка не бачить цього коду).
// Архітектура модулів із суворими ізольованими межами помилок (Error Boundaries):
//  1. Внутрішній протокол w3ir:// — доступ до безпечного IPC API браузера.
//  2. WebAuthn Fallback — миттєве NotAllowedError замість хвилинного таймауту на passkey-запитах.
//  3. Менеджер паролів — автозаповнення за командою сховища та перехоплення облікових даних.
//  4. Ін'єкції в основний світ (Main World):
//     - Anti-fingerprint захист (шум canvas, нормалізація параметрів екрану й процесора).
//     - EVM-провайдер (window.ethereum, EIP-1193, EIP-6963).
//     - Solana-провайдер (window.solana, phantom, wallet-standard).
//  5. Безпечний запуск підсистем: збій в одному модулі ніколи не блокує інші та не ламає сторінку.

const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Безпечний виклик підсистеми з ізоляцією винятків
function safeRun(name, fn) {
  try {
    fn();
  } catch (err) {
    try { console.warn('[W3IR Preload]', name, err); } catch { /* ignore */ }
  }
}

function isTopFrame() {
  try {
    return window === window.top;
  } catch {
    return false;
  }
}

function isSecureContext() {
  const p = location.protocol;
  const h = location.hostname;
  return p === 'https:' || (p === 'http:' && (h === 'localhost' || h === '127.0.0.1'));
}

// ============================================================================
// 1. ВНУТРІШНІЙ ПРОТОКОЛ W3IR://
// ============================================================================
function setupInternalApi() {
  if (location.protocol === 'w3ir:') {
    contextBridge.exposeInMainWorld('w3ir', {
      invoke: (name, arg) => ipcRenderer.invoke('internal', name, arg),
    });
  }
}

// ============================================================================
// 2. WEBAUTHN FAST-FAIL (PASSKEYS & SECURITY KEYS)
// ============================================================================
// WebAuthn у цій збірці Electron недоступний: запит без відповіді висів би до таймауту
// сайту (часто хвилину), а потім завершувався NotAllowedError. Тому відхиляємо одразу
// (сайт миттєво запропонує пароль) і показуємо підказку. Фонові запити
// passkey-автозаповнення (mediation: 'conditional') не чіпаємо.
function setupWebAuthnShim() {
  if (!isSecureContext() || !isTopFrame()) return;
  try {
    webFrame.executeJavaScript(`(() => { const c = navigator.credentials; if (!c) return;
      for (const m of ['create', 'get']) { const orig = c[m].bind(c);
        c[m] = function (opts) {
          if (opts && opts.publicKey && opts.mediation !== 'conditional') {
            window.dispatchEvent(new CustomEvent('__w3ir_wa_unsupported'));
            return Promise.reject(new DOMException('Passkeys і ключі безпеки не підтримуються в цьому браузері.', 'NotAllowedError'));
          }
          return orig(opts);
        }; } })()`).catch(() => {});
    window.addEventListener('__w3ir_wa_unsupported', () => ipcRenderer.send('webauthn:unsupported'));
  } catch { /* не критично */ }
}

// ============================================================================
// 3. МЕНЕДЖЕР ПАРОЛІВ (АВТОЗАПОВНЕННЯ ТА ПЕРЕХОПЛЕННЯ)
// ============================================================================
function setupPasswordManager() {
  if (!isSecureContext() || !isTopFrame()) return;

  const isVisible = (el) => {
    if (!el || !el.isConnected || el.disabled || el.type === 'hidden') return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility !== 'visible' || cs.display === 'none' || Number(cs.opacity) < 0.1) return false;
    if (r.right < 0 || r.bottom < 0 || r.left > innerWidth + 50 || r.top > document.documentElement.scrollHeight) return false;
    return true;
  };

  const setValue = (el, value) => {
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (!desc || !desc.set) return;
    el.focus();
    desc.set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const textInputs = (root) => {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    return [...root.querySelectorAll('input')].filter(i =>
      ['text', 'email', 'tel', ''].includes((i.getAttribute('type') || '').toLowerCase()) && isVisible(i));
  };

  // Автозаповнення: лише за командою браузера, лише для точного збігу origin
  ipcRenderer.on('vault:fill', (_e, msg) => {
    if (!msg || msg.origin !== location.origin) return;
    const pw = [...document.querySelectorAll('input[type=password]')].find(isVisible);
    let user = null;
    if (pw) {
      const scope = pw.form || document;
      const all = textInputs(scope);
      user = all.filter(i => pw.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_PRECEDING).pop() || all[0] || null;
    } else {
      // Двокрокова форма: спочатку лише логін
      user = textInputs(document).find(i => /user|login|email|name/i.test(i.name + i.id + i.autocomplete)) || textInputs(document)[0] || null;
    }
    if (user && msg.username) setValue(user, String(msg.username));
    if (pw && msg.password) setValue(pw, String(msg.password));
  });

  // Перехоплення входу (лише справжні дії користувача)
  let last = '';
  let lastAt = 0;

  const collect = (root) => {
    if (!root || typeof root.querySelectorAll !== 'function') return null;
    const pws = [...root.querySelectorAll('input[type=password]')].filter(i => isVisible(i) && i.value);
    if (!pws.length || pws.length > 3) return null;
    let password;
    if (pws.length === 1) password = pws[0].value;
    else if (pws.length === 2) { if (pws[0].value !== pws[1].value) return null; password = pws[0].value; }
    else { if (pws[1].value !== pws[2].value) return null; password = pws[1].value; }
    const users = textInputs(root).filter(i => i.value && (pws[0].compareDocumentPosition(i) & Node.DOCUMENT_POSITION_PRECEDING));
    const username = users.length ? users[users.length - 1].value : '';
    return { username: username.slice(0, 512), password: password.slice(0, 1024) };
  };

  const report = (root) => {
    const c = collect(root);
    if (!c) return;
    const sig = c.username + '\u0000' + c.password;
    if (sig === last && Date.now() - lastAt < 3000) return;
    last = sig; lastAt = Date.now();
    ipcRenderer.send('vault:captured', c);
  };

  document.addEventListener('submit', (e) => {
    if (e.isTrusted && e.target instanceof HTMLFormElement) report(e.target);
  }, true);

  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted || e.key !== 'Enter') return;
    const t = e.target;
    if (t instanceof HTMLInputElement && t.type === 'password') report(t.form || document);
  }, true);

  document.addEventListener('click', (e) => {
    if (!e.isTrusted || !(e.target instanceof Element)) return;
    const b = e.target.closest('button:not([type]), button[type=submit], input[type=submit]');
    if (b) report(b.form || document);
  }, true);

  // Glance / Peek preview за Alt+Клік по посиланню
  document.addEventListener('click', (e) => {
    if (!e.isTrusted || !e.altKey || !(e.target instanceof Element)) return;
    const a = e.target.closest('a[href]');
    if (!a || !a.href) return;
    if (/^(https?:|ar:\/\/|ipfs:\/\/|ipns:\/\/)/i.test(a.href)) {
      e.preventDefault();
      e.stopPropagation();
      ipcRenderer.send('browser:glance', { url: a.href });
    }
  }, true);
}

// ============================================================================
// 4. ІН'ЄКЦІЇ В ОСНОВНИЙ СВІТ (MAIN WORLD)
// ============================================================================
// Функції нижче серіалізуються через contextBridge.executeInMainWorld і виконуються
// в контексті веб-сторінки. Вони НЕ мають доступу до замикань цього файлу.

// --- 4.1. EVM-провайдер (EIP-1193 + EIP-6963) ---
function installProvider(b) {
  if (!b || window.ethereum) return;
  const listeners = {};
  let chainId = b.chainId;
  const emit = (ev, data) => (listeners[ev] || []).slice().forEach(fn => { try { fn(data); } catch (e) { console.error(e); } });
  const call = async (method, params) => {
    const r = await b.request({ method, params });
    if (r && r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r ? r.result : null;
  };
  const provider = {
    isW3IR: true,
    request: (args) => {
      if (!args || typeof args !== 'object' || typeof args.method !== 'string') return Promise.reject(Object.assign(new Error('Invalid request'), { code: -32600 }));
      return call(args.method, args.params);
    },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return provider; },
    removeListener(ev, fn) { listeners[ev] = (listeners[ev] || []).filter(f => f !== fn); return provider; },
    once(ev, fn) { const w = (d) => { provider.removeListener(ev, w); fn(d); }; return provider.on(ev, w); },
    isConnected: () => true,
    enable: () => call('eth_requestAccounts'),
    sendAsync(payload, cb) { call(payload.method, payload.params).then(result => cb(null, { id: payload.id, jsonrpc: '2.0', result }), err => cb(err)); },
    send(a, p) { return typeof a === 'string' ? call(a, p) : provider.sendAsync(a, p); },
    get chainId() { return chainId; },
    get networkVersion() { return String(parseInt(chainId, 16)); },
  };
  provider.addListener = provider.on;
  provider.off = provider.removeListener;
  b.onEvent((ev, data) => { if (ev === 'chainChanged') chainId = data; emit(ev, data); });
  Object.defineProperty(window, 'ethereum', { value: provider, writable: false, configurable: false });
  const icon = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="14" fill="#5a8dee"/><path d="M14 22h36v24H14z" fill="#fff"/><circle cx="42" cy="34" r="4" fill="#5a8dee"/></svg>');
  const info = Object.freeze({ uuid: crypto.randomUUID ? crypto.randomUUID() : String(Math.random()), name: 'W3IR Wallet', icon, rdns: 'app.w3ir.wallet' });
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
  window.dispatchEvent(new Event('ethereum#initialized'));
}

// --- 4.2. Solana-провайдер (Phantom compat + Wallet Standard) ---
function installSolana(b) {
  if (!b) return;
  const listeners = {};
  const emit = (ev, ...a) => (listeners[ev] || []).slice().forEach(fn => { try { fn(...a); } catch (e) { console.error(e); } });
  const toB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const fromB64 = (s) => { const bin = atob(s); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; };
  const call = async (method, params) => {
    const r = await b.request({ method, params });
    if (r && r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r ? r.result : null;
  };
  let account = null;
  const stdListeners = [];
  const chains = ['solana:mainnet', 'solana:devnet', 'solana:testnet'];
  const accFeatures = ['solana:signAndSendTransaction', 'solana:signTransaction', 'solana:signMessage'];

  class PublicKey {
    constructor(address, bytes) { this._a = address; this._b = Uint8Array.from(bytes); }
    toBytes() { return Uint8Array.from(this._b); }
    toBuffer() { return window.Buffer ? window.Buffer.from(this._b) : this.toBytes(); }
    toBase58() { return this._a; }
    toString() { return this._a; }
    toJSON() { return this._a; }
    equals(o) { return !!o && typeof o.toBase58 === 'function' && o.toBase58() === this._a; }
  }
  let pk = null;
  const stdAccounts = () => (account ? [Object.freeze({ address: account.address, publicKey: Uint8Array.from(account.bytes), chains, features: accFeatures.slice() })] : []);
  const stdEmit = () => { const props = { accounts: stdAccounts() }; stdListeners.slice().forEach(fn => { try { fn(props); } catch (e) { console.error(e); } }); };
  const setAccount = (r) => {
    if (!r || !r.address) return;
    if (account && account.address === r.address) return;
    account = { address: r.address, bytes: fromB64(r.publicKey) };
    pk = new PublicKey(account.address, account.bytes);
    emit('connect', pk);
    stdEmit();
  };
  const clearAccount = () => {
    if (!account) return;
    account = null; pk = null;
    emit('disconnect');
    stdEmit();
  };
  const connect = async (opts) => {
    const r = await call('solana_connect', { onlyIfTrusted: !!(opts && opts.onlyIfTrusted) });
    setAccount(r);
    return { publicKey: pk };
  };
  const disconnect = async () => { try { await call('solana_disconnect'); } finally { clearAccount(); } };

  const kindOf = (tx) => (tx instanceof Uint8Array ? 'raw' : tx && tx.message && typeof tx.serialize === 'function' ? 'versioned' : tx && typeof tx.serialize === 'function' ? 'legacy' : null);
  const toWire = (tx) => {
    const k = kindOf(tx);
    if (!k) throw Object.assign(new TypeError('Unsupported transaction'), { code: -32602 });
    return Uint8Array.from(k === 'legacy' ? tx.serialize({ requireAllSignatures: false, verifySignatures: false }) : k === 'versioned' ? tx.serialize() : tx);
  };
  const sigsOf = (wire) => {
    let n = wire[0], off = 1;
    if (n & 0x80) { n = (n & 0x7f) | (wire[1] << 7); off = 2; }
    const out = [];
    for (let i = 0; i < n; i++) out.push(wire.slice(off + i * 64, off + (i + 1) * 64));
    return out;
  };
  const applySigned = (tx, signedB64) => {
    const wire = fromB64(signedB64);
    const k = kindOf(tx);
    if (k === 'raw') return wire;
    const sigs = sigsOf(wire);
    if (k === 'versioned') tx.signatures = sigs;
    else tx.signatures.forEach((s, i) => { if (sigs[i] && sigs[i].some(x => x)) s.signature = window.Buffer ? window.Buffer.from(sigs[i]) : sigs[i]; });
    return tx;
  };
  const needMsg = (m) => { if (!(m instanceof Uint8Array)) throw Object.assign(new TypeError('message must be a Uint8Array'), { code: -32602 }); return m; };

  const signTransaction = async (tx, chain) => applySigned(tx, (await call('solana_signTransaction', { transactions: [toB64(toWire(tx))], chain })).signedTransactions[0]);
  const signAllTransactions = async (txs) => {
    if (!Array.isArray(txs)) throw Object.assign(new TypeError('transactions must be an array'), { code: -32602 });
    const r = await call('solana_signTransaction', { transactions: txs.map(t => toB64(toWire(t))) });
    return txs.map((t, i) => applySigned(t, r.signedTransactions[i]));
  };
  const signAndSendTransaction = async (tx, _opts, chain) => {
    const r = await call('solana_signAndSendTransaction', { transactions: [toB64(toWire(tx))], chain });
    return { signature: r.signature, publicKey: account ? account.address : '', signedTransaction: r.signedTransaction };
  };
  const signMessage = async (msg) => {
    const r = await call('solana_signMessage', { message: toB64(needMsg(msg)) });
    return { signature: fromB64(r.signature), publicKey: pk };
  };

  const provider = {
    isW3IR: true,
    isPhantom: true, // лише сумісність: багато dApps шукають Solana-гаманець за window.solana.isPhantom або window.phantom.solana; це не заява про афіліацію (див. THIRD-PARTY-NOTICES.md)
    get publicKey() { return pk; },
    get isConnected() { return !!account; },
    connect, disconnect, signTransaction: (tx) => signTransaction(tx), signAllTransactions, signAndSendTransaction: (tx, o) => signAndSendTransaction(tx, o), signMessage,
    request: (args) => {
      const m = args && args.method, p = (args && args.params) || {};
      if (m === 'connect') return connect(p);
      if (m === 'disconnect') return disconnect();
      if (m === 'signMessage') return signMessage(p.message);
      return Promise.reject(Object.assign(new Error('Method not supported'), { code: 4200 }));
    },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return provider; },
    removeListener(ev, fn) { listeners[ev] = (listeners[ev] || []).filter(f => f !== fn); return provider; },
    once(ev, fn) { const w = (...a) => { provider.removeListener(ev, w); fn(...a); }; return provider.on(ev, w); },
  };
  provider.off = provider.removeListener;
  provider.addListener = provider.on;
  b.onEvent((ev, data) => {
    if (ev === 'sol:connect') setAccount(data);
    else if (ev === 'sol:disconnect') clearAccount();
  });
  if (!window.solana) Object.defineProperty(window, 'solana', { value: provider, writable: false, configurable: false });
  if (!window.phantom) Object.defineProperty(window, 'phantom', { value: Object.freeze({ solana: provider }), writable: false, configurable: false });

  // wallet-standard інтеграція
  const sameAccount = (a) => { if (!account || !a || a.address !== account.address) throw Object.assign(new Error('Account is not connected'), { code: 4100 }); };
  const firstSig = (wireB64) => sigsOf(fromB64(wireB64))[0];
  const icon = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="14" fill="#5a8dee"/><path d="M14 22h36v24H14z" fill="#fff"/><circle cx="42" cy="34" r="4" fill="#5a8dee"/></svg>');
  const wallet = {
    version: '1.0.0', name: 'W3IR Wallet', icon, chains,
    get accounts() { return stdAccounts(); },
    features: {
      'standard:connect': { version: '1.0.0', connect: async (o) => { await connect({ onlyIfTrusted: !!(o && o.silent) }); return { accounts: stdAccounts() }; } },
      'standard:disconnect': { version: '1.0.0', disconnect },
      'standard:events': { version: '1.0.0', on: (ev, fn) => { if (ev !== 'change') return () => {}; stdListeners.push(fn); return () => { const i = stdListeners.indexOf(fn); if (i >= 0) stdListeners.splice(i, 1); }; } },
      'solana:signMessage': { version: '1.0.0', signMessage: async (...inputs) => { const out = []; for (const i of inputs) { sameAccount(i.account); const r = await signMessage(i.message); out.push({ signedMessage: i.message, signature: r.signature }); } return out; } },
      'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signTransaction: async (...inputs) => { const out = []; for (const i of inputs) { sameAccount(i.account); const r = await call('solana_signTransaction', { transactions: [toB64(i.transaction)], chain: i.chain }); out.push({ signedTransaction: fromB64(r.signedTransactions[0]) }); } return out; } },
      'solana:signAndSendTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signAndSendTransaction: async (...inputs) => { const out = []; for (const i of inputs) { sameAccount(i.account); const r = await call('solana_signAndSendTransaction', { transactions: [toB64(i.transaction)], chain: i.chain }); out.push({ signature: firstSig(r.signedTransaction) }); } return out; } },
    },
  };
  try { window.addEventListener('wallet-standard:app-ready', (e) => { try { e.detail.register(wallet); } catch (err) { console.error(err); } }); } catch { /* ignore */ }
  try { window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: (api) => { try { api.register(wallet); } catch (err) { console.error(err); } } })); } catch { /* ignore */ }
}

// --- 4.3. Arweave-провайдер (ArConnect / Wander API стандарт) ---
function installArweave(b) {
  if (!b || window.arweaveWallet) return;
  const listeners = {};
  const emit = (ev, ...a) => (listeners[ev] || []).slice().forEach(fn => { try { fn(...a); } catch (e) { console.error(e); } });
  const call = async (method, params) => {
    const r = await b.request({ method, params });
    if (r && r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r ? r.result : null;
  };

  const wallet = {
    walletName: 'W3IR Arweave Wallet',
    connect: async (permissions, appInfo, gateway) => call('arweave_connect', { permissions, appInfo, gateway }),
    disconnect: async () => call('arweave_disconnect'),
    getActiveAddress: async () => call('arweave_getActiveAddress'),
    getAllAddresses: async () => call('arweave_getAllAddresses'),
    getWalletNames: async () => call('arweave_getWalletNames'),
    getPermissions: async () => call('arweave_getPermissions'),
    getActivePublicKey: async () => call('arweave_getActivePublicKey'),
    sign: async (tx, options) => call('arweave_sign', { transaction: tx, options }),
    signature: async (data, algorithm) => call('arweave_signature', { data, algorithm }),
    dispatch: async (tx) => call('arweave_dispatch', { transaction: tx }),
    on: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); return wallet; },
    removeListener: (ev, fn) => { listeners[ev] = (listeners[ev] || []).filter(f => f !== fn); return wallet; },
  };

  b.onEvent((ev, data) => {
    if (ev === 'ar:disconnect') emit('disconnect');
    else if (ev === 'ar:connect') emit('connect', data);
  });

  Object.defineProperty(window, 'arweaveWallet', { value: wallet, writable: false, configurable: false });
  try {
    window.dispatchEvent(new CustomEvent('arweaveWalletLoaded', { detail: { wallet } }));
  } catch { /* ignore */ }
}

// --- 4.4. Anti-Fingerprinting (Canvas noise + Screen/Navigator rounding) ---
function installFingerprintProtection() {
  try {
    const r100 = (n) => Math.max(100, Math.round(Number(n || 0) / 100) * 100);
    const sp = Screen.prototype;
    const ow = Object.getOwnPropertyDescriptor(sp, 'width');
    const oh = Object.getOwnPropertyDescriptor(sp, 'height');
    if (ow && ow.get) Object.defineProperty(sp, 'width', { get() { return r100(ow.get.call(this)); } });
    if (oh && oh.get) Object.defineProperty(sp, 'height', { get() { return r100(oh.get.call(this)); } });
    Object.defineProperty(sp, 'availWidth', { get() { return this.width; } });
    Object.defineProperty(sp, 'availHeight', { get() { return this.height; } });
    Object.defineProperty(sp, 'colorDepth', { value: 24, configurable: false });
    Object.defineProperty(sp, 'pixelDepth', { value: 24, configurable: false });
    const ww = Object.getOwnPropertyDescriptor(window, 'outerWidth');
    const wh = Object.getOwnPropertyDescriptor(window, 'outerHeight');
    if (ww && ww.get) Object.defineProperty(window, 'outerWidth', { get() { return r100(ww.get.call(this)); } });
    if (wh && wh.get) Object.defineProperty(window, 'outerHeight', { get() { return r100(wh.get.call(this)); } });
    if ('hardwareConcurrency' in navigator) Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { value: 4, configurable: false });
    if ('deviceMemory' in navigator) Object.defineProperty(Navigator.prototype, 'deviceMemory', { value: 8, configurable: false });
  } catch { /* ignore */ }
  try {
    const noise = (d) => {
      if (d && d.length >= 16) {
        const step = Math.max(4, Math.floor(d.length / 32));
        for (let i = 0; i < d.length; i += step) d[i] = d[i] ^ 1;
      }
    };
    const origGet = CanvasRenderingContext2D.prototype.getImageData;
    const origPut = CanvasRenderingContext2D.prototype.putImageData;
    const origGetCtx = HTMLCanvasElement.prototype.getContext;
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    const origToBlob = HTMLCanvasElement.prototype.toBlob;
    CanvasRenderingContext2D.prototype.getImageData = function (sx, sy, sw, sh, ...rest) {
      const img = origGet.call(this, sx, sy, sw, sh, ...rest);
      noise(img.data);
      return img;
    };
    const cloneNoisy = (src) => {
      if (!src || !(src.width > 0 && src.height > 0 && src.width <= 4096 && src.height <= 4096)) return src;
      try {
        const tmp = document.createElement('canvas');
        tmp.width = src.width;
        tmp.height = src.height;
        const tctx = origGetCtx.call(tmp, '2d');
        if (!tctx) return src;
        tctx.drawImage(src, 0, 0);
        const img = origGet.call(tctx, 0, 0, tmp.width, tmp.height);
        noise(img.data);
        origPut.call(tctx, img, 0, 0);
        return tmp;
      } catch {
        return src;
      }
    };
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      return origToDataURL.apply(cloneNoisy(this), args);
    };
    if (origToBlob) {
      HTMLCanvasElement.prototype.toBlob = function (...args) {
        return origToBlob.apply(cloneNoisy(this), args);
      };
    }
  } catch { /* ignore */ }

  // WebGL Unmasked Vendor / Renderer Spoofing
  try {
    const spoofExt = (proto) => {
      if (!proto || !proto.getParameter) return;
      const origGetParam = proto.getParameter;
      proto.getParameter = function (p) {
        if (p === 0x9245) return 'Google Inc. (Intel)';
        if (p === 0x9246) return 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0)';
        return origGetParam.call(this, p);
      };
    };
    if (typeof WebGLRenderingContext !== 'undefined') spoofExt(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== 'undefined') spoofExt(WebGL2RenderingContext.prototype);
  } catch { /* ignore */ }

  // AudioContext Acoustic Hash Protection (micro-noise)
  try {
    if (typeof AudioBuffer !== 'undefined' && AudioBuffer.prototype && AudioBuffer.prototype.getChannelData) {
      const origGetChannel = AudioBuffer.prototype.getChannelData;
      const noised = new WeakSet();
      AudioBuffer.prototype.getChannelData = function (channel) {
        const data = origGetChannel.call(this, channel);
        if (data && data.length > 0 && !noised.has(data)) {
          noised.add(data);
          const step = Math.max(16, Math.floor(data.length / 64));
          for (let i = 0; i < data.length; i += step) {
            data[i] = data[i] + ((i % 2 === 0) ? 0.0000001 : -0.0000001);
          }
        }
        return data;
      };
    }
    if (typeof AnalyserNode !== 'undefined' && AnalyserNode.prototype && AnalyserNode.prototype.getFloatFrequencyData) {
      const origGetFloatFreq = AnalyserNode.prototype.getFloatFrequencyData;
      AnalyserNode.prototype.getFloatFrequencyData = function (array) {
        origGetFloatFreq.call(this, array);
        if (array && array.length > 0) {
          const step = Math.max(8, Math.floor(array.length / 32));
          for (let i = 0; i < array.length; i += step) {
            array[i] = array[i] + ((i % 2 === 0) ? 0.00001 : -0.00001);
          }
        }
      };
    }
  } catch { /* ignore */ }
}

// ============================================================================
// 5. BOOTSTRAP: ІНІЦІАЛІЗАЦІЯ ШИЛДІВ ТА WEB3
// ============================================================================
function setupWeb3AndProtection() {
  if (!isSecureContext() || !isTopFrame()) return;

  let init = null;
  try {
    // Синхронно навмисно: відповідь має бути до першого скрипта сторінки.
    // Асинхронний invoke приходить уже після inline-скриптів, тож dApp не побачить
    // window.ethereum, а вікно без гаманця не встигне лишити його відсутнім.
    init = ipcRenderer.sendSync('wallet:init');
  } catch {
    return;
  }
  if (!init) return;

  if (init.fingerprint) {
    try {
      contextBridge.executeInMainWorld({ func: installFingerprintProtection, args: [] });
    } catch { /* ignore */ }
  }

  if (init.enabled) {
    const bridge = {
      request: async (args) => {
        if (!args || typeof args.method !== 'string') return { error: { code: -32600, message: 'Invalid request' } };
        return ipcRenderer.invoke('wallet:request', { method: args.method, params: args.params });
      },
      onEvent: (cb) => {
        ipcRenderer.on('wallet:event', (_e, ev, data) => {
          try { cb(ev, data); } catch { /* ignore */ }
        });
      },
    };
    try {
      contextBridge.executeInMainWorld({ func: installProvider, args: [{ chainId: init.chainId, ...bridge }] });
    } catch { /* ignore */ }
    try {
      contextBridge.executeInMainWorld({ func: installSolana, args: [bridge] });
    } catch { /* ignore */ }
    if (init.arweave) {
      try {
        contextBridge.executeInMainWorld({ func: installArweave, args: [bridge] });
      } catch { /* ignore */ }
    }
  }
}

// ============================================================================
// ЗАПУСК УСІХ ПІДСИСТЕМ З ІЗОЛЯЦІЄЮ ПОМИЛОК
// ============================================================================
safeRun('w3ir-internal', setupInternalApi);
safeRun('webauthn-shim', setupWebAuthnShim);
safeRun('password-vault', setupPasswordManager);
safeRun('web3-and-shield', setupWeb3AndProtection);
