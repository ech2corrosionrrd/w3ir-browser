# Огляд сторонніх репозиторіїв

_Складено 2026-10-16 (версія 1.9.0) за даними GitHub: зірки, ліцензія, дата останнього коміту. Код репозиторіїв не аудитовано; перед використанням перечитати ліцензію._

## Рішення

| Статус | Репозиторій | Ліцензія | Навіщо |
|---|---|---|---|
| ✅ Зроблено | MetaMask/eth-phishing-detect | DBAD (SPDX: NOASSERTION) | Список web3-фішингу (~107 тис. доменів). Додано джерелом `ethphish` у `src/threats.js`; береться лише `blacklist`, дані завантажуються під час роботи, у збірку не входять |
| ⏭ Далі | castlabs/electron-releases | MIT | Форк Electron із Widevine (DRM). Є збірки для Electron 41 (`v41.10.7+wvcus`). Потрібні акаунт EVS (безкоштовний, на ім'я власника) для підпису VMP, тест на справжніх сервісах і перевірка fuses/asar. Без підпису частина сервісів відмовить |
| ⏭ Далі | ethereum-lists/chains | MIT | Метадані EVM-мереж (RPC, chainId): замінити ручний список мереж гаманця |
| ⏭ Далі | vedantmgoyal9/winget-releaser | AGPL-3.0 | GitHub Action для автоподачі PR у winget-pkgs (лише в CI, на код браузера не впливає). Після схвалення першого пакета |
| ⏸ Рішення власника | SignPath Foundation | — | Безкоштовний підпис для відкритих проєктів; вимагає відкрити код |
| ⏸ Рішення власника | samuelmaddock/electron-browser-shell (`electron-chrome-extensions`) | GPL-3.0 | Найповніша підтримка розширень Chrome. Як залежність заразить код GPL: або відкривати код під GPL, або лише читати як еталон |
| 🕓 Пізніше | scamsniffer/scam-database | GPL-3.0 | Додаткові web3-чорні списки (дані; юридично уточнити) |
| 🕓 Пізніше | wevm/viem, anza-xyz/kit | MIT | Альтернатива `ethers`; Solana SDK, коли дійде до Solana |
| 🕓 Пізніше | WiseLibs/better-sqlite3 | MIT | Історія понад 20 000 записів (нативний модуль: перебудова під Electron, розпакування з asar) |
| 🕓 Пізніше | lucaong/minisearch, nextapps-de/flexsearch | MIT / Apache-2.0 | Повнотекстовий пошук по історії (`minisearch` простіший) |
| 🕓 Пізніше | mozilla/pdf.js | Apache-2.0 | Анотації PDF; замінює вбудований переглядач Chromium — велика зміна |
| 🕓 Пізніше | LedgerHQ/ledger-live, trezor/trezor-suite | MIT / змішана | Еталон для апаратних гаманців (WebHID/WebUSB) |

## Не підходить

- Jelmerro/Vieb (GPL, vim-керування) — лише ідея клавіатурної навігації.
- pfrazee/electron-browser, gerhardberger/electron-pdf-window — не оновлюються з 2022 року.
- sindresorhus/electron-store — власне зашифроване сховище з DPAPI краще.
- brave/adblock-rust — вже є `@ghostery/adblocker`.

## Нотатки

- DBAD («Don't be a dick») — дозвільна ліцензія без юридичного тексту; використання лише як завантажуваних даних ризик мінімізує.
- Для castlabs спершу перевірити, що сумісні `electronFuses` та `electron-builder`, і що автооновлення не ламається (форк змінює бінарник Electron, не код застосунку).
