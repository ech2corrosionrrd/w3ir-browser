# Огляд сторонніх репозиторіїв

_Складено 2026-10-16 за даними GitHub (зірки, ліцензія, дата останнього коміту); оновлено після випуску 1.15.x. Код репозиторіїв не аудитовано; перед використанням перечитати ліцензію._

## Рішення

| Статус | Репозиторій | Ліцензія | Навіщо |
|---|---|---|---|
| ✅ Зроблено | MetaMask/eth-phishing-detect | DBAD (SPDX: NOASSERTION) | Список web3-фішингу (~107 тис. доменів). Додано джерелом `ethphish` у `src/threats.js`; береться лише `blacklist`, дані завантажуються під час роботи |
| ✅ Готово в ядрі | node:sqlite (Node 24 у складі Electron 41) | MIT | Вбудована підтримка SQLite з повнотекстовим індексом FTS5! Замінює `better-sqlite3` та `minisearch`. Жодних зовнішніх бінарних залежностей, без ризиків збирання node-gyp |
| ✅ Готово в ядрі | node:crypto (Ed25519) | MIT | Нативна генерація та підпис Ed25519 у Node 24 для Solana без потреби у сторонніх важких бібліотеках |
| 🚀 В роботі | Irys-xyz/js-sdk, arweaveTeam/arweave-js | Apache-2.0 / MIT | Постійне зберігання NFT-метаданих і медіа на Arweave (`node1.irys.xyz` + шлюзи `arweave.net`). Нативна підтримка протоколу `ar://` у браузері |
| 📋 До реалізації | anza-xyz/wallet-standard | Apache-2.0 | Офіційний стандарт інжекції гаманця Solana (`@wallet-standard/core`, подія `wallet-standard:register-wallet`) для повної сумісності з dApps |
| 📋 До реалізації | WalletGuard/extension, RevokeCash/revoke.cash | GPL-3.0 / MIT | Захист від дрейнерів: виявлення `permit`/`permit2`, `eth_sign`, `SetAuthority`, симуляція транзакцій та перевірка/відкликання token allowance |
| 📋 До реалізації | mozilla/gecko-dev (places.sqlite) | MPL-2.0 | Архітектура таблиць історії та алгоритм Frecency (частота + свіжість запитів) |
| 📋 До реалізації | LedgerHQ/ledgerjs, trezor/connect | Apache-2.0 / MIT | Підключення апаратних гаманців через нативний WebHID сесії Electron (`session.setDevicePermissionHandler`) без C++ компіляторів |
| 📋 До реалізації | ollama/ollama-js, protectai/rebuff | MIT / Apache-2.0 | Інтеграція локальних моделей через локальний MCP/HTTP та захист від непрямого Prompt Injection у веб-сторінках |
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

