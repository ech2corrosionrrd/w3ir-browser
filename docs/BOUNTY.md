# W3IR Browser — Bug Bounty Policy

**Status:** Active, within the available quarterly budget  
**Program Contact:** GitHub Private Vulnerability Reporting / Security Advisory  
**Primary Target:** Native Web3 Wallet, Cryptographic Key Vault, Context Isolation, IPC Security, and Updater Verification.

---

## 1. Overview & Commitment

W3IR Browser takes security as a core architectural discipline. While we prepare for formal third-party audits (Issue #8), we actively encourage responsible security researchers to inspect our codebase and report any vulnerabilities or architectural oversights.

We commit to:
- Acknowledge your submission within **48 hours**.
- Provide transparent triage and status updates within **5 business days**.
- Not pursue legal action against researchers who adhere to our Safe Harbor guidelines.

---

## 2. Scope & Target Components

### In-Scope (High Priority)
| Component | Files | Description |
|---|---|---|
| **Cryptographic Vault** | `src/vault.js`, `src/crypto-util.js` | Scrypt key derivation, AES-256-GCM encryption, DPAPI pepper integrity, memory zeroing. |
| **Native Wallet Logic** | `src/wallet.js`, `src/wallet-evm-core.js`, `src/wallet-solana*.js` | Signing logic, private key isolation, replay attacks, Solana staking authority changes. |
| **SignGuard & Threat Intelligence** | `src/wallet-signguard.js`, `src/threats.js` | Bypass of drainer detection (Permit, Seaport, EIP-7702, Stake Authority modifications). |
| **Electron IPC & Isolation** | `src/ipc.js`, `main.js`, `preload.js`, `page-preload.js` | Context isolation escapes, unauthorized IPC invokation, privilege escalation from renderer to main process. |
| **Updater Verification** | `src/update-verify.js`, `src/update-key.js` | Ed25519 signature tampering, downgrade attacks, SHA-256 integrity verification. |
| **Navigation & Local Access** | `src/app-window.js`, `src/protection.js` | Bypassing origin checks, unauthorized `file:///` or internal `w3ir://` protocol access from remote web content. |

### Out-of-Scope
- Denial of Service (DoS) attacks targeting local Ollama or third-party RPC rate limits.
- Social engineering or physical attacks requiring physical device access.
- Issues in unreleased branches or draft PRs.
- Vulnerabilities in Chromium/Electron that are already publicly disclosed upstream and pending release in our dependencies.

---

## 3. Reward Tiers

We offer recognition in our security Hall of Fame (release notes & `SECURITY.md`) and direct bounty rewards (USDC / SOL / ETH) for qualified, reproducible findings:

| Severity | CVSS v3.1 | Reward (Indicative) |
|---|---|---|
| **Critical** (Key extraction, Remote Code Execution, Vault decryption) | 9.0 - 10.0 | **$500 – $1,000 USD** |
| **High** (Signature bypass, Drainer bypass, Unauthorized transaction approval) | 7.0 - 8.9 | **$250 – $500 USD** |
| **Medium** (Origin spoofing, Local File Inclusion to unprivileged files) | 4.0 - 6.9 | **$100 – $250 USD** |
| **Low** (Informational hardening, theoretical edge cases) | 0.1 - 3.9 | **Hall of Fame Attribution** |

---

## 4. Testing Rules

- Test only against your own accounts, wallets and devices. For transactions use test networks (Sepolia, Solana devnet) or your own funds in minimal amounts.
- Do not access, modify or destroy data belonging to other users.
- No denial-of-service, social engineering, phishing of users or maintainers, or physical attacks.
- Do not disclose details before the fix is released or 90 days have passed, whichever comes first by agreement.

## 5. Payout Terms

- A reward is paid only for the first complete report of a vulnerability within scope. Duplicates receive Hall of Fame attribution.
- Severity is determined by the project team using CVSS v3.1 together with real-world impact. The amounts in the table are indicative, not guaranteed.
- Payment is made in USDC, SOL or ETH after the fix is released. You provide the wallet address; we do not collect identity documents.
- You are responsible for any taxes in your own jurisdiction.
- The program may be changed or suspended at any time; reports already submitted are handled under the terms in force on the submission date.

### Not Considered Vulnerabilities
- Missing headers or flags with no practical impact.
- Issues that require an already compromised device or administrator rights.
- Automated scanner output without a working PoC.
- Vulnerabilities in third-party dependencies without a demonstrated impact on W3IR.

## 6. Handling Process

1. Receipt through a private GitHub Security Advisory; first response within 48 hours.
2. Confirmation and severity assessment within 5 business days.
3. Fix in a private branch, patch release, then publication of the Advisory with credit.
4. Payment within 14 days after the patch is published.

---

## 7. How to Submit

1. Navigate to the GitHub repository: `https://github.com/ech2corrosionrrd/w3ir-browser/security/advisories/new`
2. Provide a clear Proof-of-Concept (PoC) with step-by-step reproduction instructions.
3. Allow up to 90 days for remediation before any public disclosure (Responsible Disclosure).
