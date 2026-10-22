'use strict';
// Режими захисту приватності: «Стандартний», «Суворий», «Максимальний». Чисті функції без Electron (тести: test/unit/protection.test.js).
//   standard: поточна поведінка (нічого додаткового).
//   strict:   сторонні cookie блокуються (запит без Cookie, відповідь без Set-Cookie), WebRTC не розкриває локальні адреси.
//   maximum:  те саме + WebRTC лише через проксі (прямого UDP немає) + Referer до сторонніх сайтів не надсилається.
// Сайти, для яких блокувальник вимкнено («щити»), і вхід Google виключені з обмежень: інакше ламаються входи й оплата.

const LEVELS = ['standard', 'strict', 'maximum'];

// Перемикачі приватності, які вмикає режим (користувач потім може вимкнути окремі в налаштуваннях)
const PRESETS = {
  standard: {},
  strict: { adblock: true, sendGpc: true, httpsFirst: true, stripTracking: true, safeBrowsing: true, fingerprintProtection: false },
  maximum: { adblock: true, sendGpc: true, httpsFirst: true, stripTracking: true, safeBrowsing: true, fingerprintProtection: true },
};

const level = (v) => (LEVELS.includes(v) ? v : 'standard');
const isStrict = (v) => level(v) !== 'standard';

// Округлення вимірів екрана до найближчих 100 пікселів (screen normalization)
const roundDimension = (n) => Math.max(100, Math.round(Number(n || 0) / 100) * 100);

// Внесення мікрошуму в Canvas (наймолодший біт окремих пікселів) для руйнування відбитків
function applyCanvasNoise(uint8Arr) {
  if (!uint8Arr || uint8Arr.length < 16) return false;
  const step = Math.max(4, Math.floor(uint8Arr.length / 32));
  for (let i = 0; i < uint8Arr.length; i += step) {
    uint8Arr[i] = uint8Arr[i] ^ 1;
  }
  return true;
}

function webrtcPolicy(v) {
  return { standard: 'default', strict: 'default_public_interface_only', maximum: 'disable_non_proxied_udp' }[level(v)];
}

const GOOGLE_ACCOUNTS = /^accounts\.(google|youtube)\./i;

// Чи є запит сторонім відносно верхньої сторінки (різні сайти за реєстрованим доменом). siteKey(host) → реєстрований домен.
function isThirdParty(requestUrl, topHost, siteKey) {
  let host;
  try { host = new URL(requestUrl).hostname.toLowerCase(); } catch { return false; }
  if (!host || !topHost) return false;
  if (GOOGLE_ACCOUNTS.test(host) || GOOGLE_ACCOUNTS.test(topHost)) return false;
  return siteKey(host) !== siteKey(topHost);
}

const dropHeader = (headers, name) => {
  let hit = false;
  if (!headers) return hit;
  for (const k of Object.keys(headers)) if (k.toLowerCase() === name) { delete headers[k]; hit = true; }
  return hit;
};

// Прибирає Cookie із запиту; повертає true, якщо щось змінено
const stripCookieRequest = (headers) => dropHeader(headers, 'cookie');
// Прибирає Set-Cookie з відповіді; повертає true, якщо щось змінено
const stripSetCookie = (headers) => dropHeader(headers, 'set-cookie');

// Referer до сторонніх сайтів прибирається повністю (Chromium і так скорочує його до адреси сайту); true, якщо щось змінено
const dropReferrer = (headers) => dropHeader(headers, 'referer');

// Підсумок стану захисту для панелі W3IR Shield
function shieldSummary({ adblock = true, siteAllowed = false, protection = 'standard', fingerprintProtection = false, stripTracking = false, httpsFirst = false } = {}) {
  const protLevel = level(protection);
  const adblockActive = !!adblock && !siteAllowed;
  const fpActive = !siteAllowed && !!(fingerprintProtection || protLevel === 'maximum');
  const thirdPartyCookiesBlocked = !siteAllowed && protLevel !== 'standard';
  const webrtc = webrtcPolicy(protLevel);
  return {
    protLevel,
    adblockActive,
    fpActive,
    thirdPartyCookiesBlocked,
    webrtc,
    stripTracking: !!stripTracking,
    httpsFirst: !!httpsFirst,
  };
}

module.exports = { LEVELS, PRESETS, level, isStrict, webrtcPolicy, isThirdParty, stripCookieRequest, stripSetCookie, dropReferrer, roundDimension, applyCanvasNoise, shieldSummary };
