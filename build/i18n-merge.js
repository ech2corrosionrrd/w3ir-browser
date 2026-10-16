'use strict';
// Додає переклади до locales/<мова>.json з патч-файлу {"український ключ": "переклад"}: node build/i18n-merge.js en patch.json
const fs = require('fs');
const path = require('path');
const [, , lang, patch] = process.argv;
const file = path.join(__dirname, '..', 'locales', lang + '.json');
const cat = JSON.parse(fs.readFileSync(file, 'utf8'));
const add = JSON.parse(fs.readFileSync(patch, 'utf8'));
const ph = (s) => (s.match(/\{\d+\}/g) || []).sort().join();
let n = 0;
for (const [k, v] of Object.entries(add)) {
  if (ph(k) !== ph(v)) { console.log('підстановки не збігаються:', k); continue; }
  cat[k] = v; n++;
}
const sorted = Object.fromEntries(Object.entries(cat).sort((a, b) => a[0].localeCompare(b[0], 'uk')));
fs.writeFileSync(file, JSON.stringify(sorted, null, 1) + '\n');
console.log(`${lang}: додано/оновлено ${n}`);
