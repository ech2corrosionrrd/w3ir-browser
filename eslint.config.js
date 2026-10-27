'use strict';
// Мінімальний лінт: лише помилки (невизначені/невикористані змінні, недосяжний код), без правил про стиль.
const globals = require('globals');

const rules = {
  'no-undef': 'error', 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }], 'no-unreachable': 'error',
  'no-dupe-keys': 'error', 'no-dupe-args': 'error', 'no-duplicate-case': 'error', 'no-redeclare': 'error',
  'no-self-assign': 'error', 'no-const-assign': 'error', 'no-func-assign': 'error', 'no-unsafe-finally': 'error',
  'no-cond-assign': 'error', 'no-constant-condition': ['error', { checkLoops: false }], 'use-isnan': 'error',
  'valid-typeof': 'error', 'no-unsafe-negation': 'error', 'require-atomic-updates': 'off', 'no-empty': ['warn', { allowEmptyCatch: true }],
};

// Загальні імена внутрішніх сторінок (pages/common.js, help-data.js, preload через contextBridge)
const pageShared = { app: 'writable', h: 'readonly', fmtBytes: 'readonly', fmtTime: 'readonly', fmtDay: 'readonly', debounce: 'readonly', ask: 'readonly', railNav: 'readonly',
  HELP: 'readonly', Markdown: 'readonly', Csv: 'readonly', SHORTCUTS: 'readonly', FAQ: 'readonly', w3ir: 'readonly', t: 'readonly', LOCALE: 'readonly' };

module.exports = [
  { ignores: ['dist/**', 'node_modules/**', 'build/keys/**', 'docs/**'] },
  { files: ['**/*.js'], ignores: ['pages/**', 'ui/**', 'page-preload.js'], languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } }, rules },
  // Ключі гаманця виводяться лише в процесі-підписувачі (docs/adr/0001-wallet-signer-process.md): нові місця виведення ключів із фрази заборонені.
  { files: ['src/**/*.js'], rules: { 'no-restricted-syntax': ['error',
    { selector: "Identifier[name='HDNodeWallet']", message: 'Key derivation from the phrase is allowed only in src/wallet-signer-core.js (ADR 0001).' },
    { selector: "MemberExpression[property.name='computeSeed']", message: 'The seed is computed only in src/wallet-signer-core.js (ADR 0001).' },
    { selector: "MemberExpression[object.name='Wallet'][property.name='fromPhrase']", message: 'Wallet.fromPhrase is forbidden outside src/wallet-signer-core.js (ADR 0001).' },
  ] } },
  { files: ['src/wallet-signer-core.js'], rules: { 'no-restricted-syntax': 'off' } },
  { files: ['page-preload.js'], languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node, ...globals.browser } }, rules },
  { files: ['pages/**/*.js'], ignores: ['pages/common.js', 'pages/help-data.js', 'pages/markdown.js', 'pages/csv.js'], languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: { ...globals.browser, ...pageShared } }, rules },
  { files: ['pages/markdown.js', 'pages/csv.js'], languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: { ...globals.browser, ...globals.node } }, rules },
  { files: ['pages/common.js', 'pages/help-data.js'], languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: { ...globals.browser, t: 'readonly', LOCALE: 'readonly' } }, rules: { ...rules, 'no-unused-vars': 'off' } },
  { files: ['ui/**/*.js'], languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: { ...globals.browser, api: 'readonly', t: 'readonly', LOCALE: 'readonly' } }, rules },
];
