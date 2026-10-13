# Phase 5 implementation checkpoint

## Final validation checkpoint

**284 tests passed:** Node 196, Rust 11, Foundry 52, wallet browser 12 and extension 13. Both typechecks and the production build passed. A portable native proof/extraction and exact-byte recovery workflow now passes across separate local processes using synthetic notes. The simulated delivery journal covers duplicate sends, ambiguous acknowledgement, restart and stale confirmation recovery; it is not a live transport. See [submission readiness, evidence links and exact remaining gates](PHASE5-SUBMISSION-READINESS.md).

The user confirmed that no separate computer is available. Live refund signing and broadcast remain disabled. A second provider was probed but supplied no usable evidence, so independent-provider verification remains blocked. At the user's request, a 0.002 testnet ZEC funding transfer from the original payer was attempted with a 0.0001 fee cap, but was interrupted without a saved transaction reference. The construction marker is retained, no retry was made, and the fresh payer scan through 4,498,578 found zero receipts. No payment or refund success is claimed. [Funding recovery evidence](phase5-evidence/completion-funding-reconciliation.json).

The following sections preserve earlier checkpoint results; their test totals and remaining implementation descriptions refer to those earlier checkpoints.

2026-10-13 · branch `codex/phase5-secure-settlement` · starting checkpoint `acc982e076c69e90f1b67f405d8abe2ee97e9706`.

**Partial implementation. Phase 5's live shielded-refund acceptance criterion has not been met.** Native Ironwood verification/signing is now integrated with the independent signer in isolated development. A real proof/extraction round trip passed using synthetic notes. No Phase 5 shielded refund or new asset settlement was broadcast. Phase 6 was not started.

## Watch-only continuation

A separate seed-free Rust watch wallet and signer-owned real-chain evidence reader are now implemented. Two new isolated databases independently scanned testnet through **4,498,450** and agreed on the block hash and Ironwood root. Both detected **zero payments**. This is a real chain-reading proof, not a funded refund proof. Live evidence sources are blocked from native signing until separate-device validation. See [implementation, trust boundaries and reproduction](PHASE5-WATCH-ONLY.md) and [sanitized real-chain evidence](phase5-evidence/watch-only-real-chain.json).

The existing funded wallet server was not migrated to the new adapter. The source is independent of backend reports but both scans use the same public lightwalletd infrastructure. Production consensus independence, funded-note testing, unsigned-PCZT export and refund broadcast/reconciliation remain outstanding.

Validation: **188 Node tests passed**, including seven watch-evidence tests, and **three watch-only Rust tests passed**. Service typechecking passed. The separate watch lockfile adds no registry version/checksum absent from the preserved legacy lockfile. [Node log](phase5-evidence/watch-only-node-tests.txt), [Rust log](phase5-evidence/watch-only-rust-tests.txt), [typecheck](phase5-evidence/watch-only-typecheck.txt), [dependency audit](phase5-evidence/watch-only-dependencies.json). An initial sandbox run could not reach local test HTTP servers and was interrupted; the permitted rerun passed all 188 tests. That interrupted log remains separately labeled. No frontend was changed or rerun in this continuation.

## Earlier native-signing continuation

The separate Rust package verifies exact inputs, ownership, witnesses/anchor, network, expiry, value commitments, encrypted recipient outputs, internal change and fees before creating genuine Ironwood spend signatures. The signer-owned TypeScript journal claims request/order IDs and input nullifiers before key use, persists signed PCZTs, and refuses replacement after an uncertain outcome. Its broadcast method remains disabled. See [native integration and reproduction details](PHASE5-NATIVE-REFUNDS.md).

Current continuation checks: **181 Node tests passed**, four native verification tests passed, and the separate expensive proof/extraction test passed. With the unchanged earlier Solidity 52, legacy Rust 4, UI 12 and extension 13 results, this gives **267 tests across retained and rerun suites**. It does not represent live refund coverage. Native dependency checks found no registry version/checksum absent from the legacy lockfile. Existing wallet dependencies and credentials remain untouched.

New evidence: [Node regression](phase5-evidence/native-refund-full-node.txt), [native tests](phase5-evidence/native-refund-tests.txt), [proof/extraction](phase5-evidence/native-refund-proof.txt), [typecheck](phase5-evidence/native-refund-typecheck.txt). No frontend changed during this continuation. The sections below retain the earlier browser/pricing checkpoint for context.

## Implemented changes

- Durable twenty-state lifecycle with explicit transition graph, version checks, immutable intent binding and audit events. Legacy orders retain their original history. Refund recovery adopts a current state explicitly; normal purchases still use the existing lifecycle.
- Refund requests bind the actual confirmed receipt set, exact destination, amount, fee ceiling, order, recipient and expiry. User, operator and independent signer authorization are separate. Native address validation verifies testnet shielded receivers without loading a seed or opening a wallet database. The refund service refuses confirmation thresholds below ten.
- Approval permanently vetoes destination execution. A durable claim now precedes asynchronous EVM construction, closing the race before signed bytes/hash exist. Concurrent workers cannot sign twice; an interrupted claim remains ineligible for a refund or automatic re-signing. A thrown construction/persistence error records recovery while retaining the claim.
- The isolated signer reviewer rechecks its own evidence interface and explicit reviewed digest, journals a claim before approval and refuses interrupted/replayed orders. Its certificate is explicitly **not** a shielded transaction signature. Broadcast is disabled.
- An isolated encrypted keystore uses scrypt/AES-GCM, randomized salt/nonce, authenticated purpose, bounded unlock lifetime, explicit locking and reversible verified-copy staging. No existing wallet credentials were migrated or activated in it.
- Coinbase/Kraken real-market references require independent fresh source timestamps and bounded disagreement. Integer quote calculations enforce fees, deadlines and a provider-commitment policy. Existing payable contract-bound testnet rates remain unchanged and clearly labeled.
- Shared checkout terms cover NFT purchases, controlled Seaport purchases and swaps: network, recipient, price/payment, reserve/fee estimates, deadlines, privacy and recovery limitations. Historical completed terms are viewable without changing an order. Explicit OpenSea URL import remains read-only and non-executable on mainnet.

## Evidence and verification

| Check | Result | Evidence |
|---|---|---|
| Baseline | 229 passed: Node 148, Solidity 52, Rust 4, UI 12, extension 13 | `phase5-evidence/baseline-*` |
| Initial checkpoint Node regression | **175 passed**, including 27 new Phase 5 tests; superseded by 181 above | [log](phase5-evidence/node-tests-final.txt) |
| Final UI regression | **12 passed**, including shared terms assertions | [log](phase5-evidence/ui-tests-final.txt) |
| Native Rust | **4 passed**, including extended testnet address validation | [log](phase5-evidence/rust-development.txt) |
| Solidity / installed extension | **52 / 13 passed** at baseline; these implementations were unchanged | [contracts](phase5-evidence/baseline-contracts.txt), [extension](phase5-evidence/baseline-extension.txt) |
| TypeScript services and web | Passed | [services](phase5-evidence/typecheck-final.txt), [web](phase5-evidence/typecheck-web-final.txt) |
| Production wallet build | Passed | [log](phase5-evidence/wallet-build.txt) |
| Real market data | ZEC/USD and ETH/USD Coinbase/Kraken quorum validated | [snapshot](phase5-evidence/market-data.json) |
| Real public swap inspection/simulation | Contracts verified at block 48067772; 0.0001 test ETH input quoted without broadcast | [report](phase5-evidence/swap-readiness-final.json) |
| Real backend/browser | Ownership login, market references, exact quote review/cancel, mobile terms, malicious import rejection, logout | [report](phase5-evidence/real-browser.json) |
| Preservation / known-secret check | Final count-based reports; no credential values published | [preservation](phase5-evidence/preservation-verification.json), [secrets](phase5-evidence/credential-exposure-check.json) |

The initial checkpoint covered **256 tests across retained and rerun suites**. Its 27 additions use synthetic payment/chain evidence and generated isolated keys. They cover authorization, duplicate requests, under/overpayment bounds, amount overflow, stale/unconfirmed receipts, reorgs, expired requests, destination validation, execution/refund races, pre-sign crash/restart behavior, constructor-failure recovery, signer-journal replay, keystore tampering/wrong passwords/interrupted copy/unlock, quote freshness/disagreement/movement, and malicious URL parsing. The native continuation adds crash-after-sign-before-persistence coverage; refund broadcast crash/reconciliation remains unimplemented.

The final real browser run at 15:07 UTC returned 401 before login, 200 for authenticated Coinbase/Kraken references, reviewed a real simulated-testnet AMM quote, cancelled it before intent/payment signing, and returned 401 after logout. It reported no page errors and no horizontal overflow at 390px for current/historical terms. The fresh quote created only a draft reservation, then cancellation released it. No order payment or destination transaction was approved.

Screenshots: [locked](phase5-evidence/real-locked.png), [privacy](phase5-evidence/real-privacy.png), [desktop quote](phase5-evidence/real-token-review-desktop.png), [mobile quote](phase5-evidence/real-token-review-mobile.png), [historical desktop terms](phase5-evidence/real-historical-terms-desktop.png), [historical mobile terms](phase5-evidence/real-historical-terms-mobile.png), [rejected import](phase5-evidence/real-import-rejected.png). They show actual backend data; synthetic UI regression screenshots are not a payment proof.

## Interruptions and recovery during validation

Initial sandbox test attempts stalled; subsequent permitted runs passed. An interrupted generated Next.js cache contained invalid JSON; it was archived privately and rebuilt successfully. The unsuccessful log remains [available](phase5-evidence/wallet-build-interrupted-cache.txt).

Earlier real quote checks timed out behind `.state/service.lock`, whose recorded PID 26128 no longer existed. After verifying process identities, no native operation, and unchanged historical order/credential records, the identified wallet service was stopped, the stale service lock archived, and the service restarted. No native construction/send marker was changed. The post-recovery quote succeeded. [Recovery record](phase5-evidence/stale-lock-recovery.json), [earlier browser outcome](phase5-evidence/real-browser-before-lock-recovery.json).

## Preservation and transaction references

The initial checkpoint preserved 26 private files and six consistent wallet/application database backups. The final verifier checks 284 prior public files and pinned dependency files, credential bytes and the eight historical settled core records. Existing destination broadcast counters remain three plus five. New quote/cancellation audit entries and normal scans do not rewrite completed transactions.

There are **no new Phase 5 Zcash payment/refund or EVM settlement transaction hashes**. Historical Phase 0–4E references remain in their original documents and are not presented as a fresh refund demonstration. The public swap probe used RPC reads/simulation only; a quote or signature is not chain inclusion.

## What blocks completion

The user requires a separate-computer signer and prohibits migration of existing seeds. The current legacy wallet process can still read those seeds. Strict native PCZT effects verification and durable signing are tested for the isolated Ironwood profile. The new seed-free receiving/scanning wallet and independent reader have an unfunded real-chain proof; funded-note validation, production deployment, separate-device validation and broadcast/confirmation transport remain outstanding. Funded refunds stay disabled.

The complete twenty-state purchase orchestration, market-derived payable intent versions, existing-wallet keystore activation/seed-only restoration, positive live OpenSea URL import, and live refund browser journey also remain outstanding. See [limitations](PHASE5-LIMITATIONS.md), [security](PHASE5-SECURITY.md), [recovery](PHASE5-RECOVERY.md), [runbook](PHASE5-RUNBOOK.md) and the original [feasibility audit](PHASE5-FEASIBILITY.md).
