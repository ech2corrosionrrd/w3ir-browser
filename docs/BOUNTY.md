# W3IR Browser: Responsible Disclosure & Recognition

**Status:** Open for reports, best effort
**Contact:** GitHub Private Vulnerability Reporting / Security Advisory
**Rewards:** No monetary rewards. Recognition only (Hall of Fame).

W3IR Browser is a personal project maintained by one person for their own needs and published as open source. It is provided **"as is", without warranty or liability** (see [LICENSE](../LICENSE)). Using it, including the built-in wallet, is at your own risk. The project has had **no independent security audit**.

---

## 1. What to Expect

If you find a vulnerability, a private report is welcome and helps everyone who uses the code.

- Reports are read and handled on a **best-effort basis**; there is no guaranteed response time and no service-level commitment.
- Fixes are released when the maintainer can verify them; there is no guaranteed schedule.
- **No payment is offered or implied** for any report, and no bug bounty is operated. Any older mention of rewards is withdrawn.
- Credit is given in the release notes, `CHANGELOG.md` and the GitHub Security Advisory unless you ask to stay anonymous.

---

## 2. Scope & Target Components

Reports are most useful for these components:

| Component | Files | Description |
|---|---|---|
| **Cryptographic Vault** | `src/vault.js`, `src/crypto-util.js` | Key derivation, encryption, DPAPI pepper, memory zeroing. |
| **Native Wallet Logic** | `src/wallet.js`, `src/wallet-evm-core.js`, `src/wallet-solana*.js` | Signing logic, private key isolation, replay attacks, staking authority changes. |
| **SignGuard & Threat Intelligence** | `src/wallet-signguard.js`, `src/threats.js` | Bypass of drainer detection. |
| **Electron IPC & Isolation** | `src/ipc.js`, `main.js`, `preload.js`, `page-preload.js` | Context isolation escapes, unauthorized IPC, privilege escalation. |
| **Updater Verification** | `src/update-verify.js`, `src/update-key.js` | Signature tampering, downgrade attacks, integrity verification. |
| **Navigation & Local Access** | `src/app-window.js`, `src/protection.js` | Origin check bypass, `file:///` or internal `w3ir://` access from remote content. |

Out of scope: denial of service against local Ollama or third-party RPC limits, social engineering, physical access, unreleased branches, and upstream Chromium/Electron issues already public.

---

## 3. Testing Rules

- Test only against your own accounts, wallets and devices. For transactions use test networks (Sepolia, Solana devnet) or your own funds in minimal amounts.
- Do not access, modify or destroy data belonging to other users.
- No denial-of-service, social engineering, phishing of users or maintainers, or physical attacks.
- Do not disclose details before the fix is released or 90 days have passed, whichever comes first by agreement.

## 4. Not Considered Vulnerabilities

- Missing headers or flags with no practical impact.
- Issues that require an already compromised device or administrator rights.
- Automated scanner output without a working proof of concept.
- Vulnerabilities in third-party dependencies without a demonstrated impact on W3IR.

## 5. How to Submit

1. Open `https://github.com/ech2corrosionrrd/w3ir-browser/security/advisories/new`.
2. Provide a clear proof of concept with step-by-step reproduction.
3. Please allow reasonable time (we suggest up to 90 days) before any public disclosure.

## 6. No Responsibility for Third Parties

The maintainer is not responsible for how others use, modify or redistribute this software, for losses caused by its use, or for third-party builds. Only binaries published in this repository's GitHub Releases are official.
