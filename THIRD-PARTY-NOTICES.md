# Сторонні компоненти й дані (Third-Party Notices)

W3IR Browser розповсюджується за ліцензією MIT (див. [LICENSE](LICENSE)). Нижче перелічено сторонні компоненти, що входять до збірки або завантажуються під час роботи, та умови їхніх ліцензій. Повні тексти ліцензій лежать у відповідних пакетах `node_modules/<пакет>/LICENSE*` і в збірці.

## Рушій

| Компонент | Ліцензія | Примітка |
|---|---|---|
| Electron | MIT | Тексти ліцензій Electron і Chromium входять до збірки: `LICENSE.electron.txt`, `LICENSES.chromium.html` |
| Chromium (у складі Electron) | BSD-3-Clause та ліцензії вбудованих компонентів | Перелік — у `LICENSES.chromium.html` |

## Залежності, що входять до застосунку

| Пакет | Ліцензія | Умови |
|---|---|---|
| `@ghostery/adblocker`, `@ghostery/adblocker-electron`, `@ghostery/adblocker-electron-preload` та їхні залежності від Ghostery | MPL-2.0 | Файли пакетів не змінювалися. Вихідний код цих файлів доступний за адресою https://github.com/ghostery/adblocker |
| `@mozilla/readability` | Apache-2.0 | Режим читання; код не змінювався |
| `ethers` | MIT | Гаманець EVM |
| `electron-updater` | MIT | Завантаження оновлень |
| `pdf-lib` | MIT | Інструменти PDF |
| `tldts-experimental` | MIT | Розбір доменів |
| Дрібні транзитивні залежності | MIT, ISC, 0BSD, BlueOak-1.0.0, Python-2.0 (`argparse`), MIT AND Zlib (`pako`) | Умови — у `node_modules/<пакет>` |

## Дані, що завантажуються під час роботи (не входять до репозиторію)

Браузер завантажує ці списки на комп'ютер користувача й перевіряє адреси локально; у репозиторій вони не додаються.

| Джерело | Ліцензія | Умови |
|---|---|---|
| URLhaus (abuse.ch) | CC0 | Без обмежень; джерело зазначається в інтерфейсі |
| Phishing.Database (mitchellkrogza) | MIT | Нагадування про авторство нижче |
| MetaMask `eth-phishing-detect` | DON'T BE A DICK PUBLIC LICENSE v1.2 | Дозволено використання з вказанням джерела; не видавати за своє, не продавати без змін |
| Polkadot-JS `phishing` | Apache-2.0 | Нагадування про авторство нижче |
| Готові списки блокувальника, які віддає `@ghostery/adblocker` (`fromPrebuiltAdsAndTracking` / `fromPrebuiltFull`; зібрані зі стороннього набору фільтрів на кшталт EasyList і uBlock filters) | Ліцензії вихідних списків (зазвичай GPL-3.0 або CC BY-SA 3.0) | Завантажуються у вигляді готових даних, зберігаються лише на пристрої користувача; точний перелік джерел веде Ghostery |

Адреси відомих контрактів у SignGuard (`src/wallet-signguard.js`) складено вручну; назви сервісів належать їхнім власникам і використовуються лише для опису (nominative use). Приклад: реєстр [RevokeCash/whois](https://github.com/RevokeCash/whois) (MIT).

## Торгові марки

Назви Ethereum, Solana, MetaMask, Phantom, Ledger, Trezor, Uniswap, OpenSea та інші згадуються лише для опису сумісності й належать їхнім власникам. W3IR Browser не афілійований із ними й не схвалений ними. Solana-провайдер браузера з метою сумісності відкриває ознаку `isPhantom` і об'єкт `window.phantom.solana`, як це роблять інші сумісні гаманці: багато сайтів виявляють Solana-гаманець лише за ними. Це технічний інтерфейс, а не заява про афіліацію чи схвалення з боку Phantom; провайдер також позначений власною ознакою `isW3IR`. Помічник у браузері працює на локальній моделі (Ollama) і не є продуктом Microsoft, GitHub чи інших сторонніх компаній.

## Відмова від гарантій

Проєкт надається «як є», без гарантій і без відповідальності автора за використання іншими особами (див. [LICENSE](LICENSE)). Цей файл — не юридична консультація.

## Авторство

- Phishing.Database © Mitchell Krog, MIT.
- eth-phishing-detect © 2018 kumavis та учасники, DBAD.
- Polkadot-JS phishing © Polkadot-JS Authors, Apache-2.0.
