# Phase 5 submission readiness

Checkpoint date: 2026-10-13. **Phase 5 is partially complete. Mainnet readiness: NO. Live refund demonstration: BLOCKED.** Phase 6 has not started.

The user confirmed that no second computer is available and authorized simulated isolation with disposable credentials. Local signing remains restricted to synthetic notes; real-chain evidence cannot activate native signing. No live refund was signed or broadcast, and there is no refund transaction hash to report.

## Completed and verified

- Seed-free Rust watch wallet, independently fetched signer evidence, strict native Ironwood transaction review/signing, durable request/order/input claims and a permanent execution veto on refund approval.
- Portable request review, explicit approval of the displayed digest, native proof/extraction, and export of only a signed transaction envelope. Finalization claims are durable before proof generation; replay returns the stored bytes. An uncertain finalization cannot silently produce a replacement.
- A separate, explicitly simulated delivery journal tests duplicate broadcasts, lost acknowledgements, restart, stale confirmations and recovery. It refuses production order/refund databases and is not wired into the live backend.
- Fresh disposable payer, receiver/refund signer and refund destination. Newly generated secrets are encrypted locally; existing wallet credentials were not migrated. The development password beside each encrypted keystore means this is not OS or device isolation.
- Existing Phase 5 bounded reference pricing, shared checkout disclosures, explicit OpenSea URL handoff, authorization and privacy protections are retained. Remaining product integration is listed below.

The portable CLI rehearsal ran in separate local processes, rejected the wrong approval digest and recovered the exact saved transaction bytes. Its notes/anchors and automated fixture approval were synthetic. It establishes functional recovery, not a chain payment or physical isolation. [CLI evidence](phase5-evidence/completion-portable-cli.json), [native portable round trip](phase5-evidence/completion-portable-roundtrip.json).

## Real-chain evidence and funding recovery

The previous two watch scanners agreed through height **4,498,450**, using one provider. The latest fresh payer scan reached **4,498,578** with block hash `00000bb25294f68ca9f94f00089533f6bf4bb3c28b7180b6431c86fb02282cfb` and found **zero receipts** at 2026-10-13 17:17:29 UTC. These are actual testnet reads, not funded-refund evidence. [Earlier scans](phase5-evidence/watch-only-real-chain.json), [latest scan and recovery checks](phase5-evidence/completion-funding-reconciliation.json).

At the user's request, funding **0.002 testnet ZEC** from the original payer was attempted after quoting a **0.0001 ZEC fee**, with that fee cap. Request ID: `bcb86911-fb11-44e5-9f76-cbfaa713091f`. The process was interrupted. Its construction marker and process lock remain, but there is no saved transaction reference, matching source transaction or recipient receipt. **This is not a successful payment.** No retry was made and neither marker was cleared. Reconciliation of this attempt is required before considering any replacement transfer. Existing credential bytes and historical settled order records are preserved; ordinary wallet scan state and this new recovery marker are not claimed byte-identical.

Public disposable addresses and funding assumptions are recorded in [test-wallet evidence](phase5-evidence/completion-test-wallets.json). The suggested payer balance is 0.002 testnet ZEC. The estimated minimum is 0.0011 for a planned 0.001 payment plus a 0.0001 fee, assuming one mature Ironwood input. Planned refund: 0.0009 plus 0.0001 fee. Actual input selection and fees must be checked again; these figures exclude transparent shielding.

## Independent provider status

`https://testnet.zec.rocks:443` supplied test-chain identity, branch `77190ad9`, block hash and Ironwood root at common height 4,498,450. The additional `https://lightwalletd.testnet.electriccoin.co:9067` probe returned no usable evidence. The latter is referenced by [maintained Zingolib configuration](https://docs.rs/zingolib/latest/src/zingolib/config.rs.html); a configured URL is not an availability guarantee. The former `testnet.lightwalletd.com` was retired according to its [operator announcement](https://forum.zcashcommunity.com/t/important-public-infrastructure-service-changes-on-may-30th-2024/47606).

**Independent-provider agreement and transaction inclusion were not established.** The agreement validator rejects shared operator identity, stale evidence, wrong network/branch, divergent hashes/roots and insufficient confirmations. Its tests use fixtures. Even agreement between two light servers would not constitute full consensus validation. A separately operated, synchronized testnet node/lightwalletd is the alternative. [Probe evidence](phase5-evidence/completion-provider-check.json).

## Final verification

| Check | Result | Evidence |
| --- | --- | --- |
| Node regression and signer integration | 196 passed | [log](phase5-evidence/completion-node-tests.txt) |
| Original Rust wallet | 4 passed | [log](phase5-evidence/completion-rust.txt) |
| Rust watch wallet | 3 passed | [log](phase5-evidence/completion-watch-rust.txt) |
| Rust native signer | 4 passed; 1 expensive test ignored by default | [log](phase5-evidence/completion-signer-rust.txt) |
| Foundry contracts | 52 passed | [log](phase5-evidence/completion-contracts.txt) |
| Wallet browser regression | 12 passed | [log](phase5-evidence/completion-browser-tests.txt) |
| Extension security regression | 13 passed | [log](phase5-evidence/completion-extension-tests.txt) |
| Service and web typechecks | passed | [service](phase5-evidence/completion-service-typecheck.txt), [web](phase5-evidence/completion-web-typecheck.txt) |
| Production wallet build | passed | [log](phase5-evidence/completion-production-build.txt) |

**284 passing tests** across these suites. The expensive native proof/extraction was exercised in the Node portable test and the separate CLI rehearsal; the ignored default Rust test is not counted. The delivery restart test was strengthened to close/reopen its SQLite file and all four delivery tests passed again; these are not counted twice. [Restart log](phase5-evidence/completion-delivery-restart-tests.txt).

A concurrent Rust test build initially encountered a Windows executable lock while the native Node test was running; the serial retry passed, and the failed log is preserved separately. Foundry passed despite a warning about an optional cache write outside the workspace. Browser/extension regressions use local fixtures; they are not a new live OpenSea purchase or refund. Earlier real-browser/history evidence remains separately labeled and preserved.

## Remaining blockers and exact next steps

Final preservation checks found all 284 previously recorded public files/pins unchanged, private credential files unchanged, and all eight historical orders and their broadcast counters unchanged. Both standalone Rust dependency audits matched the original lockfile's registry versions/checksums. Known-secret scans found no matches in changed/nonignored files (11 existing credential patterns and 49 isolated test patterns). These are scoped checks, not a guarantee against every possible secret representation. [Preservation](phase5-evidence/preservation-verification.json), [existing-secret check](phase5-evidence/credential-exposure-check.json), [isolated-secret check](phase5-evidence/completion-isolated-secret-check.json), [native pins](phase5-evidence/native-refund-dependencies.json), [watch pins](phase5-evidence/watch-only-dependencies.json).

1. Reconcile the interrupted original-wallet funding request using retained markers, source history and recipient scans. Do not delete claims or create another request merely because no hash is saved.
2. Obtain a separate signer device and establish exclusive key custody, independently verified approval-key fingerprints and restricted transfer media. The current same-user development setup cannot demonstrate this boundary.
3. Obtain usable independent testnet evidence, or operate a separate validating node. Verify actual payment inclusion and at least ten confirmations on fresh disposable funds.
4. Implement and verify unsigned PCZT construction/export from actual watch-wallet notes and wire canonical transaction storage, exact-byte broadcast and confirmation/reorg reconciliation into the real refund state machine. The simulated delivery tests do not complete that integration.
5. On a fresh order, validate an eligible controlled execution failure, user/operator authorization and separate-device review. Obtain explicit approval of the exact refund before broadcasting. Verify ten confirmations, exact destination receipt, restart recovery, duplicate rejection and permanent execution prevention.
6. Complete or defer the full twenty-state purchase integration, seed-only restoration proof, market-reference payable intents, real failed/refunded checkout flow and positive live OpenSea URL-import demonstration. Current market data remains a reference alongside the existing fixed testnet terms.

## Demonstration scope

Ready: local checkout/security demonstrations, historical Phase 0–4E evidence, real read-only testnet scans, and clearly labeled synthetic portable refund signing/recovery. **Not ready:** a new paid end-to-end Phase 5 refund demonstration. No production bridge, mainnet spending, real asset exchange or independent-consensus claim is supported. Keep live refund signing and broadcasting disabled until the documented gates pass.
