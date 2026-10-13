# Phase 4E results — real OpenSea connection demonstrated

2026-10-13. **The primary definition of success is met on the actual OpenSea website in dedicated Chromium.** The installed extension was discovered, account access was explicitly approved, real OpenSea login signing reached the local wallet, rejection and approval both worked, the authorized public test profile was created, and OpenSea logout revoked the wallet permission. No mainnet or testnet transaction was broadcast in this phase. Phase 5 has not begun.

## Actual website evidence

Browser: Playwright **Chromium 156.0.8078.4**, headed persistent profile in ignored `.state/phase4e-chromium-profile`. Extension: **0.2.0**, MV3, ID `omcdjhkabbkhjbljiammbblaeehcmkaj` for this unpacked path. The normal Chrome profile was untouched. The production extension was loaded unmodified: no intercepted requests, synthetic provider injection, impersonation, stealth or site-security bypass. [Browser metadata](phase4e-evidence/browser.json).

| Observation | Verified result / evidence |
| --- | --- |
| Actual wallet picker | **ZecOne Testnet — Installed**, through EIP-6963. [Screenshot](phase4e-evidence/opensea-installed-picker.png) |
| Explicit account approval | Real `https://opensea.io` request displayed user `0x1865Dd77bFcb632571d3c93144D5634F0D93c714`, Base Sepolia 84532 and approval controls. [Screenshot](phase4e-evidence/real-account-approval.png) |
| Method fallback | OpenSea tried `wallet_requestPermissions`; ZecOne returned 4200. OpenSea successfully fell back to `eth_requestAccounts`. [Log](phase4e-evidence/real-connect-request.json) |
| Account queries | Actual `eth_accounts` and `eth_chainId` succeeded after approval. [Log](phase4e-evidence/real-account-approved.json) |
| Signup | OpenSea required a public username. The user separately approved connection/terms and creation of `zecone-test-c714`. [Form](phase4e-evidence/opensea-signup-gate.png) |
| Login request | Real `personal_sign` contained the OpenSea domain/URI, user address, nonce, issued time, login terms and **chain ID 84532**. It was not an asset authorization. [Review](phase4e-evidence/real-opensea-login-review.png) |
| Rejection | First real login request rejected with 4001; no signature produced for it. [Log](phase4e-evidence/real-login-rejected.json) |
| Approval and login | A fresh challenge was approved locally. OpenSea accepted it and created [zecone-test-c714](https://opensea.io/zecone-test-c714). [Screenshot](phase4e-evidence/opensea-signed-in.png), [log](phase4e-evidence/real-login-approved.json) |
| Account display | OpenSea Wallets settings displayed `0x1865...c714` under the created profile. [Screenshot](phase4e-evidence/opensea-linked-wallet.png) |
| Logout and revocation | OpenSea **Log Out** called `wallet_revokePermissions`. It resolved, the local grant was removed, and the site returned to sign-in. [Log](phase4e-evidence/real-website-logout.json), [screenshot](phase4e-evidence/opensea-logged-out.png), [database verification](phase4e-evidence/preservation-and-live-verification.json) |

The successful login signature also independently verifies against the public user account using viem. Evidence publishes only its message hash and verification result, never the signature, cookie, pairing code or API credential. The public profile remains created; testing ended logged out with its ZecOne origin permission revoked.

After the final cleanup fix, a fresh real-site browser run confirmed an empty transport list: [disconnected action](phase4e-evidence/extension-disconnected.png), [final state](phase4e-evidence/real-final-disconnected.json). The [credential comparison](phase4e-evidence/credential-exposure-check.json) scans changed/nonignored files against known local secrets in memory and reports no exposed values. It supplements the code/permission review; it is not a formal information-flow proof.

## Implementation and validation

The new worker validates browser runtime identity, exact origin, top frame and document; bounds/correlates requests; blocks unsupported/mainnet methods; and retains only volatile transport state. An isolated content script owns the popup transport. The public EIP-6963 facade does not replace `window.ethereum`. No private key, signing credential, remote executable, broad host access or storage permission is added. The local session/CSRF boundary and explicit approval remain authoritative.

The extension action displays account, test network, pending count, per-site status, disconnect and method-only history. Approval UI labels network changes, shows the typed-data verifying contract, preserves message line breaks and displays message-signature risks. The older direct-popup provider remains a regression fixture, not an injected script.

**229 tests pass:** 148 Node/Anvil, 52 unchanged Solidity, four unchanged Rust, 12 existing UI and 13 installed-extension tests. All 207 prior tests remain; one prior manifest assertion now expects the required worker. [Node](phase4e-evidence/node-tests.txt), [final worker policy](phase4e-evidence/extension-policy-final.txt), [contracts](phase4e-evidence/baseline-contracts.txt), [Rust](phase4e-evidence/baseline-rust.txt), [UI](phase4e-evidence/browser-tests.txt), [installed extension](phase4e-evidence/installed-extension-tests.txt). Both TypeScript checks and [production build](phase4e-evidence/wallet-build.txt) pass.

New coverage includes actual MV3 loading, independent discovery, origin/frame/document checks, routing, unauthorized/private RPCs, forged messages, duplicate connections, signing decisions, expiry/late responses/replay, revocation, popup/session loss, browser restart, forced worker termination, approved testnet switching/events, mainnet blocking and action disconnect cleanup. Installed-browser fixtures use a **synthetic signer and fixture-only localhost allowlist**; those signatures are not real account or OpenSea evidence.

Testing found and fixed two bugs: a wallet event envelope overrode the page-bridge protocol, and worker-initiated disconnect did not clear its own state because Chrome does not notify that same port's initiator. Assertions cover both. An action-link fixture could not intercept Chrome's initial extension-created navigation; that fixture assumption was removed, while status/disconnect coverage remains and actual local-wallet navigation was observed.

## Limits and preservation

Actual OpenSea login requested no network switch, typed order or transaction. Those policies are tested locally, not claimed as live OpenSea asset compatibility. Branded Chrome's manual installation, other versions and Web Store distribution are not certified by this Chromium run. See [limitations](PHASE4E-LIMITATIONS.md), [security](PHASE4E-SECURITY.md), [runbook](PHASE4E-RUNBOOK.md).

[Preservation checks](phase4e-evidence/preservation-and-live-verification.json) confirm all **233** earlier documentation/evidence/Cargo files unchanged, unchanged order state/intent/signed-transaction projections, and the same eight settled orders and eight broadcasts (3 + 5). No new Zcash payment, NFT mint, purchase, approval, listing or transfer occurred. Existing NU7 pins, wallets, deployments and Phase 4D API functionality remain intact. This proves connectivity/login, not a production bridge or exchange.
