'use strict';
// Добровільні пожертви на розвиток проєкту. Адреса лише для отримання (Solana) і не пов'язана з вбудованим гаманцем.
// Той самий рядок має бути в README.md і docs/README-uk.md (звіряється unit-тестом test/unit/support.test.js).
const DONATE = Object.freeze({ chain: 'Solana', symbol: 'SOL', address: '63u6SDZckvzcJhC4V5yJn6bZ15qx1iM8c6iB3Z9xD1tn' });

function info() {
  return { ok: true, chain: DONATE.chain, symbol: DONATE.symbol, address: DONATE.address, qr: require('./qr').encode(DONATE.address) };
}

module.exports = { DONATE, info };
