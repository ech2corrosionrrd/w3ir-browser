<p align="center"><img src="build/brand/icon-512.png" width="112" alt="W3IR Browser"></p>

# W3IR Browser

[Українська версія](docs/README-uk.md)

A privacy-focused, Web3-native desktop browser for Windows built on Chromium (Electron 44). Engineered with built-in multichain wallet security, local AI assistance, decentralized storage (Arweave), and document viewing tools. Operates entirely locally with **zero telemetry** and no developer server dependencies.

- Latest release and downloads: <https://github.com/ech2corrosionrrd/w3ir-browser/releases/latest>
- Supported Languages: English, Ukrainian, Polish, German, Spanish, French (switchable in settings) · Platform: Windows 10/11 x64
- Built-in Browser Help: **F1**

## Key Features

| Area | Features |
|---|---|
| **Tabs** | Pinned tabs (distinct pill design, hover close), sleeping tabs (memory saver with configurable timeout & form-input protection), vertical tab layout, **colored tab groups** ("close others in group"), **tear-off tab to new window** (drag outside tab bar), session & closed tab restore, split-screen persistence, **Tab Stash** (Ctrl+Shift+S sets all unpinned tabs aside into a saved set and restores them later; not available in private windows), **Glance** (Alt+click or context menu: quick link preview in a sandboxed floating window with no wallet bridge; Esc closes, Ctrl+Enter moves it to a tab); stashed sets are listed on the new tab page (restore all, open a single tab, delete) |
| **Start Page** | Status bar (protection stats, update status, active/sleeping tabs, wallet state, downloads, Arweave/Irys Web3 gateway pill), quick launch tiles, top sites, recent bookmarks, tips, and keyboard shortcut cheatsheet |
| **Navigation** | Smart address bar with autocomplete (bookmarks, frecency history), custom search keywords (`gh owner/repo`, `npm …`), command palette **Ctrl+K**, tab search Ctrl+Shift+A, clean Reader Mode, `ipfs://` and `ipns://` through a fixed list of public gateways, context-menu AI actions on selected text (explain / translate / TL;DR via local Ollama), explorer keywords `eth` (Etherscan) and `sol` (Solscan) |
| **Privacy & Protection** | **W3IR Shield Privacy Center** (quick toolbar popover with live blocked tracker count, 3rd-party cookie status, anti-fingerprinting indicator, WebRTC leak defense, tracking stripper), 3-tier protection modes ("Standard / Strict / Maximum" controlling 3rd-party cookies, WebRTC IP leakage, and Referer headers), **Anti-Fingerprinting** (screen dimension rounding to 100 px, `hardwareConcurrency`/`deviceMemory` normalization, Canvas `getImageData`/`toDataURL`/`toBlob` LSB noise injection, per-site shield exceptions), ad & tracker blocking via EasyList/EasyPrivacy/uBlock rules with cosmetic filters, **cookie-banner hiding** (uBlock "annoyances" lists, one-click toggle, hot-swapped without restart), HTTPS-first, tracking parameter stripper, DNT/GPC, incognito mode, **Site Information panel** (granular permissions, per-site adblock exceptions, site data clearing), per-site **No-JS** (adds `script-src 'none'` next to the site's own policy) and **third-party frame** switches in the Shield, per-site **dark appearance**, audio and WebGL fingerprint hardening (Strict / Maximum) |
| **Threat Protection** | Local threat databases from URLhaus + Phishing.Database + MetaMask eth-phishing-detect (~500k domains including Web3 phishing) with binary search heuristics (homoglyphs, brand spoofing, lookalikes) |
| **Password Manager & 2FA** | Encrypted local vault (AES-256-GCM, scrypt KDF with DPAPI pepper), **built-in 2FA / TOTP authenticator** (RFC 6238 / RFC 4226 with `otpauth://` URI support, live countdown, and 20s clipboard auto-clear), login reuse security audit bar, strict exact-origin autofill triggered only by user action, password generator, backup/restore, CSV import |
| **Web3 Wallet** | Native **EVM** (EIP-1193 / EIP-6963, modular `wallet-evm-core`) and **Solana** (`window.solana`, `wallet-standard`) wallet. **Security:** trusted native overlay confirmation for every action, signature dissection (**SIWE**, **permit/Permit2**, Seaport orders), **AI SignGuard** (local offline Ollama explanation of transactions and contract calls before signing), transaction **simulation** (pre-execution balance changes for EVM and Solana), **Solana Stake Program drainer protection** (identifies unauthorized Withdrawer authority shifts and malicious SOL draining), address poisoning & clipboard hijacking defense, rejection of batch calls and EIP-7702 delegation, caution policies (USD transfer limits, contacts-only mode, site auto-disconnect). **Features:** **Solana Staking** (view stake accounts, choose validators, delegate, deactivate, and withdraw SOL), token transfers (ERC-20, SPL), **NFT gallery** (ERC-721/1155, Metaplex) with lazy loading and Arweave-first storage, active allowance management & revoking, cross-chain USD portfolio, **EVM history** (token/NFT transfers with spam-token collapsing & CSV export), `.sol` SNS domain resolution, compute budget priority fees, address book, ENS, QR code generator, private key import, BIP39 passphrase & Ledger Live/MetaMask derivation paths, watch-only accounts, per-site active account assignment, encrypted backup. *Note: code has not yet undergone an independent third-party audit.*. Also: `window.arweaveWallet` (ArConnect/Wander API: connect, address, public key, data signing with a full preview; transaction signing is not supported), experimental **Ledger** support for EVM accounts over WebHID, Solana priority fee that follows network congestion. Policy limits also cover `transferFrom`, SPL transfers from sites and the sum of a whole Solana transaction; Solana confirmations show token changes from the simulation and warn about hidden token drains; external RPC hostnames must resolve to public addresses |
| **History & Bookmarks** | Embedded SQLite (`places.sqlite`, WAL mode): FTS5 full-text search suggestions, **frecency** ranking (frequency × exponential decay), seamless one-time migration from legacy JSON |
| **Sync** | Folder-based sync (OneDrive, Dropbox, Syncthing) with client-side end-to-end encryption |
| **Profiles** | Multiple isolated profiles with separate cookies, bookmarks, history, passwords, and settings |
| **Data Import** | One-click import of bookmarks and history from Chrome, Edge, Brave, Vivaldi, Opera, Arc, other Chromium forks, and Firefox with its forks (LibreWolf, Waterfox, Floorp, Zen); passwords via CSV |
| **GitHub Integration** | Notification and pull request review indicators (🐙), repository navigation via Ctrl+K, search shortcuts (`gh`, `ghi`, `ghp`, `gha`, `ghc`) |
| **Split Screen** | Side-by-side view of two tabs in a single window with draggable divider and session restoration |
| **Browser Dashboard** | Real-time diagnostics at `w3ir://dashboard`: live CPU & memory sparklines, tab breakdown, session protection counters, process memory distribution, heavy tab detection, RPC ping latency, AI control, audit log, profile storage card (cache and site-data sizes, "Clear cache") |
| **Local AI Assistant** | In-browser assistant at `w3ir://assistant` powered by local Ollama models (100% on-device, no data sent externally), protected by multi-language prompt injection sanitization (`injection-guard`) |
| **AI Agent Control (MCP)** | Built-in local Model Context Protocol (MCP) server for Claude Code: executes inside isolated temporary sessions with per-domain explicit user confirmation; optional read/control sharing for active user tabs; strictly excludes passwords, credentials, and wallet access; the agent refuses to submit a form that already contains a filled password, card or one-time-code field |
| **Documents & Code** | Secure built-in document viewer at `w3ir://doc`: **Markdown** (rendered headers, lists, tables, syntax-highlighted code, Ctrl+P print & "Save to PDF"), **CSV/TSV** (RFC 4180 parsing, column filtering, numeric sorting), **JSON** (collapsible interactive tree), **source code/text** (syntax support for 20+ languages with line numbers, zero external libraries) |
| **PDF Tools** | Chromium PDF viewer in tabs (search, annotations, form filling, print); internal toolkit at `w3ir://pdftools` for PDF merging, page extraction/splitting, page rotation, image stamp signatures, and metadata removal — running in an isolated worker thread |
| **Design** | Obsidian-inspired aesthetic (deep indigo, neon accents, frosted glass; dark/light/system theme), branded new tab page, adaptive responsive layout |
| **Updates** | Automatic updates signed with an Ed25519 publisher key, differential delta downloads, full verification |

## Installation & Updates

1. Download `W3IR-Browser-Setup-*.exe` from [GitHub Releases](https://github.com/ech2corrosionrrd/w3ir-browser/releases/latest) (includes auto-updater) or the standalone `W3IR-Browser-*-portable.exe`.
2. Windows SmartScreen may display an unknown publisher notice — code signing certificate acquisition is currently in progress (see [Code Signing Policy](#code-signing-policy) and [Roadmap](docs/ROADMAP.md)).
3. Automatic updates: Checked every 6 hours, or manually via Settings → "Browser Updates" → "Check for Updates".
4. Windows Package Managers:
   - **Winget**: `winget install W3IR.Browser` (pending Microsoft repository approval: PR [#454063](https://github.com/microsoft/winget-pkgs/pull/454063)).
   - **Scoop**:
     ```powershell
     scoop bucket add w3ir https://github.com/ech2corrosionrrd/w3ir-browser
     scoop install w3ir-browser
     ```
   - **Chocolatey**: a community package has been submitted and is awaiting moderation (not installable yet). **Scoop**: manifest in `bucket/w3ir-browser.json`.

### Verifying Build Provenance (Attestations)

Every release built via GitHub Actions includes cryptographic OpenSSF provenance attestations. You can verify that your installer was built unmodified directly from this repository using the GitHub CLI:

```bash
gh attestation verify W3IR-Browser-Setup-<version>.exe --repo ech2corrosionrrd/w3ir-browser
```

Checksums are also available in `SHA256SUMS.txt` accompanying every release.

## User Data Architecture

- Installed location: `%APPDATA%\W3IR Browser` (development mode: `%APPDATA%\w3ir-browser`); secondary profiles stored in `profiles\<id>`.
- Core files: `settings.json`, `places.sqlite` (SQLite WAL), `session.json`, `permissions.json`, `downloads.json`, `window.json`, `vault.bin` + `vault.pepper` (encrypted credentials & wallet keys), `sync.json`, `threats-*.bin`, `adblock-engine.bin`, `updater.log`.

## Development

```bash
npm install
npm start                      # Run from source
npm test                       # Run full end-to-end Electron test suite (1,300+ checks)
npm run test:unit              # Fast headless unit tests (140+ checks, node:test)
npm run test:coverage          # Native V8 test coverage (>= 98% on wallet safety & crypto)
npm run lint                   # ESLint static analysis (0 errors, 0 warnings required)
npm run perf                   # Performance and memory benchmark suite
npm run dist                   # Build installer and portable binary into dist/
npm run release:github -- ech2corrosionrrd/w3ir-browser  # Sign release and draft on GitHub
```

### Technical Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Process model, IPC policy table, and data flow
- [docs/SECURITY.md](docs/SECURITY.md) — Threat model, cryptographic primitives, and sandboxing
- [docs/TESTING.md](docs/TESTING.md) — Unit and integration test architecture
- [docs/RELEASING.md](docs/RELEASING.md) — Release packaging, signing, and distribution
- [docs/PLAN.md](docs/PLAN.md) — Multi-stage strategic development plan
- [docs/ROADMAP.md](docs/ROADMAP.md) — Project status, milestones, and pending items
- [docs/AI-MCP.md](docs/AI-MCP.md) — Claude Code MCP integration guide
- [docs/I18N.md](docs/I18N.md) — Localization architecture (6 languages)
- [CHANGELOG.md](CHANGELOG.md) — Full release history

## Code Signing Policy & Privacy

Code signing via Authenticode is being established. Integrity is currently verified via Ed25519 updater signatures, SHA-256 checksums, and GitHub Sigstore provenance attestations.

- **Scope:** Only binaries compiled from this repository are signed.
- **Privacy Guarantee:** W3IR Browser **does not collect, track, or transmit any telemetry, usage metrics, or browsing data**. Network requests initiated by the browser are strictly limited to user-configured actions: checking GitHub Releases for updates, downloading public threat blocklists, and querying public blockchain RPC endpoints (which can be customized or disabled in settings).

## Disclaimer

W3IR Browser is a personal project created for the author's own needs and shared as open source. It is provided **"as is", without warranty of any kind**, and the author accepts no responsibility for how it is used by others or for any loss, including loss of funds held in the built-in wallet. The code has had no independent security audit. Use it at your own risk; only binaries from this repository's GitHub Releases are official.

## License

Licensed under the [MIT License](LICENSE). Vulnerabilities should be reported responsibly according to [SECURITY.md](SECURITY.md). Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
