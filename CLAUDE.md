# W3IR Browser: правила роботи для ШІ-агентів

Браузер для Windows на Electron. Мова документації, коментарів і інтерфейсу — українська (переклади: `docs/I18N.md`).

## Перед комітом

- CI виконується **локально** (хвилини GitHub Actions обмежені): `npm run ci` (повний, з автотестом Electron) або `npm run ci -- --quick` (без нього). Склад: lint, unit-тести, переклади, `npm audit`, пошук секретів і `npm test`. На GitHub автоматично (push у `main`, pull_request) йдуть лише `check` і `unit-cross` на Linux; повний e2e (Windows) і macOS — лише вручну (`workflow_dispatch`).
- `npm run lint` і `npm test` (повний автотест у вікні Electron; окремі області — `W3IR_ONLY`, див. `docs/TESTING.md`).
- Нові рядки інтерфейсу пишіть українською цілим реченням і додавайте переклади в усі каталоги `locales/*.json` (`node build/i18n-extract.js --check`).
- Тимчасові скрипти-патчі з українськими рядками й зворотними скісними рисками створюйте файлом, а не heredoc.

## Що не потрапляє в публічний репозиторій

Код відкритий, але в репозиторій не додаються відомості, що впливають на безпеку: відомі невиправлені слабкості, карти аудиту, поводження з ключами підпису, способи вимкнути захисти. Такі матеріали зберігаються поза репозиторієм.

## Agent skills

### Issue tracker

Issues live in GitHub Issues of `ech2corrosionrrd/w3ir-browser` (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root (created lazily). See `docs/agents/domain.md`.
