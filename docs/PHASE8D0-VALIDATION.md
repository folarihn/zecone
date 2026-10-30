# Phase 8D.0 validation

Starts at `70b4cb3`. No live credential unlock, signature, payment, broadcast, refund or mainnet execution. Synthetic signatures/transactions in existing disposable regression fixtures are not live evidence. [Compatibility report](PHASE8D0-DAPP-COMPATIBILITY.md) and [matrix](phase8d0-evidence/compatibility-matrix.json).

## Implementation

Changed extension provider injection, input policy and Solana connection lifecycle; removed nonfunctional Solana signing advertisements in extension and backend account metadata. Added public permission/session-status checks and fail-closed popup cleanup. Scoped cross-site document navigation to explicit connection pages without relaxing default API access. No financial journal rows, settlement authorization, recipient, economics, key material or execution path is changed. The real-site browser probe was reduced to observation and approved cancellation only; it cannot pair sessions, read local credentials, approve accounts or sign.

Security tests cover duplicate injection/registration, delayed approval cancellation, SDK-compatible public address binding, stale response rejection, popup/session closure, malformed parameters and silent-connect privacy. Existing tests cover browser-authenticated origin isolation, pre-approval account privacy, wrong chain/account checks, revocation, worker restart, extension reload/transport loss, unsupported requests and completed-order replay. New connection-status API tests cover CSRF, exact origin grant, revoked grants and disconnected sessions without reading credentials.

## Final results

**490 tests pass**: 358 Node, 29 wallet UI, 20 installed-extension browser, 6 historical UI, 3 isolated API/UI, 3 completed swap API/UI, 52 Solidity, 10 Rust wallet, 5 watch and 4 signer. One pre-existing standalone expensive native proof remains ignored. Both TypeScript checks, lint, production build and extension build pass. Focused security runs (46 combined, 4 new lifecycle cases) are not double-counted.

Final logs are under `phase8d0-evidence/`: `node.txt`, `focused.txt`, `new-security.txt`, `ui.txt`, `extension.txt`, `phase6c-ui.txt`, `phase7a-ui.txt`, `phase7c-ui.txt`, `contracts.txt`, `rust-wallet.txt`, `rust-watch.txt`, `rust-signer.txt`, `types.txt`, `types-web.txt`, `lint.txt`, `build.txt` and `extension-build.txt`. A sandbox loopback denial and a Next.js output-directory permission denial were rerun with permitted fixture/build access; private diagnostic copies are retained. No security assertion was weakened to bypass those environment restrictions.

All **628 protected files** and their historical inventory copies match. Both original completed financial records match the pre-validation baseline; signed evidence, receipts and exactly one signing/broadcast claim per settlement remain. Fresh finalized receipt reads match saved evidence. Consistent-copy restart/replay/refund-veto checks pass with zero signer access and zero broadcast calls. Live refunds stay disabled. See `preservation.json`, `inventory-check.json`, `completed-order-audit.json` and `validation-summary.json`.

Real-site results are deliberately partial: both sites load/announce ZecOne and return no accounts before consent; Uniswap picker detection passes. Current OpenSea picker and selection/cancellation automation is blocked by site/selector timeouts. No account approval, authentication, signature or transaction pass is claimed. Earlier private screenshots with stronger-sounding filenames are not used as current proof.

Reproduction (PowerShell; local fixture/public read network permissions required):

```powershell
node --import tsx --test --test-concurrency=1 tests/*.test.ts
npm run typecheck
npm run typecheck:web
npm run lint
npm run wallet:build
npm run extension:build
$env:ZECONE_QA_EVIDENCE_DIR='.state/phase8d0/browser'
npm run test:ui
npm run test:extension
npm run test:phase6c
$env:ZECONE_PHASE7C_REGRESSION='1'
npm run test:phase7a
$env:ZECONE_PHASE7C_FINALIZED='1'
npm run test:phase7c
forge test
cargo test -p zecone-zcash
cargo test --manifest-path services/zcash-watch/Cargo.toml
cargo test --manifest-path services/refund-signer-native/Cargo.toml
node scripts/phase8d0-browser.mjs
node scripts/phase8-preserve.mjs --phase8d0
```

Use the pre-validation private Phase 8D.0 baseline; a fresh baseline must be initialized before changes/checks, never in place of historical inventory verification. Screenshot profiles/evidence are private under `.state/phase8d0`; protected historical screenshots are not overwritten. The real-site probe produces bounded sanitized facts and does not treat a picker timeout as wallet failure or success. Unmeasured states are not fabricated passes.

## Financial preservation

All 628 protected entries and their inventory copies must match. Original completed financial fingerprints are compared read-only against the Phase 8D.0 baseline. Restart/replay/refund-veto probes use consistent SQLite copies with signer and send methods poisoned; no original paid order is reopened or rerun. Historical signed wire, signatures, receipts, payment uniqueness and claims are retained. Existing live refunds stay disabled.

The final sanitized results are in `phase8d0-evidence/`. Original financial/private inventory fingerprints are never published. No authenticated OpenSea/Uniswap login or full third-party transaction compatibility is claimed. Phase 8D UI polish and unrestricted signing have not started.
