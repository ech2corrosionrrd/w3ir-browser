'use strict';
// Узгоджена «особа» Chrome для сторінки: вхід Google відхиляє клієнтів, у яких User-Agent, navigator.userAgentData
// (немає бренду «Google Chrome») і window.chrome (порожній) суперечать один одному. Підміна робиться через CDP,
// тому діє й на мережеві заголовки sec-ch-ua*, і на JavaScript сторінки.

const CHROME_SHIM = `(() => {
  try {
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

function chromeIdentity(wc) {
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    const send = (m, p) => wc.debugger.sendCommand(m, p).catch(() => {});
    send('Emulation.setUserAgentOverride', { userAgent: wc.getUserAgent().replace(/\s(Electron|w3ir-browser|W3IR\S*)\/\S+/g, ''), userAgentMetadata: metadata() });
    send('Page.enable', {}).then(() => send('Page.addScriptToEvaluateOnNewDocument', { source: CHROME_SHIM }));
  } catch { /* відладчик недоступний (наприклад, відкрито DevTools) */ }
}

module.exports = { chromeIdentity, metadata, CHROME_SHIM };
