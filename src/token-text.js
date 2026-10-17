'use strict';
// Рядки, які задає творець токена (name, symbol), недовірені: прибираємо невидимі й керівні символи
// (підміна напрямку тексту, нульова ширина), керівні коди, обмежуємо довжину.
const { sanitize } = require('./injection-guard');

function injectionClean(text, max = 48) {
  return sanitize(String(text == null ? '' : text)).text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

module.exports = { injectionClean };
