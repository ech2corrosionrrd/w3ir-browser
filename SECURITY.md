# Security Policy / Політика безпеки

[Українська версія нижче](#політика-безпеки-українською)

The W3IR project prioritizes the security and privacy of our users above all else. We welcome security researchers and community members who help us keep the browser and built-in Web3 wallet secure.

---

## Supported Versions

Only the latest release receives active security patches.

| Version | Supported | Notes |
|:---|:---:|:---|
| 1.42.x | :white_check_mark: | Current stable release |
| 1.41.x | :x: | Upgrade to 1.42.0 or newer |
| < 1.41 | :x: | End of life |

---

## Reporting a Vulnerability

**Please do NOT report security vulnerabilities via public GitHub Issues, Pull Requests, or social media.**

Use GitHub's **Private Vulnerability Reporting**:
1. Navigate to the [Security Advisories](https://github.com/ech2corrosionrrd/w3ir-browser/security/advisories) tab of this repository.
2. Click **"Report a vulnerability"** to open a confidential report directly with project maintainers.
3. Include:
   - Specific W3IR Browser version (`w3ir://settings` or title bar).
   - Detailed step-by-step reproduction instructions or a minimal Proof of Concept (PoC).
   - Threat assessment: impacted components, potential attacker capabilities, and user risk.
   - Any suggested remediations or patches.

### Response SLA & Timeline
- **Initial Acknowledgement**: Within 48 hours of receipt.
- **Triage & Assessment**: Within 5 business days.
- **Coordinated Disclosure**: We adhere to a 90-day coordinated disclosure policy, aiming to release patches much faster for critical issues.

---

## Scope

### In-Scope:
- **Web3 Wallet & Key Security**: Private key or seed phrase leakage, unauthorized transaction submission, bypass of confirmation dialogs (`wallet-signguard`), signature dissection bypass (SIWE, Permit, Permit2), Solana Stake Program drainer evasion, or prompt injection bypass in AI SignGuard.
- **Password Vault (`vault.js`)**: Cryptographic flaws in AES-256-GCM, DPAPI pepper handling, scrypt key derivation, or master password bypass.
- **IPC & Sandbox Isolation**: Sandbox escapes, renderer-to-main privilege escalation, unauthorized access to privileged `w3ir://` internal handlers.
- **Auto-Update Integrity**: Bypassing cryptographic Ed25519 signature checks in `updater.js` / `update-verify.js`.
- **Local AI & Prompt Injection**: Bypassing `injection-guard.js` or gaining host access via MCP/Ollama integrations.

### Out-of-Scope:
- Attacks requiring existing administrator or root malware execution on the local host machine.
- Known upstream Chromium vulnerabilities already tracked by the Chromium project.
- Social engineering of end users (e.g., convincing a user to manually export and share their mnemonic).
- Self-XSS or local DoS via opening arbitrarily huge local files.

---

## Safe Harbor

We consider security research conducted in good faith to be authorized. We will not pursue legal action against researchers who:
- Abide by this Security Policy and avoid privacy violations, data destruction, or disruption of services.
- Give maintainers reasonable time to remediate vulnerabilities before publicly disclosing technical details.
- Only interact with test accounts and contracts owned by the researcher.

---

## Recognition & Hall of Fame

Researchers who responsibly discover and report verified security vulnerabilities will be publicly acknowledged in the corresponding release notes, `CHANGELOG.md`, and GitHub Security Advisory credits (unless anonymity is requested).

---

# Політика безпеки (Українською)

Безпека та приватність користувачів є фундаментальними принципами проєкту W3IR Browser.

## Повідомлення про вразливості

**Не створюйте публічні обговорення (Issues) або Pull Requests для вразливостей.**

Скористайтеся конфіденційним приватним каналом GitHub:
1. Перейдіть на вкладку **Security → Report a vulnerability** у цьому репозиторії ([Security Advisories](https://github.com/ech2corrosionrrd/w3ir-browser/security/advisories)).
2. Вкажіть версію браузера (`w3ir://settings`), докладні кроки відтворення (PoC) та оцінку наслідків.
3. Проєкт гарантує первинну відповідь протягом **48 годин**.

## Межі уваги (Scope)
- **Гаманець Web3**: безпека приватних ключів і мнемоніки, підробка вікон підтвердження, обхід симуляції, анатомії підписів (`wallet-signguard`), захист від зловживань авторитетами Solana Stake Program та обхід AI SignGuard.
- **Сховище паролів (`vault.js`)**: цілісність шифрування AES-256-GCM, DPAPI, scrypt KDF.
- **Ізоляція та IPC**: обхід пісочниці, підвищення привілеїв через `w3ir://`, доступ недовірених сайтів до внутрішнього API.
- **Цілісність оновлень**: спроби підміни інсталяторів або обхід перевірки Ed25519.
- **Захист від ін'єкцій**: обхід `injection-guard` для несанкціонованого керування через локальний ШІ.

Детальний опис криптографії та моделі загроз дивіться в [docs/SECURITY.md](docs/SECURITY.md).
