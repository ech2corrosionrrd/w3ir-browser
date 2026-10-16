'use strict';
// Preload для вкладок (виконується в ізольованому світі, сторінка не бачить цього коду).
//  * на внутрішніх сторінках w3ir:// — доступ до API браузера;
//  * на https-сторінках — безпечне автозаповнення та перехоплення форм входу для менеджера паролів.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'w3ir:') {
  contextBridge.exposeInMainWorld('w3ir', {
    invoke: (name, arg) => ipcRenderer.invoke('internal', name, arg),
  });
}

const secureContext = location.protocol === 'https:' || (location.protocol === 'http:' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1'));

if (secureContext && window === window.top) {
  const isVisible = (el) => {
    if (!el.isConnected || el.disabled || el.type === 'hidden') return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility !== 'visible' || cs.display === 'none' || Number(cs.opacity) < 0.1) return false;
    if (r.right < 0 || r.bottom < 0 || r.left > innerWidth + 50 || r.top > document.documentElement.scrollHeight) return false;
    return true;
  };
  const setValue = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const textInputs = (root) => [...root.querySelectorAll('input')].filter(i =>
    ['text', 'email', 'tel', ''].includes((i.getAttribute('type') || '').toLowerCase()) && isVisible(i));

  // ---------- автозаповнення: лише за командою браузера, лише для точного збігу origin ----------
  ipcRenderer.on('vault:fill', (_e, msg) => {
    if (!msg || msg.origin !== location.origin) return;
    const pw = [...document.querySelectorAll('input[type=password]')].find(isVisible);
    let user = null;
    if (pw) {
      const scope = pw.form || document;
      const all = textInputs(scope);
      user = all.filter(i => pw.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_PRECEDING).pop() || all[0] || null;
    } else {
      // двокрокова форма: спочатку лише логін
      user = textInputs(document).find(i => /user|login|email|name/i.test(i.name + i.id + i.autocomplete)) || textInputs(document)[0] || null;
    }
    if (user && msg.username) setValue(user, String(msg.username));
    if (pw && msg.password) setValue(pw, String(msg.password));
  });

  // ---------- перехоплення входу (лише справжні дії користувача) ----------
  let last = '';
  let lastAt = 0;
  const collect = (root) => {
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
  document.addEventListener('submit', (e) => { if (e.isTrusted && e.target instanceof HTMLFormElement) report(e.target); }, true);
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
}

// ---------- провайдер гаманця (EIP-1193 + EIP-6963) ----------
// Код провайдера виконується в основному світі сторінки через contextBridge.executeInMainWorld: міст передається
// аргументом і ніде не лишається в глобальному об'єкті, тому сторінка бачить лише window.ethereum.
// Функція нижче серіалізується й не може посилатися на змінні зовнішньої області видимості.
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

if (secureContext && window === window.top) {
  const init = ipcRenderer.sendSync('wallet:init');
  if (init && init.enabled) {
    contextBridge.executeInMainWorld({
      func: installProvider,
      args: [{
        chainId: init.chainId,
        request: async (args) => {
          if (!args || typeof args.method !== 'string') return { error: { code: -32600, message: 'Invalid request' } };
          return ipcRenderer.invoke('wallet:request', { method: args.method, params: args.params });
        },
        onEvent: (cb) => { ipcRenderer.on('wallet:event', (_e, ev, data) => { try { cb(ev, data); } catch { /* ignore */ } }); },
      }],
    });
  }
}
