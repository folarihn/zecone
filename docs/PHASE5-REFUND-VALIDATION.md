# Phase 5.1 refund validation

2026-10-15. **Live refund: blocked. Separate-device validation: not performed. Mainnet readiness: NO. Phase 5 remains incomplete; Phase 6 has not started.**

## Actual funding and refund status

The disposable payer and receiver/refund-signer each scanned Zcash testnet through **4,503,971**, with zero payments and matching block hashes. The original 0.002 TAZ transfer remains uncertain; no safe replacement or new paid order was created. [Transfer recovery findings](PHASE5-TRANSFER-RECOVERY.md), [actual scan evidence](phase51-evidence/investigation-2026-10-15T06-40-58.201Z.json).

There is no Phase 5.1 live refund transaction hash, actual-note unsigned PCZT, signed live refund, broadcast or confirmed destination receipt. The original credentials and historical settled orders were preserved. The new native request guard prevents a different UUID from bypassing an unresolved construction.

The user confirmed that a second physical computer is unavailable. Local process separation remains simulated. Existing portable and native gates reject real-chain signing; production refund broadcast remains disabled. No credentials were migrated.

## Regression results

| Suite | Passing tests / result | Recorded evidence |
| --- | --- | --- |
| Full Node suite | 202 | [log](phase51-evidence/node-tests.txt) |
| Native wallet Rust | 6 | [log](phase51-evidence/rust-wallet.txt) |
| Watch-wallet Rust | 3 | [log](phase51-evidence/rust-watch.txt) |
| Native refund Rust | 4, plus one ignored expensive test | [log](phase51-evidence/rust-signer.txt) |
| Solidity/Foundry | 52 | [log](phase51-evidence/contracts.txt) |
| Wallet browser | 12 | [log](phase51-evidence/browser-tests.txt) |
| Extension browser/security | 13 | [log](phase51-evidence/extension-tests.txt) |
| Service/web typechecks | passed | [service](phase51-evidence/typecheck.txt), [web](phase51-evidence/typecheck-web.txt) |
| Production build | passed | [log](phase51-evidence/production-build.txt) |

**292 tests passed across the full suites.** The focused recovery/security run also passed 45 tests before the additional same-amount-origin test was added; all are included in the full Node count. The ignored Rust proof test is not counted; native proof/extraction passed through the Node synthetic portable test. That test's public metadata is retained as [current synthetic proof evidence](phase51-evidence/portable-roundtrip.json), without presenting its synthetic transaction ID as an on-chain reference.

Coverage includes lost broadcast acknowledgements, expiry boundaries, duplicate funding IDs, duplicate refund requests, refund/execution races, wrong destination, insufficient confirmations, stale scans, reorganizations, signer rejection and restart reconciliation. Network delivery fault tests remain explicitly simulated. Browser and extension tests use local fixtures; no new live purchase or refund is implied.

The native proof test formerly overwrote its original tracked evidence report. The new run was saved separately and the original committed report restored; future tests now write into their disposable test directory. A targeted proof rerun verifies this output change; [log](phase51-evidence/portable-report-isolation.txt). This rerun is not counted twice.

A development typecheck caught a union-type error in the new provider reporting script; it was fixed and the passing rerun is recorded. Rust emitted a cache hard-link warning and Foundry could not flush an optional cache outside the workspace; the suites passed. A sandbox process-launch failure required an approved production-build rerun. These failures were not treated as successful checks.

## Portable signing workflow and remaining gates

The existing [portable runbook](PHASE5-RUNBOOK.md) and [native validation profile](PHASE5-NATIVE-REFUNDS.md) remain applicable. The signer accepts a bounded unsigned request, obtains its own evidence, displays exact destination/amount/fee/expiry, checks user/operator authorization and requires approval of the review digest. It signs/proves with disposable isolated credentials and returns a narrow transaction envelope. Recovery returns persisted bytes; uncertain claims cannot silently sign a replacement.

```powershell
node --import tsx scripts/phase5-portable.ts prepare-simulation
node --import tsx scripts/phase5-portable.ts review <session-json-path>
node --import tsx scripts/phase5-portable.ts sign <session-json-path> <approved-review-digest>
node --import tsx scripts/phase5-portable.ts recover <session-json-path>
```

These are synthetic rehearsal commands, not a live refund package. Never fund fixture addresses. Keep signer evidence, keys, password and journal private; transfer only the unsigned request and returned signed transaction envelope. Same-account development passwords beside encrypted files do not provide device isolation.

A real portable package cannot be honestly produced until actual funded notes and an eligible new order exist. Actual-note PCZT proposal/export and production broadcast/confirmation reconciliation still require implementation and validation. The simulated delivery journal is not attached to the real backend.

Before live refund signing:

1. Resolve the interrupted source transfer; do not send a competing replacement.
2. Obtain fresh isolated funds and verify a new eligible payment with at least ten confirmations.
3. Supply independent chain evidence from a usable provider or a separately operated validating testnet node. Current ECC/ZEC.PRO probes failed; both successful wallet scans share zec.rocks.
4. Validate exclusive spending-key custody and independent evidence on a separate physical signer device. The user currently has none available.
5. Construct and independently review actual inputs, exact outputs/change, fee and expiry. Establish the execution interlock, then obtain explicit approval of the exact refund before broadcast.
6. Verify at least ten refund confirmations and exact destination receipt, duplicate rejection, execution prevention and restart/reorg reconciliation.

## Preservation and next user action

[Scoped preservation and known-secret audit](phase51-evidence/preservation-and-secret-audit.json) records original public evidence/pins, credential hashes and historical order/broadcast projections without revealing keys. The source database and request markers were also hash-checked during the investigation. No mainnet operations were performed.

The next useful user contribution is any surviving original process output or verified backup containing the interrupted transaction reference/bytes; **do not share spending keys or seed phrases**. A separate signer computer is also required before live validation can proceed. Do not fund the payer a second time from the original wallet while its attempt is unresolved. The exact replacement details will be prepared for approval only after safety is established.

For a hackathon demonstration, the existing historical transactions, real read-only scans, local security flows and labeled synthetic portable signing/recovery remain available. A new end-to-end real refund demonstration is blocked, and full Phase 5 completion is not claimed.
