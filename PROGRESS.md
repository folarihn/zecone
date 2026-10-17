# ZecOne progress

## 17 October 2026 — Authorized recovery preparation (separate transaction approval required)

Continues `3614d67`. The human explicitly authorized **preparing recovery of the existing paid Phase 7C order only**. A two-hour `PREPARATION_ONLY` grant binds its exact persisted order, attempt UUID, original intent, recipient, token pair, input/minimum/slippage/fee limits and original confirmed payment/authorization. Registration rechecked native owned-note evidence, original unsigned transaction instructions, independent devnet signer/recipient-token-account histories, and absence of signing, settlement and refund claims. No new order or payment was created.

Only that Solana row was reopened for preparation. The general order remains auditable as `recovery`; its original deadline, intent, payment association and old recovery/approval history remain unchanged. Expired unsigned reviews were archived without overwriting expired approval records. A repeated registration cannot extend the grant or unlock another order. Changed evidence, unrelated recovery reasons, claims, prior signatures or refund vetoes fail closed.

Preparing does not unlock keys or create an execution approval. A later separately approved exact digest requires its own scoped authorization, consumed atomically with the signing claim. An old digest cannot carry to refreshed bytes. Fresh quotes retain the original minimum and at most 1% slippage; a price change requiring a different minimum stops for economic authorization. The final live preparation is deliberately deferred until after validation, with measured outcome in [authorized preparation evidence](docs/phase7c-evidence/authorized-preparation.json). No signing or broadcast is authorized in this step.

Validation: **416 passing tests** (291 Node, 25 wallet UI, 17 installed-extension, 6 historical read-only UI, 3 real isolated-backend, 3 real swap browser/API, 52 Solidity, 10 Rust wallet, 5 watch, 4 offline signer). One pre-existing expensive standalone proof remains ignored; Node integration exercises native isolated proof/signing. Both typechecks, lint and production build passed. The extension suite had a concurrent-browser synthetic signing timeout; all 17 tests subsequently passed alone with assertions unchanged. Both logs are retained. Preservation checks confirm **537 original + 91 Phase 7B files unchanged**.

The trusted relayer, single RPC provider, public Solana recipient/token activity, timing/amount correlation and existing local development-key limitations remain. Live refunds stay disabled. **Phase 7C is not complete; Phase 8 has not begun.** See [recovery lifecycle and commands](docs/PHASE7C-APPROVAL-RECOVERY.md) and [transaction evidence](docs/PHASE7C-TRANSACTION-EVIDENCE.md).

## 17 October 2026 — Phase 7C approval recovery (partial; live execution blocked)

Continues `4ed111f` and the existing uncommitted Phase 7C checkout. The original fresh shielded payment remains attached to its original order and encrypted user recipient: historical 30-confirmation evidence is retained and the latest receiving scan verifies **933 confirmations**. No second payment was created or resent. Independent devnet signer and recipient-token-account histories, account existence and the durable journal show **zero signing/broadcast claims, no signed wire, no signature and no token delivery** for this swap. Full private payment associations remain gitignored; public logs omit them.

Implemented bounded Raydium devnet CPMM swaps, encrypted new Solana credentials, scoped checkout history, native Phase 7C payment/watch integration and privacy documentation. Recovery now separates the original payment/order deadline, a 30-minute economic review that cannot authorize spending, a 90-second fresh quote, chain-enforced recent-blockhash validity and a five-minute exact-digest approval ceiling. Atomic validation and approval-consumption claims prevent competing attempts; unsigned expiry preserves payment attribution while signed/uncertain claims veto replacement. Local interactive review obtains fresh blockhash bytes only after `READY`, simulates them, and requires `APPROVE <exact-digest>` before unlocking/signing. No expired digest authorizes different bytes.

**Current blocker:** the original order deadline elapsed at **22:35:59 Lagos on 16 October**. A fresh non-broadcast recovery rehearsal correctly stopped in **RECOVERY_REQUIRED**, preserving the order, payment, intent and old reviews. No deadline or recovery veto was reset. Reopening this same paid order requires explicit recovery authorization, separately from any later exact swap broadcast approval. Do not create a replacement profile/order/payment to bypass it.

A separate real-chain unsigned route rehearsal still succeeds: 0.001 WSOL input, 76.043880 test-token estimate, 75.283441 minimum, 1% slippage cap, 5,000-lamport fee estimate and 48,611 compute units. It checks actual pool/program/tokens and relayer inventory; it has **no payment authorization**, signature or broadcast and is not reported as settlement. The output is an arbitrary devnet test token, with no asserted stablecoin value.

Privacy limitations remain: a trusted prefunded relayer, one RPC provider, timing/amount correlation, same-user OS access and the user-selected historical relayer's unchanged plaintext development key. The new recipient uses age encryption with a DPAPI-sealed unlock secret; no hardware or separate-device isolation is claimed. All historical wallet files and the original quarantined transfer remain untouched; refunds remain disabled. Phase 7C is **not complete**; Phase 8 has not begun.

Validation: **405 passing tests** (280 Node, 25 UI, 17 installed-extension, 6 historical read-only UI, 3 real isolated-backend checks, 3 real swap API/UI checks, 52 Solidity, 10 Rust wallet, 5 watch, 4 offline signer). One pre-existing expensive standalone signer proof remains ignored; the Node suite exercises native isolated proof/signing. Both typechecks, scoped lint and production build passed. Preservation verifies **537 original + 91 additional Phase 7B files, zero changes**. A cold browser startup timeout and subsequent one-use pairing failure were retained in logs; the unchanged full six-test historical suite subsequently passed. Exact live finalized swap effects remain untested because execution is blocked.

See [approval recovery and explicit gates](docs/PHASE7C-APPROVAL-RECOVERY.md), [transaction evidence](docs/PHASE7C-TRANSACTION-EVIDENCE.md), [implementation](docs/PHASE7C-SOLANA-SWAP.md) and [privacy limitations](docs/PHASE7C-PRIVACY-AUDIT.md).

## 16 October 2026 — Phase 7B (completed testnet demonstration)

The fresh payer received **0.125 TAZ**. After separate exact user approvals, real shielded payment `ade0250ca587bcfaac6b7e0b3dbcbd479ffe11e97f544235a3f72931ecda7385` delivered **0.001 TAZ** with an actual **0.0001 TAZ** fee and reached **13 confirmations** before Solana execution. One devnet transfer finalized: `3RMoB1C93SfvnwzfdQxKg7jdw4VDP9qkKCKXbrPtDsiaw4AbM3KJz3VcRCvdDKV4irUhUrxZFmtbzNNkaW8xpH4y`. Recipient `HiGp8uCTupsv795g3iqK4Tex1K3hLdNryrZ6sukquRS3` gained **0.001 SOL**; relayer debit **0.001005 SOL** includes the **0.000005 SOL** fee. Full message and finalized per-transaction effects verified; durable order **COMPLETED/settled**. Restart reconciliation passed, duplicate execution was rejected before signer access, one signing/broadcast claim persisted, and completed-delivery refund recovery was vetoed. The original wallet remains quarantined; live refunds remain disabled.

Continues `ee33020`. Moved the rebuildable Rust target cache to D: behind a junction, increasing C: free space from about 2.7 GiB to about 10.3 GiB. No wallet, key, database or evidence was deleted.

Implemented the bounded SOLANA_DEVNET_SOL_DELIVERY adapter using the existing payment Store, native builder, watch-only scanner and Phase 7A Solana policy. Added fresh isolated Zcash profiles, exact fixed-demo quotes, owned-note/ten-confirmation authorization, inventory/fee/recipient checks, operator-only exact signing/broadcast approvals, durable signed bytes and submission claims, original-signature reconciliation, finalized message/balance-effect verification, duplicate protection and recovery/refund exclusion. Integrated terms/status and Solana IDs into the existing wallet and unified checkout. No automatic worker or browser signing/broadcast endpoint was enabled.

Validation: **378 passing tests** (258 Node, 24 UI, 17 extension, 6 historical read-only UI, 3 real isolated-backend checks, 52 Solidity, 9 Rust wallet, 5 watch, 4 signer). The existing standalone expensive proof remains ignored; Node integration exercises isolated native proof/signing. Both typechecks, scoped lint and production build passed. All **537 protected files remain unchanged**.

**Limitations:** fixed demonstration pricing, trusted prefunded inventory, operator-mediated broadcasts, one immutable checkout per isolated profile, no independent RPC/node consensus, and local plaintext development keys under one OS account. The original unresolved transfer remains quarantined; no original-wallet override, synchronization, marker clearing or refund was performed. Synthetic failure tests are labeled separately from the real completed settlement. Source identity of the fresh shielded funding deposit is not inferred.

See [implementation and commands](docs/PHASE7B-SOLANA-SETTLEMENT.md), [real transaction evidence](docs/PHASE7B-TRANSACTION-EVIDENCE.md), and [security/trust limits](docs/PHASE7B-SECURITY.md). Phase 7B is complete within its bounded testnet scope; Phase 7C/8 were not started.

## 16 October 2026 — Phase 7A devnet foundation

Continues `cf2a0ff`. Implemented a separate Solana devnet adapter, isolated disposable accounts, exact SOL/SPL/Token-2022 balance views, bounded legacy SOL/SPL transaction preparation, SDK decoding and instruction/account policy, simulation, local approved signing boundary, durable idempotency/recovery journal and a synthetic-only ZEC destination interface. Added Wallet Standard discovery, origin-scoped connection/account selection and rejection-only browser signing hooks, plus the Solana wallet panel. A separate paired backend uses disposable EVM credentials and the existing rejection-only connector for manual website validation; historical workers remain stopped.

**Verified live, unsigned:** funded payer has 0.1 devnet SOL. Preparing 0.001 SOL to the disposable recipient produced a successful real RPC simulation: 150 compute units, estimated fee 5,000 lamports. No Solana signature or broadcast occurred. SPL construction/policy is fixture-tested; live SPL simulation remains unverified because these accounts have no configured token mint/balance. No new ZEC payment, EVM transaction or refund was broadcast. Live refunds remain disabled.

Validation: **366 passing tests** (248 Node including 18 Solana/backend tests, 23 UI, 17 installed-extension, 6 historical read-only UI, 3 real isolated-backend UI, 52 Solidity, 8 Rust wallet, 5 watch, 4 signer). The existing standalone expensive signer proof remains ignored; the Node integration suite exercises isolated native proof/signing. Both typechecks, scoped lint, extension packaging and production build passed. Preservation: **537 protected files, zero changes**.

**Limitations:** browser Solana signing is deliberately rejection-only; the separate local signer is tested with ephemeral accounts. No live Jupiter/Raydium or new EVM website compatibility is claimed. No live ZEC-funded Solana settlement, swaps or NFT purchase exists. RPC effect consensus, arbitrary transaction import and automatic monitoring remain future work. Phase 7B was not started.

See [implementation and exact evidence](docs/PHASE7A-SOLANA-IMPLEMENTATION.md), [Windows manual dApp workflow](docs/PHASE7A-MANUAL-DAPP-TEST.md), and [security boundaries](docs/PHASE7A-SECURITY.md).

## 15 October 2026 — Phase 6C (PARTIAL)

Continues `19b5778`. Added a separately paired read-only viewer backed by copied real historical SQLite databases and native offline balance calculation. Original wallets, credentials and quarantined records are untouched; no live workers or signers start. Actual read-only EVM balance/NFT/receipt checks and historical mint, marketplace, swap and Seaport UI replay are recorded. Phase 5.2 payment and unsigned refund evidence are preserved; live refunds stay disabled.

Validation: **339 passing tests**, both typechecks, scoped lint and production build. Preservation: 537 protected files, zero changes.

16 October follow-up: regenerated an interrupted disposable export using atomic replacement, refreshed read-only testnet RPC evidence and repeated snapshot QA. Historical wallets and refund evidence remain unchanged.

Fixed duplicate provider listener semantics (extension 0.3.1), guarded legacy personal-sign ordering, explicit unlimited/all-NFT approval warnings, hardcoded checkout progress amount, destination activity labels/links and expired-history text contrast. Added rejection-only dry-run coverage and real-data desktop/narrow/mobile/offline QA. Final validation is documented in [Phase 6C product QA](docs/PHASE6C-PRODUCT-QA.md).

**Not fully complete:** no new live dApp account connection is verified. Chrome is unavailable through the browser connector; both supported computer-use runtimes now fail kernel initialization. The dedicated profile was not modified. [Compatibility matrix/blockers](docs/PHASE6C-LIVE-DAPP-VALIDATION.md). No transactions were broadcast and Phase 7 has not begun.

### Previous checkpoint validation

Validation: **325 passing tests**, both typechecks, scoped lint and production build. Preservation audit: 537 inventoried files, zero changes. Detailed logs and screenshots are linked from the implementation report.

## 15 October 2026 — Phase 6A + 6B

Continues checkpoint `9af83ee`. Implemented dark responsive wallet navigation, real-backend wallet/asset views, unified read-only checkout tracking over existing durable adapters, explicit private payment-address inspection, expired-review and duplicate-click guards, and generic top-level HTTPS EIP-6963 discovery with bounded authenticated RPC reads.

The mint, fixed action, marketplace, controlled Base Sepolia AMM and Seaport execution adapters remain in place. Mainnet OpenSea purchases stay preview-only. Ordinary dApp transactions and restricted ZEC-funded settlement remain distinct. No transaction was broadcast in Phase 6.

Live official wallet entry points were inspected; current-build cross-site ZecOne connection/signing is **not verified** because the exposed in-app browser has no loadable MV3 extension surface. OpenSea Phase 4E remains historical real-site evidence. Zapper's official site reports its August 2026 shutdown. Local installed-extension tests use disposable synthetic sites/signers and must not be described as live marketplace success.

Phase 5.2 is still partially complete: the real 0.001 TAZ payment is confirmed, the 0.0009 TAZ refund remains unsigned/unbroadcast, independent-device validation is unavailable and live refunds remain disabled. Historical keys, databases, payment/recovery markers and evidence are preserved.

See [Phase 6 implementation](docs/PHASE6-IMPLEMENTATION.md), [compatibility evidence](docs/PHASE6-DAPP-COMPATIBILITY.md), [privacy research](docs/EVM-PRIVACY-RESEARCH.md), [Solana roadmap](docs/SOLANA-INTEGRATION-PLAN.md) and [Phase 5.2 results](docs/PHASE5-2-RESULTS.md). Mainnet readiness: **NO**. No Phase 7 implementation started.
