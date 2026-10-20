# Phase 8D.2 validation

Checkpoint `8aa6bc1`. Scope: Base Sepolia purchase quote/checkout rehearsal, disposable fixtures only. No new live payment, key unlock, financial signature, submission or refund activation. Existing regression suites retain their documented disposable signing/native-proof fixtures; none is reported as new live evidence.

## Implementation and coverage

New read-only purchase mapper reuses `interpret`, `inspectListing` and `priceZatoshis`; a separate SQLite dry-run ledger reuses `unifiedCheckouts`/`checkoutBrowserView` without financial state. Provider/local API integration and three explicit popup gestures keep preview, quote review, dry-run creation and actual settlement authority separate. Rehearsal mode requires intent interception, disabled signing and no financial purchase service, rejects legacy signing methods, and is not enabled in the live server. No financial authorization, order journal or relayer execution code was changed.

`tests/phase8d2-checkout.test.ts` has **20 cases**. Coverage includes exact registered mapping, existing listing checks and pricing, immutable quote copies, paired block/term agreement, fee/inventory/code/recipient/ownership/approval checks, wrong networks, unsupported methods and nonzero-slippage fields, stale/expired/refreshed quotes, price/fee changes after review, explicit independent checkout authorization, cancellation, concurrent/duplicate claims, session/origin/chain mismatch, revocation during async reads, actual HTTP-session deletion during preparation, interrupted/restarted state, completed-handoff replay and financial-ID rejection. Foreign SQLite files are refused before write access. Source-reference canaries and poisoned live-engine access verify the new flow has no payment/signing integration.

The HTTP fixture exercises real handlers from persisted intent consent through fresh quote, exact review and handoff. Browser fixtures intercept all APIs and test separate user gestures, visible destination/ZEC cost/trust disclosures, expired-quote refusal, no automatic refresh and no quote payload sent back to the dApp. They are not real third-party compatibility or financial execution evidence.

**535 tests pass**: 399 Node, 33 wallet UI, 20 installed-extension browser, 6 historical UI, 3 isolated API/UI, 3 completed swap API/UI, 52 Solidity, 10 Rust wallet, 5 watch and 4 signer. The final 49-case provider/intent/checkout focused run is not double-counted. Both TypeScript checks, scoped lint, production wallet and extension builds pass. One pre-existing standalone expensive native proof remains ignored; the existing Node native-proof fixtures still execute in the full suite.

The new expiry browser test initially matched both its visible error and Next.js's empty route-announcer alert. Scoping the locator to the rehearsal panel fixed the assertion; expiry rejection and zero-create/no-auto-refresh requirements were not relaxed. A diagnostic test initially attempted to serialize `BigInt`, then incorrectly counted a local ABI schema field as transmitted data. It now checks the destination request arguments without local ABI metadata. The real adapter sends constructed destination calldata only; no private payment canary is accepted. Initial diagnostics are not claimed as passing runs.

## Preservation and completed orders

The Phase 8D.2 private financial baseline was initialized before changes. `scripts/phase8-preserve.mjs --phase8d2` compares all **537 + 91 = 628** protected files and original financial rows against their original inventories/baseline. Previous reports and wallet files are not overwritten. Both original completed settlements retain their signed bytes, signature, receipt, settled state, unique payment binding and one signing/broadcast claim each. Refunds remain disabled.

`scripts/phase8d1-settlement-audit.ts --phase8d2` writes only new Phase 8D.2 evidence and consistent SQLite backups. Original journals are read-only; copied restart/preparation/execution/refund-veto checks poison signer and send interfaces. Audit signer accesses and broadcast calls are zero. Fresh public finalized receipt reads match both saved settlements. The historical inventory copies themselves retain all 628 unchanged entries. No completed original order is reopened or executed.

Logs, aggregate preservation, copy-audit results, selected-action record and validation summary are in `phase8d2-evidence/`. Exact private financial fingerprints and temporary databases stay gitignored. No Zcash payment/transaction ID or new funding-to-recipient correlation is published.

## Reproduction

PowerShell from this repository. Local fixture/browser/compiler/public-read access may be needed; no live wallet server is required.

```powershell
node --import tsx --test --test-concurrency=1 tests/*.test.ts
node --import tsx --test tests/dapps.test.ts tests/phase8d1-intents.test.ts tests/phase8d2-checkout.test.ts
npm run typecheck
npm run typecheck:web
npm run lint
npm run wallet:build
npm run extension:build
$env:ZECONE_QA_EVIDENCE_DIR='.state/phase8d2/browser'
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
node --import tsx scripts/phase8d1-settlement-audit.ts --phase8d2
node scripts/phase8-preserve.mjs --phase8d2
```

Preservation requires existing private historical inventories/journals. Initialize a new phase baseline with `--initialize` **before** validation; never replace historical inventories/baselines to hide a change. The audit's default Phase 8D.1 mode remains compatible; `--phase8d2` explicitly selects the new output/copy namespace.

## Limits and remaining work

New quoting is verified with two injected synthetic read clients, not independently operated live RPCs. No new real dApp action, payment, purchase or signed executor simulation is claimed. The preliminary buy-call estimate and inventory snapshot are not a guarantee/reservation of future execution capacity. Strict fee/listing changes require new review; interrupted creation stays recovery-required, and expired sessions cannot automatically reclaim records.

Before any future live flow: verify existing deployment/runtime pins and independently operated bounded read providers, install an explicitly authorized live integration, preserve the existing inventory reservation and recipient signing requirements, separately authorize payment-address allocation/payment, simulate the full signed executor, and authorize/verify destination execution. Historical plaintext keys, same-user local access, trusted-relayer correlation and public destination activity remain limitations. See [design and mapping](PHASE8D2-CHECKOUT.md). **Stop after Phase 8D.2; no live execution or UI polish.**
