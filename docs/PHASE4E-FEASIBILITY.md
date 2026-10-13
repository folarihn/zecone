# Phase 4E feasibility and pre-change audit

2026-10-13. Parent checkpoint `324a677`; working tree was clean. All six Phase 4D reports, extension, popup, API/session boundary, signing policy and browser harness were reviewed before product changes. [Preservation manifest](phase4e-evidence/preservation.json) hashes the earlier tracked documentation/evidence and Cargo pins. No key migration, new payment or settlement is needed.

Fresh baseline: **207 passing tests** (139 Node/Anvil, 52 Solidity, four Rust, 12 browser), plus both TypeScript checks. Logs are in `phase4e-evidence/baseline-*.txt`. Forge reports a sandbox signature-cache write warning; all contract tests passed. The previous browser test injects source into a fixture: it does not install an extension.

## Browser feasibility

[Playwright's official extension guide](https://playwright.dev/docs/chrome-extensions), checked today, requires a persistent Chromium context and recommends its bundled Chromium because branded Chrome/Edge removed command-line extension sideloading. Use the pinned Playwright 1.64.0 and its matching downloaded browser in ignored `.state/playwright-browsers`, with a dedicated ignored profile. Manual Chrome installation remains the normal Load unpacked flow. Never touch the user's normal profile. No automation detection evasion or disabled browser origin protections.

[OpenSea's wallet guide](https://support.opensea.io/en/articles/8867089-what-crypto-wallets-can-i-use-with-opensea) describes EIP-6963 discovery. Actual discovery, login methods, popup compatibility and unsupported testnet behavior must be observed on the real site. Documentation and local fixture success cannot establish that result. The site previously displayed connection terms; acceptance will be requested at that concrete step if necessary.

## Chosen architecture

Keep the established local signer authority: the wallet popup binds the actual browser opener/source/origin, uses the HttpOnly local session and CSRF token, and requires visible approval. Do not give the extension direct HTTP signing access or duplicate a wallet credential. Add a MAIN-world EIP-6963 facade, an ISOLATED content transport owning the local popup reference, and a Manifest V3 worker that checks browser-provided runtime sender origin/frame/document and correlates bounded pending requests. Responses reach the worker only through the isolated script after exact local-wallet source/origin/channel verification. No page-supplied origin or approval flag is authoritative.

The extension action shows transport status and opens the local wallet for signing/permission management. Signing controls remain in the authenticated local popup. The worker carries no keys, Zcash data or API token. Disconnect, navigation, worker loss and browser restart fail closed; saved origin permissions still require a fresh locally authenticated transport. No automatic resubmission of a signing request.

[Chrome messaging guidance](https://developer.chrome.com/docs/extensions/develop/concepts/messaging) treats content data as untrusted. The MAIN world is also inherently controlled by the website: a compromised page can replace its own provider or fabricate its own display. It cannot thereby produce a local signature, approve a request or read wallet secrets. This distinction must remain explicit in the security report.

Production injection stays limited to the two exact OpenSea HTTPS origins, top frame only. Independent local-site tests use a clearly identified fixture manifest/allowlist; actual OpenSea tests use the unmodified production package. The original direct-popup provider and regression tests remain as a legacy transport fixture, no longer injected by the new manifest.

## Dependencies and constraints

Keep Node 24.12.x, Playwright 1.64.0, viem 2.57.4, Next 16.4.0, React 19.3.0 and every lockfile/Cargo NU7 pin. Use the existing locally controlled EVM test account and separate settlement wallet unchanged. Zcash Testnet/lightwalletd `https://testnet.zec.rocks:443` is unchanged. No new credentials, funds or external RPC are required for extension discovery; existing local pairing is necessary for account approval/signing.

Supported EVM networks remain Base Sepolia 84532, Ethereum Sepolia 11155111 and Robinhood Testnet 46630. Mainnet switching, typed asset authorizations and transaction execution remain blocked. OpenSea may require chain 1 authentication or methods outside this narrow wallet; report exact failures instead of broadening unsafe capabilities. A blocked browser or site challenge requires manual reproduction, not circumvention. No Phase 5 work.
