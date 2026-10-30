# Випуск

## Передумови

- `gh auth status` — користувач `ech2corrosionrrd` авторизований; репозиторій релізів: `ech2corrosionrrd/w3ir-browser` (публічний, містить лише `README.md` і збірки).
- Ключі підпису оновлень: приватний ключ зберігається поза репозиторієм і збіркою; публічний — `src/update-key.js`. Створення: `npm run keygen` (наявні ключі не перезаписує). Заміна ключа зламає оновлення вже встановлених копій.
- Усі тести проходять (`docs/TESTING.md`).

## Випуск нової версії

0. Перед кожним випуском: `npm run pack && npm run net-audit:packaged` (у спокої нових з'єднань немає, на старті лише очікувані адреси; див. `docs/TESTING.md`), `npm run check:rpc` (усі вбудовані RPC гаманця мають відповідати своїм chainId), `npm audit --omit=dev` (має бути 0), `npm outdated electron` — оновлюйте Electron до останнього патча поточної гілки (виправлення Chromium і пісочниці), потім повний прогін тестів.
1. Змініть `version` у `package.json` (семантичне версіонування). Оновіть `CHANGELOG.md`, довідку (`pages/help-data.js`) і README за потреби.
2. `npm run release` — збирає (`electron-builder --win`: NSIS + portable) і підписує: `build/release.js` звіряє SHA-512 інсталятора з `latest.yml`, додає `w3irSignature` і `w3irKeyId`, перевіряє підпис вбудованим публічним ключем і кладе файли в `dist/release/` (`latest.yml`, `W3IR-Browser-Setup-X.exe`, `….blockmap`, `W3IR-Browser-X-portable.exe`).
3. Публікація: `npm run release:github -- ech2corrosionrrd/w3ir-browser` (`build/publish-github.js`):
   1. чернетка релізу + вивантаження інсталятора, blockmap, portable;
   2. `latest.yml` останнім;
   3. перевірка наявності й розмірів усіх файлів;
   4. публікація;
   5. звірка публічного `latest.yml` із локальним (при невдачі реліз повертається в чернетку);
   6. очікування, поки GitHub почне віддавати реліз як «останній» (кеш `releases/latest` триває кілька хвилин — клієнти бачать нову версію лише після цього).
   Уже існуючий тег **не перезаписується**; виправлення = нова версія.
4. winget (після схвалення першого пакета, PR [#454063](https://github.com/microsoft/winget-pkgs/pull/454063): CLA підписано 2026-10-17, чекає модератора): `npm run winget:submit` — маніфести схеми 1.12.0, форк `microsoft/winget-pkgs`, гілка, PR. Один PR на версію; не відкривайте другий, поки не схвалено попередній.
4a. Scoop і Chocolatey (після публікації релізу на GitHub; маніфест Scoop слід оновлювати щоразу, інакше він відстає від випуску; перед комітом звіряйте `hash` з `digest` портативного активу: `gh api repos/<repo>/releases/tags/v<версія> --jq '.assets[] | select(.name|test("portable")) | .digest'`): `npm run packages` бере файли з `dist/release` і створює `bucket/w3ir-browser.json` (його комітять у репозиторій: користувачі додають його як bucket `scoop bucket add w3ir https://github.com/ech2corrosionrrd/w3ir-browser`, далі `scoop install w3ir-browser`) та `dist/packages/chocolatey`; `npm run packages -- --pack` збирає `.nupkg`. Хеші беруться з локальних файлів, тому запускайте **після** остаточної збірки, яку ви опублікували, і не перебудовуйте її. Публікація в Chocolatey Community (`choco push` з API-ключем акаунта) і її модерація — вручну власником. Пушити кожну версію не обов’язково: користувачі `choco upgrade` бачать нове лише після пушу, а встановлені з інсталятора оновлюються через `latest.yml` незалежно від Chocolatey; не тримайте в черзі модерації кілька версій одночасно — пушіть найновішу. Для пре-релізів скрипт відмовляє.
5. Примітка: `publish.url` у `package.json` (`https://invalid.invalid/`) — свідома заглушка: `electron-builder` вимагає секцію `publish` для `latest.yml`, а справжнє джерело оновлень (`github:ech2corrosionrrd/w3ir-browser`) задається в коді; заглушка не дає опублікувати не туди.
6. Після випуску й оновлення встановленої копії: прогнати `test/installed-cdp.js` (див. `docs/TESTING.md`) і переглянути `updater.log`. Перша збірка після зміни зображень інсталятора (`build/installerSidebar.bmp`, `installerHeader.bmp`) може показати помилку NSIS ще до публікації — виправляється перегенерацією `npm run icon`.

## Бета-випуск

1. Встановіть у `package.json` версію з суфіксом, наприклад `1.41.0-beta.1`, і виконайте `npm run release:github -- ech2corrosionrrd/w3ir-browser`: скрипт сам позначить реліз як пре-реліз GitHub (`prerelease`), тому стабільні клієнти його не бачать, а `releases/latest` не змінюється.
2. Клієнти з увімкненим «Отримувати бета-версії» (Налаштування → Оновлення) знайдуть його за звичайною перевіркою; підпис випускача перевіряється так само, як для стабільних.
3. `npm run winget:submit` для пре-релізу відмовляє: у winget потрапляють лише стабільні версії. Стабільний випуск — наступна версія без суфікса (`1.41.0`).

## Як клієнти оновлюються

`electron-updater` + власний `Updater` (`src/updater.js`): перевірка за 20 с після запуску й кожні 6 год, джерело `github:ech2corrosionrrd/w3ir-browser` (можна змінити в налаштуваннях), диференційне завантаження за blockmap, перевірка підпису Ed25519 двічі, кнопка ⬆ / пункт меню / кнопка в налаштуваннях → підтвердження → `quitAndInstall(true, true)` (тихий інсталятор `--updated /S --force-run`, 15–30 с, без вікон). Перед закриттям записується `update-attempt.json` і показується сповіщення Windows; після запуску нова версія показує «Браузер оновлено до X», а при збої пропонує відкрити інсталятор вручну (лише з дійсним підписом). Журнал: `%APPDATA%\W3IR Browser\updater.log`. Портативна версія автоматично не оновлюється.

## Пастки

- Тимчасові скрипти-патчі з українськими рядками, апострофами й зворотними скісними рисками надійніше писати інструментом Write у файл (Python/JS) і запускати, ніж через heredoc у Bash: heredoc з'їдає `\`, а апострофи ламають виклик.
- Повний `npm test` запускається у справжньому вікні Electron (потрібен робочий стіл). Область можна запустити окремо: `W3IR_ONLY=agentTests W3IR_USER_DATA=<тека> W3IR_SMOKE=security npx electron .`.
- `electron`, `electron-builder` і `ethers` закріплені без `^` (оновлюйте свідомо: Dependabot або `npm install --save-exact <пакет>@<версія>`, потім повний прогін тестів).
- `build/release.js` бере `portable` лише поточної версії (раніше вибирався найстаріший файл у `dist/`).
- Публічні RPC (Solana, Ethereum) обмежують частоту й блокують важкі методи: для звірок на живій мережі використовуйте `build/mainnet-sim-check.js` (повторює спроби).

- `build/installer.nsh` підхоплюється **будь-якою** збіркою з цієї теки (навіть без `nsis.include`). Тестові збірки з іншим `appId` усе одно запишуть/видалять ключі реєстру `W3IRBrowser` встановленого браузера — для експериментів копіюйте макрос із іншими назвами (`W3IRSandbox`) і вимикайте/заміняйте `nsis.include`.
- Після `winget validate` у тому ж процесі Node наступні `child_process` падають (libuv `AssignProcessToJobObject`) — `build/winget.js` запускає перевірку в окремому дочірньому процесі.
- Не запускайте тестові копії браузера без `--user-data-dir` (або `W3IR_USER_DATA` у dev): вони поділять дані й блокування з установленим браузером.
- Не закривайте процес `W3IR Browser.exe` користувача: це його справжній браузер.
- Реліз GitHub видно як «останній» не одразу; перевіряйте оновлення через кілька хвилин.

## Підпис сертифікатом Windows

Поки не зроблено (див. [ROADMAP.md](ROADMAP.md)): варіанти — SignPath Foundation (безкоштовно для відкритого коду), сертифікат від ЦС (Certum тощо), Azure Artifact Signing (обмежена доступність). Власний підпис оновлень лишається незалежно від сертифіката.

### Збірка на GitHub Actions (підготовка до підпису SignPath)

SignPath Foundation підписує лише збірки з CI. Workflow `.github/workflows/build.yml` («Build», запуск вручну чи за тегом `v*`) збирає інсталятор і портативну версію на сервері GitHub й зберігає їх артефактом `dist` разом із `SHA256SUMS.txt`. Підпис оновлення (ключем власника) і публікація лишаються на комп'ютері власника:

1. `git push` закоміченого коду, `gh workflow run build.yml --repo ech2corrosionrrd/w3ir-browser`, дочекатися успіху.
2. `npm run release:ci` — бере артефакт саме для поточного коміту (інакше відмовляє), перевіряє контрольні суми, підписує `latest.yml` і публікує Release.

Після схвалення заявки в workflow додається крок підпису коду через SignPath (організація й токен — у секретах репозиторію; деталі видає SignPath). Локальний `npm run release:github` працює як раніше.

## Хибне спрацювання Windows Defender / SmartScreen: подача в Microsoft (WDSI)

Коли це потрібно: Windows Security (Defender) позначає інсталятор чи файл браузера як шкідливий або користувачі повідомляють про блокування. Подача **не замінює підпис Authenticode**: SmartScreen будує репутацію за підписом і кількістю завантажень, а WDSI лише розглядає конкретне хибне спрацювання. Заздалегідь відправляти «чисті» збірки немає сенсу: форма вимагає назви виявлення (detection name).

Що відомо про форму (https://www.microsoft.com/wdsi/filesubmission, перевірено 2026-10-25):
- тип подачі «Software developer» (розробник програмного забезпечення);
- обов'язкові поля: продукт Microsoft, яким перевірено файл (є Microsoft Defender Antivirus і Microsoft Defender SmartScreen), назва компанії, кількість уражених пристроїв, файл, назва виявлення, додаткова інформація;
- **файл не більше 50 МБ**, пусті файли відхиляються, архіви ZIP/RAR із паролем `infected`; інсталятори з багатьма файлами можуть отримати нижчий пріоритет;
- класифікація «Incorrectly detected as malware/malicious»; пріоритет Medium (зазвичай кілька днів), High лише для надзвичайних випадків;
- вхід в обліковий запис Microsoft не обов'язковий, але дає змогу бачити статус подачі.

**Обмеження для нас:** інсталятор і портативна збірка мають близько 115 МБ (понад 50 МБ), тому подати їх цілком не вдасться. Дізнайтеся в «Захист від вірусів і загроз» → «Журнал захисту», **який саме файл** позначено (шлях і назва виявлення), і подавайте лише його, якщо він менший за 50 МБ. Якщо позначено лише великий інсталятор, подати його через цю форму неможливо (поле файлу обов'язкове): тоді лишається знижувати кількість хибних спрацювань підписом Authenticode й, за потреби, звертатися за допомогою на Microsoft Q&A.

Порядок дій:
1. Зафіксуйте виявлення: назва (наприклад, `Trojan:Win32/…`), точний шлях файлу, версія антивірусних визначень, SHA-256 (береться з `SHA256SUMS.txt` релізу або `Get-FileHash`).
2. Відкрийте форму, оберіть **Software developer**, продукт, яким бачили виявлення, укажіть компанію (W3IR) і кількість пристроїв.
3. Додайте файл (≤ 50 МБ), укажіть назву виявлення, класифікацію **Incorrectly detected as malware/malicious**, пріоритет **Medium**.
4. У «Additional information» вставте текст нижче, підставивши версію, хеш і назву виявлення.
5. Увійдіть під тим самим акаунтом Microsoft, щоб стежити за статусом; повторіть подачу для кожного нового хешу (нова збірка = новий файл).

Текст для «Additional information» (англійською, як вимагає форма):

```
W3IR Browser is an open-source (MIT) Windows browser built on Electron/Chromium. Source: https://github.com/ech2corrosionrrd/w3ir-browser
Release: https://github.com/ech2corrosionrrd/w3ir-browser/releases/tag/v<VERSION>
File: <FILE NAME>, SHA-256 <HASH> (matches SHA256SUMS.txt and the release asset digest).
Detected as: <DETECTION NAME> by <PRODUCT> (definitions <VERSION>).
This is a false positive: the build is made from the public repository, SHA-256 checksums are published with every release, the application contains no telemetry, and the executables are not packed with executable packers. Auto-updates are signed with an Ed25519 key and verified before install.
Please re-analyse and remove the detection.
```

Після позитивного рішення Microsoft оновлює антивірусні визначення, і виявлення знімається в Defender у користувачів (терміни різні). Якщо виявлення повторюються для нових збірок, головним рішенням лишається підпис Authenticode (див. вище).

Джерела: [форма подачі WDSI](https://www.microsoft.com/wdsi/filesubmission).
