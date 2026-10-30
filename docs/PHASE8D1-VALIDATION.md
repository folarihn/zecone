# Phase 8D.1 validation

Starts at `2c9b00d`. Testnet, non-executing intent interpretation only. No live keys were unlocked, no payment was created, no destination transaction was signed/submitted and no refund was activated. Historical financial authorization and execution code remains unchanged. Existing regressions use their established disposable native/EVM/Solana signing fixtures; those are not new live evidence.

## Coverage and evidence

`tests/phase8d1-intents.test.ts` has 21 cases covering pinned EVM mint/purchase/router shapes, unknown contracts/routers, strict ABI encoding, chain/origin/account/expiry binding, finite/unlimited approvals, economic and route caps, immutable registry, unavailable/failed/mismatched simulations, duplicate IDs, cross-session/origin/channel access, concurrent preparation, exact consent/cancellation, late consent, provider non-execution and restart without preview mode. Solana fixtures cover canonical SOL delivery, bounded Raydium ATA/wrap/swap instructions, wrong programs/accounts/amounts, nonzero signatures, versioned messages/ALTs, wrong decimals, mint/pool/terms changes, simulation/fee/genesis/blockhash failure and private-field rejection. No source payment data reaches read callbacks or responses.

Two isolated browser presentation tests cover popup disclosure and exact preview consent/cancellation. All API calls in those two tests are intercepted synthetic fixtures. They do not assert real third-party compatibility or financial execution. Existing installed-extension browser checks continue to exercise the real MV3 transport with their documented synthetic wallet fixtures.

**513 tests pass**: 379 Node, 31 wallet UI, 20 installed-extension browser, 6 historical UI, 3 isolated API/UI, 3 completed swap API/UI, 52 Solidity, 10 Rust wallet, 5 watch and 4 signer. The final focused provider/intent suite passes **29 tests** (8 existing provider + 21 intent cases), including the last request-list privacy assertion; it is not double-counted. Both TypeScript checks and scoped lint pass. Production wallet and extension builds pass. Final cross-stack totals and command results are recorded in `phase8d1-evidence/validation-summary.json`; logs in that directory are sanitized test output, not new financial transaction evidence.

The first installed-extension run reported a timing edge after session disconnection: the immediate next `eth_accounts` call returned error 4900 while the test expected an empty list. Neither result exposes accounts. The first diagnostic is retained privately; the unchanged complete rerun passes 20/20. No assertion or extension behavior was weakened. This observed intermittent transport timing remains a limitation, not a fabricated first-run pass.

The new popup tests initially used an ambiguous text locator that matched both the visible disclosure and the collapsed exact-payload inspector. Targeting the visible definition fixed the test; no product or security assertion was relaxed. Shared browser model types were separated from backend policy imports to satisfy the existing web TypeScript boundary without broadening compiler settings. Final typechecks/build pass.

## Preservation and reconciliation

`scripts/phase8-preserve.mjs --phase8d1` compares all 537 historical + 91 Phase 7B files to their original inventories, and original completed financial rows to a private baseline initialized before this work. `scripts/phase8d1-settlement-audit.ts` checks that the inventory copies themselves still contain all 628 unchanged entries. Original journals are opened read-only; consistent SQLite backups are used for restart/replay/refund-veto probes. Poisoned signer/send interfaces confirm zero audit signer accesses and zero audit broadcast calls. Existing signatures, signed bytes, receipts, settled state, one signing claim and one broadcast claim per completed settlement remain intact.

Fresh public finalized Solana receipt reads match saved evidence for both Phase 7B and Phase 7C. Phase 7C retains 76,043,880 output units, 3,981,880-lamport debit and 2,976,880-lamport rent. No source payment identifier or recipient correlation is published by these diagnostics. See `completed-order-audit.json` and `preservation.json`.

## Reproduction

PowerShell from the repository; use local fixture/browser/compiler permissions as needed. No live wallet server is needed for these tests.

```powershell
node --import tsx --test --test-concurrency=1 tests/*.test.ts
node --import tsx --test tests/dapps.test.ts tests/phase8d1-intents.test.ts
npm run typecheck
npm run typecheck:web
npm run lint
npm run wallet:build
npm run extension:build
$env:ZECONE_QA_EVIDENCE_DIR='.state/phase8d1/browser'
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
node --import tsx scripts/phase8d1-settlement-audit.ts
node scripts/phase8-preserve.mjs --phase8d1
```

Preservation/reconciliation requires the operator's existing private inventories and journals; do not replace them with new baselines to hide changes. The initial baseline is created with `--initialize` before validation. The default ignored standalone expensive native proof remains ignored; existing Node proof fixtures still run in the full suite. New local inspector tests use no live credentials.

## Remaining scope

The supported-action matrix is in [PHASE8D1-SUPPORTED-ACTIONS.md](PHASE8D1-SUPPORTED-ACTIONS.md). Existing adapter recognition is not an imported financial authorization. No new authenticated real-site action or ZEC-funded third-party execution is verified. Live Solana read-only inspection, pinned deployment configuration, fresh economic quotes and separate checkout/financial authorization remain prerequisites for a later explicitly authorized Phase 8D.2. Stop after 8D.1.
