'use strict';
/**
 * W3IR Browser — Нативний Arweave Wallet (ArConnect / Wander API стандарт)
 * 
 * Реалізує:
 * - Розрахунок Arweave-адрес (43 символи base64url) з публічного модуля RSA (SHA-256)
 * - Генерацію та імпорт ключів Arweave JWK (RSA-PSS)
 * - Підпис довільних повідомлень (RSASSA-PSS SHA-256) через node:crypto без сторонніх залежностей.
 *   Підпис та відправка транзакцій не підтримуються: потрібен deep-hash за специфікацією Arweave.
 * - Обробку dApp-запитів стандарту window.arweaveWallet
 */

const crypto = require('crypto');
const { t: tr } = require('./i18n');

const MAX_SIGN_BYTES = 64 * 1024;

// Дані для підпису від сторінки: рядок, масив байтів або об'єкт {0: .., 1: ..} (так приходить Uint8Array через міст)
function toBytes(v) {
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  if (Array.isArray(v)) return Buffer.from(v);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length && keys.every(k => /^\d+$/.test(k))) return Buffer.from(keys.map(k => Number(v[k]) & 255));
  }
  throw new Error('Invalid data');
}

/**
 * Обчислює 43-значну адресу Arweave з публічного модуля RSA (base64url)
 * @param {string} ownerBase64Url 
 * @returns {string}
 */
function ownerToAddress(ownerBase64Url) {
  if (typeof ownerBase64Url !== 'string' || !ownerBase64Url) {
    throw new Error('Invalid owner public key');
  }
  const buf = Buffer.from(ownerBase64Url, 'base64url');
  return crypto.createHash('sha256').update(buf).digest('base64url');
}

/**
 * Генерує новий RSA-PSS ключ у форматі JWK для Arweave
 * @returns {object} JWK об'єкт
 */
function generateArweaveJwk() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  return privateKey.export({ format: 'jwk' });
}

/**
 * Підписує дані алгоритмом RSASSA-PSS SHA-256
 * @param {object} jwk 
 * @param {Buffer|Uint8Array|string} data 
 * @returns {Buffer}
 */
function signData(jwk, data) {
  if (!jwk || !jwk.n || !jwk.d) throw new Error('Invalid Arweave JWK');
  const priv = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const signer = crypto.createSign('sha256');
  signer.update(Buffer.isBuffer(data) ? data : Buffer.from(data));
  return signer.sign({
    key: priv,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
}

/**
 * Перевіряє підпис RSASSA-PSS SHA-256
 * @param {object|string} jwkOrN JWK або публічний модуль n
 * @param {Buffer|Uint8Array|string} data 
 * @param {Buffer|Uint8Array|string} signature 
 * @returns {boolean}
 */
function verifySignature(jwkOrN, data, signature) {
  const n = typeof jwkOrN === 'string' ? jwkOrN : (jwkOrN && jwkOrN.n);
  const e = (typeof jwkOrN === 'object' && jwkOrN.e) || 'AQAB';
  if (!n) return false;
  try {
    const pub = crypto.createPublicKey({ key: { kty: 'RSA', n, e }, format: 'jwk' });
    const verifier = crypto.createVerify('sha256');
    verifier.update(Buffer.isBuffer(data) ? data : Buffer.from(data));
    const sigBuf = Buffer.isBuffer(signature) ? signature : Buffer.from(signature, 'base64url');
    return verifier.verify({
      key: pub,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    }, sigBuf);
  } catch {
    return false;
  }
}

/**
 * Міксин методів Arweave у головний прототип Wallet
 */
function install(Wallet, { RpcError, unauthorized, clip }) {
  Object.assign(Wallet.prototype, {
    arGetAccount() {
      if (!this.unlocked()) return null;
      const s = this.section();
      if (!s.arweave) {
        // Ключ випадковий і зберігається лише в зашифрованому сховищі гаманця (із сід-фрази не виводиться)
        const jwk = generateArweaveJwk();
        const address = ownerToAddress(jwk.n);
        s.arweave = { jwk, address, connections: {} };
        this.signerLock(); // з'явився новий ключ: підписувач отримає його при наступному розблокуванні
        this.vault.persist();
      }
      return s.arweave;
    },

    arIsConnected(origin) {
      const acc = this.arGetAccount();
      if (!acc || !acc.connections) return false;
      const conn = acc.connections[origin];
      return !!(conn && Array.isArray(conn.permissions));
    },

    arHasPermission(origin, perm) {
      return this.arPermissions(origin).includes(perm);
    },

    arPermissions(origin) {
      const acc = this.arGetAccount();
      if (!acc || !acc.connections) return [];
      const conn = acc.connections[origin];
      return conn && Array.isArray(conn.permissions) ? conn.permissions : [];
    },

    async arRequest(win, tab, origin, method, params, sameTab) {
      const acc = this.arGetAccount();
      if (!acc) throw unauthorized(tr('Спершу розблокуйте сховище гаманця'));

      switch (method) {
        case 'arweave_connect': {
          const requestedPerms = Array.isArray(params && params.permissions) ? params.permissions : [
            'ACCESS_ADDRESS',
            'ACCESS_ALL_ADDRESSES',
            'SIGN_TRANSACTION',
            'DISPATCH',
            'SIGNATURE',
            'ACCESS_PUBLIC_KEY',
          ];
          const appName = (params && params.appInfo && params.appInfo.name) || origin;
          const ok = await this.approve(win, origin, sameTab, {
            kind: 'connect',
            title: tr('Підключення до Arweave dApp'),
            lines: [
              ['Додаток', clip(appName, 50)],
              ['Адреса Arweave', clip(acc.address, 43)],
              ['Запитувані права', requestedPerms.join(', ')],
            ],
            warnings: [tr('Сайт зможе запитувати підписи транзакцій Arweave.')],
          });
          if (!ok) throw new RpcError(4001, tr('Користувач відхилив запит підключення'));
          acc.connections[origin] = {
            permissions: requestedPerms,
            appInfo: params && params.appInfo ? params.appInfo : null,
            connectedAt: Date.now(),
          };
          this.vault.persist();
          return true;
        }

        case 'arweave_disconnect': {
          if (acc.connections && acc.connections[origin]) {
            delete acc.connections[origin];
            this.vault.persist();
          }
          return true;
        }

        case 'arweave_getActiveAddress': {
          if (!this.arIsConnected(origin)) throw unauthorized(tr('Сайт не підключено'));
          return acc.address;
        }

        case 'arweave_getAllAddresses': {
          if (!this.arIsConnected(origin)) throw unauthorized(tr('Сайт не підключено'));
          return [acc.address];
        }

        case 'arweave_getWalletNames': {
          if (!this.arIsConnected(origin)) throw unauthorized(tr('Сайт не підключено'));
          return { [acc.address]: 'W3IR Arweave Wallet' };
        }

        case 'arweave_getActivePublicKey': {
          if (!this.arIsConnected(origin)) throw unauthorized(tr('Сайт не підключено'));
          return acc.jwk.n;
        }

        case 'arweave_getPermissions': {
          return this.arPermissions(origin);
        }

        case 'arweave_sign':
        case 'arweave_dispatch':
          throw new RpcError(4200, tr('Підпис і відправка транзакцій Arweave поки не підтримуються.'));

        case 'arweave_signature': {
          if (!this.arIsConnected(origin)) throw unauthorized(tr('Сайт не підключено'));
          if (!this.arHasPermission(origin, 'SIGNATURE')) throw unauthorized(tr('Сайт не має права SIGNATURE'));
          let raw;
          try { raw = toBytes(params && params.data); } catch { throw new RpcError(-32602, tr('Недійсні дані для підпису')); }
          if (!raw.length || raw.length > MAX_SIGN_BYTES) throw new RpcError(-32602, tr('Розмір даних для підпису має бути від 1 байта до 64 КБ'));
          const text = raw.toString('utf8');
          const printable = !/[\u0000-\u0008\u000e-\u001f\ufffd]/.test(text);
          const ok = await this.approve(win, origin, sameTab, {
            kind: 'sign',
            title: tr('Підпис даних ключем Arweave'),
            lines: [
              ['Сайт', origin],
              ['Розмір', tr('{0} байт', raw.length)],
              ['SHA-256', crypto.createHash('sha256').update(raw).digest('hex')],
              [printable ? 'Вміст' : 'Вміст (hex)', clip(printable ? text : raw.toString('hex'), 300)],
            ],
            warnings: [tr('Підписуйте лише дані, які розумієте: підпис ключем Arweave може бути використаний як підтвердження дії від вашої адреси.')],
          });
          if (!ok) throw new RpcError(4001, tr('Користувач відхилив підпис'));
          return Array.from((await this.signerCall('arSign', { data: raw })).signature); // підписує процес-підписувач
        }

        default:
          throw new RpcError(4200, tr('Метод Arweave не підтримується: {0}', clip(method, 40)));
      }
    },
  });
}

module.exports = {
  ownerToAddress,
  generateArweaveJwk,
  signData,
  verifySignature,
  install,
};
