# Огляд сторонніх репозиторіїв

_Складено 2026-10-16 за даними GitHub (зірки, ліцензія, дата останнього коміту); оновлено 2026-10-20 (версія 1.38.0). Код репозиторіїв не аудитовано; перед використанням перечитати ліцензію._

## Рішення

| Статус | Репозиторій | Ліцензія | Навіщо |
|---|---|---|---|
| ✅ Зроблено | MetaMask/eth-phishing-detect | DBAD (SPDX: NOASSERTION) | Список web3-фішингу (~107 тис. доменів). Додано джерелом `ethphish` у `src/threats.js`; береться лише `blacklist`, дані завантажуються під час роботи |
| ✅ Зроблено | polkadot-js/phishing | Apache-2.0 | Додатковий список шахрайських криптодоменів (`all.json`, поле `deny`). Додано джерелом `dotphish` у `src/threats.js` |
| ✅ Зроблено | RevokeCash/whois, WalletGuard | MIT | Захист від дрейнерів: розбір `permit`/`Permit2`/`Seaport`, відхилення `EIP-7702`, симуляція транзакцій (`eth_simulateV1`), перевірка/відкликання token allowance та реєстр відомих роутерів (`KNOWN_SPENDERS` у `src/wallet-signguard.js`) |
| ✅ Зроблено | haveibeenpwned/pwned-passwords | BSD-3-Clause / CC-BY-4.0 | Перевірка збережених паролів на витоки за k-анонімністю (`src/vault.js`: надсилаються лише 5 символів SHA-1 префікса, звірка суфікса локальна, opt-in) |
| ✅ Зроблено | ghostery/adblocker (fullLists) | MPL-2.0 | Приховування банерів cookie (`easylist-cookie`, `ublock-annoyances-cookies`) через `fromPrebuiltFull` у `src/adblock.js` та розширене очищення трекінгових URL-параметрів у `src/urlrules.js` |
| ✅ Готово в ядрі | node:sqlite (Node 24 у складі Electron 44) | MIT | Вбудована підтримка SQLite з повнотекстовим індексом FTS5 та алгоритмом Frecency (`src/places.js`). Замінює `better-sqlite3` та `minisearch` без `node-gyp` |
| ✅ Готово в ядрі | node:crypto (Ed25519) | MIT | Нативна генерація та підпис Ed25519 у Node 24 для Solana (`src/solana.js`) без сторонніх бібліотек |
| ✅ Зроблено | Irys-xyz/js-sdk, ArweaveTeam/arweave-standards | Apache-2.0 / MIT | Постійне зберігання NFT-метаданих і медіа на Arweave (`gateway.irys.xyz` + `arweave.net`), нативний протокол `ar://`, маніфести шляхів `arweave/paths` (ANS-105), вибір найшвидшого шлюзу (`probeGateways`) та валідатор Arweave NFT-метаданих у `src/arweave.js` |
| ✅ Зроблено | anza-xyz/wallet-standard | Apache-2.0 | Офіційний стандарт інжекції гаманця Solana (`window.solana`, `window.phantom.solana`, подія `wallet-standard:register-wallet`) |
| ✅ Зроблено | ollama/ollama, protectai/rebuff | MIT / Apache-2.0 | Локальний ШІ-помічник (`w3ir://assistant`), локальний переклад статей у Режимі читання (`src/ollama.js`) та захист від непрямого Prompt Injection (`src/injection-guard.js`) |
| 📋 До реалізації | argotorg/sourcify (API v2) | MIT | Перевірка верифікації смартконтракту перед підписом транзакції (opt-in) |
| 📋 До реалізації | cantoo-scribe/pdf-lib (`@cantoo/pdf-lib`) | MIT | Активно підтримуваний форк `pdf-lib` для заміни `pdf-lib@1.17.1` |
| ⏸ Відкладено | LedgerHQ/ledgerjs, trezor/connect | Apache-2.0 / MIT | Підключення апаратних гаманців через нативний WebHID сесії Electron (відкладено до появи фізичного пристрою для чесної верифікації) |
| ⏭ Далі | castlabs/electron-releases | MIT | Форк Electron із Widevine (DRM). Потрібні акаунт EVS для підпису VMP і окреме тестування |
| ⏭ Далі | vedantmgoyal9/winget-releaser | AGPL-3.0 | GitHub Action для автоподачі PR у winget-pkgs (лише в CI) |
| ⏸ Рішення власника | samuelmaddock/electron-browser-shell | GPL-3.0 | Найповніша підтримка розширень Chrome; лише як архітектурний зразок, щоб уникнути копілефтного зараження GPL |

## Не підходить

- Jelmerro/Vieb (GPL, vim-керування) — лише ідея клавіатурної навігації.
- pfrazee/electron-browser, gerhardberger/electron-pdf-window — застарілі репозиторії.
- sindresorhus/electron-store — власне зашифроване сховище з DPAPI надійніше.
- brave/adblock-rust — вже є стабільний `@ghostery/adblocker`.
- WiseLibs/better-sqlite3, lucaong/minisearch — надлишкові, оскільки в Electron 41 вже є нативний `node:sqlite` з FTS5.
- Pinata / IPFS — суворо заборонено глобальною директивою; єдиний обов'язковий децентралізований стандарт — Arweave.

## Нотатки

- **Ліцензійна чистота**: W3IR Browser ліцензовано під MIT. Код із репозиторіїв з копілефтними ліцензіями (GPL-3.0 / AGPL-3.0) заборонено копіювати безпосередньо. Використовуємо лише їхні відкриті специфікації, динамічні дані або чисті альтернативи (MIT / Apache-2.0 / MPL-2.0).
- **Arweave & Irys**: протокол `ar://<txId>` резолвиться через пул надійних публічних шлюзів (`https://gateway.irys.xyz/`, `https://arweave.net/`).
- **ШІ**: Anthropic OAuth лише для Claude Code через локальний MCP (`docs/AI-MCP.md`); для повністю автономної роботи — локальний Ollama.


## Огляд для ідей (2026-10-18)

Переглянуто опис і активність відомих відкритих проєктів (код не копіюється, береться лише ідея; ліцензії за даними GitHub). Висновки й пріоритети — у розділі «Ідеї з інших проєктів» у [PLAN.md](PLAN.md).

| Проєкт | Ліцензія | Чим цікавий |
|---|---|---|
| minbrowser/min | Apache-2.0 | мінімалістичний браузер: «завдання» (групи вкладок), закладки з тегами, читання |
| zen-browser/desktop | MPL-2.0 | компактний режим, «Glance» (перегляд посилання поверх сторінки), робочі простори |
| mullvad/mullvad-browser | MPL (з Tor Project) | протидія відбиткам: однакові параметри в усіх, letterboxing |
| gorhill/uBlock | GPL-3.0 | динамічна фільтрація за типом запиту й сайтом (ідея, не код) |
| ghostery/ghostery-extension | GPL-3.0 | автоматичне відхилення банерів cookie, статистика трекерів |
| bitwarden/clients | змішана | TOTP-коди, перевірка паролів на витоки (k-анонімність) |
| RabbyHub/Rabby | змішана | оцінка ризику перед підписом, перша взаємодія з контрактом, авто-перемикання мережі |
| safe-global/safe-wallet-monorepo | GPL-3.0 | мультипідпис (Safe): перегляд і підпис |
| anza-xyz/wallet-adapter | Apache-2.0 | еталон інтеграції гаманців Solana |
| LadybirdBrowser/ladybird | BSD-2-Clause | незалежний рушій (не для нас: працюємо на Chromium) |
| ungoogled-software/ungoogled-chromium | BSD-3-Clause | зняття залежностей від служб Google, перелік каналів зв'язку Chromium |
| brave/brave-core | MPL-2.0 | щити, Tor-вікно, локальний ШІ |
| WalletConnect/walletconnect-monorepo | змішана | з'єднання з мобільними гаманцями через релеї (суперечить автономності, відкладено) |
