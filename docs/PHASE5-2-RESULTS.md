# Phase 5.2 results

2026-10-15. Starting checkpoint: `fec8341`. **Partial completion: a real shielded payment is confirmed, the test order is in recovery, and a real-note unsigned refund has passed independent effects verification. No live refund has been signed or broadcast. Mainnet readiness: NO.**

## Fresh environment

Profile: `99ef6572-b2ba-4d7f-a1fb-1bf333f2cb0b`. All three roles use newly generated OS-random seeds, new databases and the separate `zecone-phase52:` transaction namespace. No original wallet key, database or unresolved input was imported or used.

| Role | Shielded Zcash testnet address |
| --- | --- |
| A — payer | `utest1xq4u9pevy3jr9a5tx77h463f4yy4azfqarzgnecnz3hqjc59njlyek7xhgx4ldnfha4vxejvznqqrhxlp4964ul8q3px7wdsrsdv64c9` |
| B — settlement | `utest14vf2nwz2mzlr8skd5lacqv0ytcqxtemsh6zn0nujjhnrhja7xajgenpgg72jfxesz2ltxt6ek9pepgnk3zjlk237df0r63ujzgpntau6` |
| C — refund destination | `utest1qrtu8u43rq6lhcfpzsqmjum8rtfrnk2xfsnhksxjp8gssc637tslpsmyqannfn5t3ccc9lpt6kdaczwts9k7fgsapqqg7c73mgjwyk0a` |

Native decoding verified testnet Unified Addresses with **Orchard receivers only**, no transparent or Sapling receiver. NU7 uses the supported Orchard receiver to construct Ironwood transactions. Wallet B has separate backend and signer watch databases sharing its UFVK. Their default receiving strings differ because the pinned SQLite library chooses a timestamp-based diversifier; identity and birthday, not default address equality, establish that they watch the same account. [Public profile and receiver evidence](phase52-evidence/fresh-wallets.json).

The initial funding request was **0.002 TAZ**, with an estimated minimum of 0.0011 under the one-input fee assumption. The user supplied **0.125 TAZ**. No more funding is required for this prepared refund. Actual fees were checked from the native payment proposal and the unsigned refund.

## Real funding and payment

Funding transaction: **`ca05ae5509ecc794da4c6b63701de5494f5121308f9bbf10c3b3bc58aecb0026`**, 0.125 TAZ, mined at **4,504,045**. It was not treated as mature at the first five-confirmation observation. Preparation required at least ten confirmations and an unspent Ironwood input. [Early funding observation](phase52-evidence/scan-2026-10-15T07-14-18.200Z.json), [29-confirmation observation](phase52-evidence/scan-2026-10-15T07-25-15.990Z.json).

The operator explicitly approved the exact prepared payer-to-B transaction, amount, recipient, fee and expiry before submission.

| Payment property | Actual value |
| --- | --- |
| Transaction ID | `620bdb644efcb47559e98ebf553eab07ea04ad0179b5361cdd549b8f8a2fafac` |
| Amount received by B | 0.001 TAZ / 100,000 zatoshis |
| Network fee | 0.0001 TAZ / 10,000 zatoshis |
| Total debit | 0.0011 TAZ |
| Actual expiry height | 4,504,107 |
| Mined height | 4,504,089 |
| Confirmations at recovery acceptance | 11 |
| Raw transaction | 9,166 bytes, persisted locally before submission |
| Submission count | One durable claim and one submission; no retry |

The provider's returned transaction bytes matched the persisted bytes. Both B scanners then verified the exact payment and its maturity. The initial successful submission response was reported as unconfirmed until these checks passed. [Prepared review](phase52-evidence/prepared-payment.json), [broadcast acknowledgement](phase52-evidence/payment-broadcast-2026-10-15T07-31-02.678Z.json), [transaction lookup](phase52-evidence/payment-status-2026-10-15T07-35-18.950Z.json).

The final scan at 07:54 UTC recorded **49 confirmations** on both B watch databases at tip 4,504,137. C still had no received payment, and live refunds remained disabled. [Final scan](phase52-evidence/scan-2026-10-15T07-54-29.832Z.json).

## Controlled recovery and unsigned refund

The fresh order is `b2f334e8-22ed-4d0d-bcd2-9766e4b4d89e`. Its lifecycle reached **RECOVERY_REQUIRED**, version **7**, with a permanent execution veto. The controlled failure occurred before destination-chain construction: **no failed EVM transaction was submitted**. A new process reconciled the same receipt and retained the same version and veto, without duplicate settlement. [Recovery](phase52-evidence/recovery-2026-10-15T07-35-33.445Z.json), [persisted receipt/transitions](phase52-evidence/recovery-restart-proof.json), [restart reconciliation](phase52-evidence/recovery-2026-10-15T07-53-10.679Z.json).

A watch-only backend exported a genuine PCZT from the real unspent B note. A separately synchronized signer-side watch database and fresh tree-state lookup supplied the native verifier's own input/FVK/anchor evidence. Native verification checked ownership, commitment/witness consistency, ciphertexts, recipient, change, amount, fee, format and expiry.

| Unsigned refund property | Verified value |
| --- | --- |
| Refund to C | 0.0009 TAZ / 90,000 zatoshis |
| Fee | 0.0001 TAZ / 10,000 zatoshis |
| PCZT size | 4,901 bytes |
| PCZT SHA-256 | `430b014672ee9e338e2154ecd02e1fcffba1ce932785530048820781894d0cbf` |
| Expiry height | 4,504,159 |
| Input confirmations at verification | 31 |
| Actual spend signing / broadcasting | **Neither performed** |
| User/operator authorization certificates | Not supplied for this live refund |
| Separate physical device | Not available / not validated |

[Real-note unsigned verification](phase52-evidence/unsigned-refund-2026-10-15T07-45-30.329Z.json). This is an **effects-reviewed draft**, not an authorized signing bundle or a confirmed refund. There is no refund transaction ID to report. C has no verified refund receipt. The point-in-time review and PCZT expiry must not be treated as indefinite authorization.

Private transfer files and a checksum manifest are retained under `.state/phase52/99ef6572-b2ba-4d7f-a1fb-1bf333f2cb0b/transfer`. They contain private note/witness data and must not be published. See [portable handling instructions](PHASE5-2-RUNBOOK.md).

## Infrastructure, dependencies and preservation

The active provider verified test-chain identity and NU7 branch `77190ad9`. ECC and ZEC.PRO supplied no usable independent evidence from this machine. All successful wallet scans share zec.rocks. **Independent-provider/consensus verification is not established.** [Probe report](phase52-evidence/providers-2026-10-15T07-26-32.326Z.json).

No crate version or checksum changed. The watch crate enabled the existing pinned backend PCZT feature, its required SQLite serde/transparent-input support, and the same pinned primitives dependency for runtime use. The lockfile added eleven dependency edges only. The runtime export accepts the dedicated new B wallet, requires its recovery veto and exact confirmed input, and rejects every non-Ironwood bundle. The unchanged original wallet dependency manifests/lock remain preserved.

Preservation checks cover **19,946 historical private files**, **393 historical public files**, fourteen private database-file snapshots and dependency pins. No historical wallet/database/credential/evidence changes were found. The old 0.002 TAZ attempt remains quarantined; no old wallet API was opened, marker cleared, input reused or assumption of expiry made. [Baseline](phase52-evidence/preservation-baseline.json), [final preservation](phase52-evidence/preservation-final.json), [new credential boundary audit](phase52-evidence/credential-boundary-audit.json).

## Tests and limitations

Final suite totals: **306 passing tests** — Node 213, wallet Rust 8, watch Rust 4, native signer Rust 4, Foundry 52, wallet browser 12, extension 13. Both TypeScript checks and the production build passed.

[Node](phase52-evidence/node-tests.txt), [wallet Rust](phase52-evidence/rust-wallet.txt), [watch Rust](phase52-evidence/rust-watch.txt), [native signer Rust](phase52-evidence/rust-signer.txt), [Foundry](phase52-evidence/contracts.txt), [browser](phase52-evidence/browser-tests.txt), [extension](phase52-evidence/extension-tests.txt), [service typecheck](phase52-evidence/typecheck.txt), [web typecheck](phase52-evidence/typecheck-web.txt), [build](phase52-evidence/production-build.txt).

Coverage includes construction interruption/missing IDs, expiry, wrong effects/approval, duplicate submission claims, refund/execution races, stale/disagreeing scans, reorganization, restart and native signer rejection. Existing refund-signing/proving tests use disposable **synthetic** notes; the real B note was reviewed but never signed. One expensive Rust proof test remains ignored by default and is not counted; the Node suite exercises synthetic proof/extraction.

An initial baseline signer build encountered a Windows executable lock while Node tests ran; the serial retry passed. A sandbox production build failed with EPERM and its approved rerun passed. Provisioning initially rejected legitimate diversified addresses; the corrected identity check completed the same profile without recreating keys. A read-only recovery reconciliation was rejected once; the subsequent fresh scan/restart check passed with unchanged state. These events did not trigger transaction retries or claim deletion.

**Remaining gates:** validated exclusive signer custody on a separate device, complete user/operator authorization, a validated live signing deployment path, and exact refund broadcast/confirmation integration. The current review-only package must not be sent to the synthetic-only CLI as a live signing request. Production refunds remain disabled. Full Phase 5 / end-to-end refund completion is not claimed.
