'use strict';
// Аудит вихідних запитів — лише для розробки й тестів (main.js вмикає його тільки в неупакованій збірці зі змінною W3IR_NET_AUDIT=<файл>).
// Нічого не блокує й не змінює: дописує по рядку JSON на кожен зовнішній запит. Два джерела:
//   chromium — усі сесії (вкладки, net.fetch, службові розділи) через webRequest.onCompleted/onErrorOccurred (їх застосунок не використовує);
//   node     — з'єднання головного процесу (fetch, https): вони обходять мережу Chromium і не потрапляють у webRequest і net-log.
const fs = require('fs');

const LOCAL = /^(localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0)$/i;

function install(app, file) {
  const write = (rec) => { try { fs.appendFileSync(file, JSON.stringify({ t: Date.now(), ...rec }) + '\n'); } catch { /* журнал не повинен ламати застосунок */ } };

  // Node: усі сокети (undici/fetch, https, tls) створюються через net.Socket.connect
  const net = require('net');
  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    try {
      const a = Array.isArray(args[0]) ? args[0][0] : args[0];
      const o = a && typeof a === 'object' ? a : { port: a, host: typeof args[1] === 'string' ? args[1] : undefined };
      const host = String(o.servername || o.host || '');
      if (host && !o.path && !LOCAL.test(host)) write({ kind: 'node', host, port: Number(o.port) || 0 });
    } catch { /* ignore */ }
    return origConnect.apply(this, args);
  };

  // Chromium: кожна нова сесія (профілі, інкогніто, розділи)
  const hook = (ses, name) => {
    const rec = (d, err) => {
      let u;
      try { u = new URL(d.url); } catch { return; }
      if (!/^(https?|wss?|ftp):$/.test(u.protocol) || LOCAL.test(u.hostname)) return;
      write({ kind: 'chromium', session: name, host: u.hostname, url: u.origin + u.pathname, type: d.resourceType, cache: !!d.fromCache, err: err || undefined });
    };
    ses.webRequest.onCompleted((d) => rec(d));
    ses.webRequest.onErrorOccurred((d) => rec(d, d.error));
  };
  app.on('session-created', (ses) => hook(ses, ses.storagePath ? String(ses.storagePath).split(/[\\/]/).pop() : 'memory'));
}

module.exports = { install };
