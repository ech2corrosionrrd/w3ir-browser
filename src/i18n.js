'use strict';
// Багатомовність. Мова-джерело — українська: рядки в коді українською є ключами каталогів locales/<код>.json
// ({"укр. рядок": "переклад"}); динамічні частини в ключах позначені {0}, {1}… Російської мови немає навмисно.
// Головний процес використовує t(); сторінки й інтерфейс отримують каталог скриптом i18n.js (pages/i18n-dom.js).
const fs = require('fs');
const path = require('path');

const LOCALES_DIR = path.join(__dirname, '..', 'locales');
// код → { назва мовою самої мови, BCP-47 для дат і чисел }
const LANGS = {
  uk: { name: 'Українська', locale: 'uk-UA' },
  en: { name: 'English', locale: 'en-GB' },
};

const fmt = (s, args) => String(s).replace(/\{(\d+)\}/g, (m, i) => (args[i] !== undefined ? String(args[i]) : m));

class I18n {
  constructor(dir = LOCALES_DIR) {
    this.dir = dir;
    this.lang = 'uk';
    this.map = null; // null = українська (рядки без змін)
    this.cache = new Map();
  }

  // 'auto' → мова системи, якщо підтримується; російська й невідомі системні мови: ru → uk, решта → en
  resolve(setting, systemLocale) {
    if (setting && setting !== 'auto') return LANGS[setting] ? setting : 'uk';
    const base = String(systemLocale || '').toLowerCase().split(/[-_]/)[0];
    if (LANGS[base]) return base;
    return base === 'ru' || base === 'be' ? 'uk' : 'en';
  }

  load(lang) {
    if (lang === 'uk' || !LANGS[lang]) return null;
    if (this.cache.has(lang)) return this.cache.get(lang);
    let map = null;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.dir, lang + '.json'), 'utf8'));
      map = Object.create(null);
      for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && v) map[k] = v;
    } catch { /* немає каталогу — лишаємо українську */ }
    this.cache.set(lang, map);
    return map;
  }

  setLang(setting, systemLocale) {
    this.lang = this.resolve(setting, systemLocale);
    this.map = this.load(this.lang);
    return this.lang;
  }

  t(s, ...args) {
    const tr = this.map && this.map[s];
    return fmt(tr || s, args);
  }

  locale() { return LANGS[this.lang].locale; }

  // Скрипт для сторінок: дані каталогу + механізм перекладу DOM (pages/i18n-dom.js)
  script() {
    const engine = fs.readFileSync(path.join(__dirname, '..', 'pages', 'i18n-dom.js'), 'utf8');
    const data = { lang: this.lang, locale: this.locale(), map: this.map ? { ...this.map } : null };
    // «</» екранується, щоб JSON ніколи не міг закрити скрипт
    return 'window.__I18N=' + JSON.stringify(data).replace(/</g, '\u003c') + ';\n' + engine;
  }
}

const i18n = new I18n(); // спільний екземпляр: мова одна на весь застосунок (як тема)
const t = (s, ...args) => i18n.t(s, ...args);

module.exports = { I18n, LANGS, fmt, i18n, t };
