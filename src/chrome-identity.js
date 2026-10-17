'use strict';
// Узгоджена «особа» Chrome для сторінки: вхід Google відхиляє клієнтів, у яких User-Agent, navigator.userAgentData
// (немає бренду «Google Chrome») і window.chrome (порожній) суперечать один одному. Підміна робиться через CDP,
// тому діє й на мережеві заголовки sec-ch-ua*, і на JavaScript сторінки.

const CHROME_SHIM = `(() => {
  try {
    if (!/^([\\w-]+\\.)*(google\\.[a-z.]+|youtube\\.com)$/i.test(location.hostname)) return;
    const c = window.chrome;
    if (c && Object.keys(c).length) return;
    const now = () => Date.now() / 1000;
    const chrome = c || {};
    chrome.app = {
      isInstalled: false,
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      getDetails() { return null; }, getIsInstalled() { return false; }, runningState() { return 'cannot_run'; },
    };
    chrome.csi = () => ({ onloadT: Date.now(), startE: Date.now() - Math.round(performance.now()), pageT: performance.now(), tran: 15 });
    chrome.loadTimes = () => ({
      requestTime: now(), startLoadTime: now(), commitLoadTime: now(), finishDocumentLoadTime: now(), finishLoadTime: now(),
      firstPaintTime: now(), firstPaintAfterLoadTime: 0, navigationType: 'Other', wasFetchedViaSpdy: true, wasNpnNegotiated: true,
      npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false, connectionInfo: 'h2',
    });
    if (!c) Object.defineProperty(window, 'chrome', { value: chrome, writable: true, configurable: true, enumerable: true });
  } catch { /* ignore */ }
})();`;

function metadata() {
  const full = process.versions.chrome, major = full.split('.')[0];
  const brands = [{ brand: 'Chromium', version: major }, { brand: 'Google Chrome', version: major }, { brand: 'Not_A Brand', version: '24' }];
  return {
    brands,
    fullVersionList: brands.map(b => ({ brand: b.brand, version: b.brand === 'Not_A Brand' ? '24.0.0.0' : full })),
    platform: 'Windows', platformVersion: '10.0.0', architecture: 'x86', model: '', mobile: false, bitness: '64', wow64: false,
  };
}

// Особа Chrome потрібна лише для входу Google. На інших сайтах вона шкодить: Cloudflare Turnstile (Tensor та ін.) бачить
// «Chrome» без справжнього Google Chrome (в iframe лишаються Electron-ознаки, бракує розширень) і не пропускає браузер,
// тоді як чесний User-Agent із «Electron» проходить. Тому особа вмикається тільки на сторінках Google/YouTube.
const GOOGLE_HOST = /^([\w-]+\.)*(google\.(com|(co|com)\.[a-z]{2}|[a-z]{2})|youtube\.com)$/i;
function isGoogleUrl(u) {
  try { const x = new URL(u); return x.protocol === 'https:' && GOOGLE_HOST.test(x.hostname); } catch { return false; }
}
const cleanUserAgent = (ua) => ua.replace(/\s(Electron|w3ir-browser|W3IR\S*)\/\S+/g, '');

function chromeIdentity(wc) {
  const send = (m, p) => wc.debugger.sendCommand(m, p).catch(() => {});
  // Відладчик приєднаний завжди (щоб шим був зареєстрований до першої навігації), але підміна User-Agent вмикається
  // лише на сторінках Google; шим сам перевіряє хост, тож на інших сайтах нічого не змінює.
  const route = (url) => {
    if (!wc.debugger.isAttached()) return;
    if (isGoogleUrl(url)) send('Emulation.setUserAgentOverride', { userAgent: cleanUserAgent(wc.getUserAgent()), userAgentMetadata: metadata() });
    else send('Emulation.setUserAgentOverride', { userAgent: '' });
  };
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    send('Page.enable', {}).then(() => send('Page.addScriptToEvaluateOnNewDocument', { source: CHROME_SHIM }));
    wc.on('did-start-navigation', (d) => { if (d.isMainFrame && !d.isSameDocument) route(d.url); });
    wc.on('did-redirect-navigation', (d) => { if (d.isMainFrame) route(d.url); });
    route(wc.getURL());
  } catch { /* відладчик недоступний (наприклад, відкрито DevTools) */ }
}

module.exports = { chromeIdentity, metadata, CHROME_SHIM, isGoogleUrl, cleanUserAgent };
