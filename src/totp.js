// @ts-check
'use strict';
/**
 * Реалізація одноразових паролів на основі часу (TOTP, RFC 6238 / RFC 4226).
 * Використовується для двофакторної автентифікації (2FA) без сторонніх бібліотек.
 */
const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Декодує рядок Base32 у буфер байтів.
 * @param {string} str
 * @returns {Buffer}
 */
function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (let i = 0; i < clean.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(clean[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * Розбирає otpauth:// URI або чистий Base32 секрет.
 * @param {string} input
 * @returns {{ secret: string, digits: number, period: number, algo: string } | null}
 */
function parseOtpAuth(input) {
  input = String(input || '').trim();
  if (!input) return null;
  if (input.toLowerCase().startsWith('otpauth://')) {
    try {
      const u = new URL(input);
      const secret = (u.searchParams.get('secret') || '').replace(/[\s=-]/g, '').toUpperCase();
      if (!secret) return null;
      const digits = Math.min(8, Math.max(6, parseInt(u.searchParams.get('digits') || '6', 10) || 6));
      const period = Math.min(120, Math.max(10, parseInt(u.searchParams.get('period') || '30', 10) || 30));
      const rawAlgo = (u.searchParams.get('algorithm') || 'sha1').toLowerCase();
      const algo = ['sha1', 'sha256', 'sha512'].includes(rawAlgo) ? rawAlgo : 'sha1';
      return { secret, digits, period, algo };
    } catch {
      return null;
    }
  }
  const secret = input.replace(/[\s=-]/g, '').toUpperCase();
  if (!secret || !/^[A-Z2-7]+$/.test(secret)) return null;
  return { secret, digits: 6, period: 30, algo: 'sha1' };
}

/**
 * Генерує TOTP-код згідно з RFC 6238.
 * @param {string} secretOrUri Секрет Base32 або рядок otpauth://
 * @param {number} [timeSec] Час в епоху UNIX (секунди), за замовчуванням Date.now() / 1000
 * @returns {{ code: string, remaining: number, period: number } | null}
 */
function generateTotp(secretOrUri, timeSec) {
  const parsed = parseOtpAuth(secretOrUri);
  if (!parsed) return null;
  const { secret, digits, period, algo } = parsed;
  const key = base32Decode(secret);
  if (!key.length) return null;

  const now = typeof timeSec === 'number' ? timeSec : Math.floor(Date.now() / 1000);
  const counter = Math.floor(now / period);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac(algo, key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) |
                 ((hmac[offset + 1] & 0xff) << 16) |
                 ((hmac[offset + 2] & 0xff) << 8) |
                 (hmac[offset + 3] & 0xff);
  const code = (binary % (10 ** digits)).toString().padStart(digits, '0');
  const remaining = period - (now % period);

  return { code, remaining, period };
}

module.exports = {
  base32Decode,
  parseOtpAuth,
  generateTotp,
};
