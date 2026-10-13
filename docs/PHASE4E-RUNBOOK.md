# Phase 4E runbook

Use the existing checkout/wallets, Node 24.12.x and pinned dependencies. **No funding or transaction is needed.** Never reinitialize or migrate the preserved wallets.

## Tests

```powershell
npm.cmd ci --ignore-scripts
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) '.state/playwright-browsers'
npx.cmd playwright install chromium
npm.cmd run typecheck
npm.cmd run typecheck:web
npm.cmd test
forge test
cargo test --locked --offline
npm.cmd run wallet:build
npm.cmd run test:ui
npm.cmd run test:extension
```

The last command loads MV3 into disposable Chromium profiles, using an explicitly local fixture allowlist and synthetic signer. It does not use real keys or OpenSea. The existing UI suite uses Edge. Downloads/profiles/test copies are ignored under `.state`; the test reads the matching revision from the pinned Playwright package. Branded Chrome/Edge no longer support the recommended sideload flags; use manual installation or matching Playwright Chromium.

## Manual Chrome installation and actual OpenSea

1. Create a **dedicated Chrome test profile** without sync/password import or key migration. Open `chrome://extensions`, enable Developer mode in that profile, select **Load unpacked**, and choose this repository's `extension` directory. Confirm version 0.2.0 and OpenSea-only access. No normal-profile installation is needed.
2. Build if necessary, then start `Launch-ZecOne.cmd`. The gateway is `http://127.0.0.1:3210`. If the launcher opens another profile, manually enter that URL in the dedicated profile. Run `node --import tsx scripts/pair-wallet.ts` to renew the one-use local code; enter it from ignored `.secrets/browser-pairing.json` into the wallet's masked field. Never print/share that file or paste it into OpenSea. Approve the local ownership challenge after checking its loopback origin, account and chain.
3. Open actual `https://opensea.io/`, select **Sign in**, confirm **ZecOne Testnet — Installed**, review OpenSea's terms, then select it. The separate localhost popup must show `https://opensea.io`, the correct user account, Base Sepolia 84532 and `eth_requestAccounts`. Explicitly approve account access; keep the window open.
4. Follow normal login for an existing profile. A new profile is a separate public action requiring a username and deliberate agreement. This run created the user-authorized `zecone-test-c714`; do not try to recreate it.
5. Review the actual login message: exact OpenSea domain/URI, public account, nonce/time and chain 84532. Reject unexpected asset authorizations, opaque messages or mainnet requests. To reproduce both decisions, reject one login, retry and approve a fresh understood login. Verify the profile and linked address on OpenSea. Do not use buy/list/transfer/approve/import-wallet controls.
6. OpenSea profile menu → **Log Out**. This run invoked `wallet_revokePermissions`. Confirm the exact origin is absent from ZecOne Apps; if present, revoke it there. The extension should show no approved account. **Disconnect transport** or close the approval popup to end messaging. This does not delete the public OpenSea profile.
7. Save only public screenshots and redacted method metadata. Never export keys, signatures, cookies, browser profiles, HAR, session storage, pairing files or private dashboard data. Remove the test extension/profile manually when no longer needed, preserving useful local evidence first.

For discovery failure, inspect extension errors and verify the exact origin/version. If a popup is blocked, allow only the deliberately opened local popup using normal browser controls. If COOP/security policy severs the opener, document the blocker and stop. Never impersonate MetaMask, disable web security, bypass challenges or retry an unknown signing outcome.

## Project-only real-site browser helper

After installing the matching browser, `node scripts/phase4e-browser.mjs` opens visible Chromium with the **unmodified production extension** and ignored `.state/phase4e-chromium-profile`. It approves nothing automatically. Deliberate terminal commands are JSON, one per line:

```json
{"action":"snapshot"}
{"action":"click","name":"Sign in"}
{"action":"text-click","text":"ZecOne Testnet"}
{"action":"pages"}
{"action":"snapshot","page":1}
{"action":"logs","name":"my-redacted-method-log"}
{"action":"quit"}
```

Use observed page indices/controls. `wallet` opens the local dashboard; `pair` on that page reads the one-use code without logging it. Decisions require explicit click commands or manual UI actions after review. Obtain consent before external terms/profile creation. Named screenshots/logs save under `docs/phase4e-evidence`; choose new names to preserve history. `browser.json` describes the latest run.

`node --import tsx scripts/phase4e-verify.ts` reads historical hashes, order/broadcast projections, origin permissions and the real login signature, publishing only verification results. It requires this checkout's private Phase 4D SQLite checkpoint/live database and is not a portable fixture. It prints no signature or credential. See [results](PHASE4E-RESULTS.md), [security](PHASE4E-SECURITY.md) and [limitations](PHASE4E-LIMITATIONS.md).
