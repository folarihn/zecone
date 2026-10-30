# Phase 8A validation and change record

Starting commit: `15ae8dc`. Execution scope: privacy implementation and disposable regression tests only. See [privacy boundaries and limitations](PHASE8A-PRIVACY.md).

## Changes

Application/API files:

- `services/wallet/privacy.ts` — shared positive projections, session aliases, private inspection warning and bounded sanitized diagnostics.
- `services/wallet/api.ts` — private checkout inspection with backend ownership checks; projected checkout/dashboard/list responses; display-alias translation into unchanged action references; redacted errors and diagnostics export.
- `services/wallet/checkouts.ts` — explicitly labels the stable-ID projection as restricted backend data, not an HTTP DTO.
- `services/wallet/security.ts` — prunes expired authentication rows only.
- `services/wallet/snapshot-api.ts` — positive projections, snapshot-scoped inspection and sanitized diagnostic export while preserving read-only spending vetoes.
- `services/solana/privacy.ts` — nested swap allowlist, minimized delivery view and session history lookups.
- `services/solana/settlement-api.ts` — owner-scoped delivery history, opaque unified checkout IDs, explicit private inspection and redacted errors/exports.
- `services/solana/swap-api.ts` — refuses unattached existing history, minimizes payment-request responses and exports only bounded diagnostic counts.
- `app/checkout/tracker.tsx` — removes persistent identifier storage; validates session selection; clears on deadline/denial; explicit local inspection with one-minute lifetime.
- `app/checkout/selection.ts` — pure validation of scope, expiry and visible handle membership.

Validation/documentation files:

- `tests/phase8-privacy.test.ts` — eleven new disposable privacy, authorization, retention, backend preservation and destination-request tests.
- `tests/ui/phase8-privacy.spec.ts` — scoped storage, explicit inspection and session clearing in the browser.
- `tests/solana-swap.test.ts` — existing-order fixture explicitly attaches its owner history; retains all existing security assertions.
- `tests/phase6c/real-data.spec.ts` — historical references must be hidden until explicit inspection; only inspection POSTs are permitted during the replay view test.
- `scripts/phase6-lint.mjs` — includes the new source/tests/preservation tool.
- `scripts/phase8-preserve.mjs` — reads original inventories and financial journals without publishing per-file hashes or sensitive paths; writes new Phase 8A reports.
- `docs/PHASE8A-PRIVACY.md`, this report, `PROGRESS.md` and new `docs/phase8a-evidence/` outputs.

No execution policy, transaction construction, recovery authorization, key manager, RPC provider implementation, dependency version or historical inventory was changed. Alias translation changes HTTP display references only; original session/exact-review/economic checks still decide whether an action can execute.

## Measured improvement

Routine browser responses in the changed routes no longer contain source payment references, source receiving addresses, internal financial order IDs, raw wire, private recovery rows or unbounded nested quote data. Private identifiers remain in restricted storage for reconciliation and duplicate-payment protection. The new tests include both a client canary and an actual persisted synthetic payment key and assert the key survives backend storage while staying out of routine responses.

Private inspection requires current authentication, CSRF, the matching adapter/session handle and backend ownership or a fixed read-only snapshot capability. Cross-session handles, wrong owners, missing acknowledgement and foreign origins are rejected. A handle never authorizes payment, signing, broadcast or refund.

Diagnostic export contains fixed-category counts only; arbitrary raw errors/objects are not copied. Retention affects ephemeral diagnostics and expired authentication only. Screenshots, private journal copies and development diagnostics stay gitignored under `.state/phase8a/`; historical financial evidence is not rewritten.

The unsigned swap leakage test compiles real SDK transaction bytes and captures preparation/simulation arguments against fake providers. It checks both serialized arguments and decoded transaction/message bytes for the synthetic shielded canary. The real RPC account adapter is also exercised with a fake provider to check fixed public pool queries. This is regression evidence, not a proof that every future integration is private.

## Validation results

**446 tests pass; zero final-suite failures.** Counts: 317 Node, 29 wallet UI (including four new privacy browser tests), 17 installed extension, 6 historical read-only UI, 3 isolated API/UI, 3 completed swap API/UI, 52 Solidity, 10 Rust wallet, 5 Rust watch and 4 native signer. One pre-existing standalone expensive signer proof remains ignored; Node integration still exercises native proof/signing with isolated fixtures. Both typechecks, scoped lint and production build pass. Focused test runs are not double-counted.

The final production UI was rebuilt after adding stale-response/inspection cancellation guards. All wallet UI tests and the historical/isolated/completed-order integration views passed against that final build. Browser tests verify expiration even if a stale successful response arrives later, one-minute inspection clearing, session denial and safe selection restoration. An early new test fixture incorrectly selected a program address as a fee payer; the SDK rejected it, and the fixture was corrected to an unsigned public test key. Development diagnostics remain private; no security assertion was weakened to pass validation.

Public logs use only the new `docs/phase8a-evidence/` directory; browser captures use `.state/phase8a/browser`. Evidence: [Node](phase8a-evidence/node.txt), [wallet UI](phase8a-evidence/ui.txt), [extension](phase8a-evidence/extension.txt), [historical UI](phase8a-evidence/historical-ui.txt), [isolated API/UI](phase8a-evidence/isolated-api.txt), [completed swap API/UI](phase8a-evidence/finalized-ui.txt), [contracts](phase8a-evidence/contracts.txt), [Rust wallet](phase8a-evidence/rust-wallet.txt), [watch](phase8a-evidence/rust-watch.txt), [native signer](phase8a-evidence/rust-signer.txt), [types](phase8a-evidence/types.txt), [web types](phase8a-evidence/types-web.txt), [lint](phase8a-evidence/lint.txt), [build](phase8a-evidence/build.txt).

Preservation: **537 historical + 91 Phase 7B files checked, zero changes**. Both original journals retain `COMPLETED/settled`, signed evidence and receipts, exactly one signing claim and one broadcast claim, and disabled refunds. Before/after private fingerprints of orders, payments, Solana settlement rows and verified payment authorizations match. See [aggregate preservation](phase8a-evidence/preservation.json).

Both protected inventories also match their private copies from the preceding audit: [inventory integrity](phase8a-evidence/inventory-check.json). No historical inventory or preservation report was rewritten.

Fresh finalized devnet receipts match both persisted receipts. Consistent journal copies reject replay before signer access and veto completed-order refunds; the poisoned signing/submission paths record zero accesses/calls. Phase 7C historical receipt effects remain 76.043880 output tokens with 3,981,880 lamports debit, including 2,976,880 lamports rent. These are reverified past effects, not a new swap or a new balance claim. See [read-only completed-order checks](phase8a-evidence/completed-order-audit.json).

Reproduce the standard checks from the audit, replacing evidence output paths with Phase 8A paths and setting:

```powershell
New-Item -ItemType Directory -Force '.state/phase8a/browser' | Out-Null
$env:ZECONE_QA_EVIDENCE_DIR='.state/phase8a/browser'
npm test
npm run typecheck
npm run typecheck:web
npm run lint
npm run wallet:build
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
node scripts/phase8-preserve.mjs
```

Run browser suites sequentially. Existing snapshot/profile fixtures, browser runtime and public devnet read access are needed for integration suites. Node/native tests can create and sign disposable synthetic fixtures; no live wallet is unlocked or used. Do not start the legacy signing-capable wallet server for QA; the configured test servers use mock, isolated or read-only backends.

The additional completed-order verifier uses consistent private SQLite backups and fresh public finalized receipts, with the signer and send operation poisoned. It is retained locally at `.state/phase8a/replay-audit.ts`; sanitized assertions are in `completed-order-audit.json`. It does not reopen a live order or construct a replacement payment.

## Remaining risks and deliberate restrictions

The operator still holds source-to-destination joins. Routine views still contain amounts, confirmation progress, deadlines and public destination information, which can aid correlation. Public destination ownership and RPC IP/timing visibility remain. Historical exports may already contain identifiers; they were preserved, not erased. Same-user filesystem access, plaintext historical keys, extension discovery fingerprinting and single-provider finality are unchanged.

Public NFT token identifiers may reflect the existing signed-intent/order identifier scheme. Keeping necessary public token/destination references visible does not make those identifiers unlinkable; API minimization does not change that on-chain protocol relationship.

New-session history attachment is not automatic. Phase 7C retains explicit operator attachment. Historical Phase 7B browser orders without a current ownership binding are intentionally hidden rather than assigned to whoever pairs next; a general operator history recovery UI/tool is not supplied by this phase. Backend financial records remain available for controlled operator inspection. Local snapshot pairing grants read access to that selected snapshot, not spending-key ownership.

Source-transaction history is no longer returned in the routine dashboard. Checkout-associated references require explicit inspection; no general private source-history browser was added. More detailed error diagnostics remain operator-only rather than being returned as raw exceptions. These are privacy/access restrictions, not new wallet or transaction capabilities.

Live refunds remain disabled, both completed settlements must remain completed and replay-ineligible, and no new live payment, unlock, signing or broadcast is authorized or performed. Stop after Phase 8A.
