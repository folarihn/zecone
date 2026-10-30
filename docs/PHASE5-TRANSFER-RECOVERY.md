# Phase 5.1 transfer recovery

2026-10-15. Starting checkpoint: `6975598`. **Interrupted transfer classification: 7 — still uncertain. Replacement safety has not been established. No replacement was prepared or broadcast.**

## Request and observed facts

The request is `bcb86911-fb11-44e5-9f76-cbfaa713091f`: **0.002 TAZ** (200,000 zatoshis), fee cap **0.0001 TAZ** (10,000 zatoshis), on Zcash testnet. The stored marker matches its account, destination and amount. The native offline decoder verified a shielded testnet address. The complete public destination is in the [latest investigation report](phase51-evidence/investigation-2026-10-15T06-40-58.201Z.json).

| Evidence | Observation |
| --- | --- |
| Construction marker | Created 2026-10-13 16:38:27 UTC; 195 bytes; retained unchanged |
| Process lock | Retained; recorded PID 11396 is absent at investigation time |
| Saved request transaction reference | Absent |
| Matching outgoing recipient/amount records | Zero |
| Source transaction history | Ten transactions; newest created 2026-10-13 08:34:05 UTC, before this attempt |
| Source pending history | One old unmined transaction with expiry 4,491,367; unrelated to this request |
| Source cached scan | 4,498,492; not presented as current chain state |
| Source stored unspent Ironwood notes | Two, totaling 13,377,500 zatoshis; no recorded Ironwood locks |
| Current disposable payer scan | 4,503,971; zero payments |
| Current disposable receiver/refund-signer scan | 4,503,971; zero payments |
| Original request expiry / input selection / raw transaction | Not recovered |
| Original proving/broadcast log | No request-specific persisted log recovered |

Both disposable scans agree on block hash `000015b0cf3df9864762d1ae2895e25d2f7aa26f9c425c3972c22e381f6ab341`. The latest report was recorded at **2026-10-15 06:40:58 UTC (07:40:58 WAT)**. These scans use the same provider. The source database was opened read-only, and its hash plus the marker/lock hashes matched before and after investigation. Existing wallets were not unlocked or manually edited.

The stored source note total is **not a fresh spendable balance or a replacement proposal**. It does not identify which inputs the interrupted proposal selected. No pending hash was invented, and the older expired transaction was not attributed to this request.

An initial scan attempt returned no usable snapshot. Its [separate report](phase51-evidence/investigation-2026-10-15T06-39-10.937Z.json) remains retained. A direct native retry and the subsequent full investigation succeeded. Failure of a scan was never interpreted as absence of payment.

## Construction and broadcast analysis

The inspected native sequence is:

1. Synchronize and create an unsigned proposal; check amount, destination and fee.
2. Write the exclusive construction marker and flush it to disk.
3. Call pinned `create_proposed_transactions`, which constructs/proves and stores outgoing transactions before returning.
4. Retrieve and serialize the transaction, then write/flush the request reference.
5. Call `send_transaction`.

There is no matching stored outgoing transaction and no reference from steps 3–4. This supports an interruption during construction. It does **not** independently prove that a transaction was never constructed or broadcast: the surviving marker has no txid, expiry or selected-input record, and the original process output is unavailable.

The pinned builder normally derives expiry from the proposal target plus its default delta; a default or elapsed wall time is not the recovered transaction's actual expiry. Even though thousands of blocks have elapsed, this checkpoint does not assert “expired and conclusively unmined.” No expiry was copied from an unrelated transaction.

Source references: [native send implementation](../services/zcash/src/main.rs), installed `zcash_client_backend=0.25.0-pre.1` `data_api/wallet.rs` construction/storage sequence, and the preserved lockfiles. No NU7 pins were changed.

## Recovery protection added

The native send path now refuses a **new request ID** while any construction marker lacks a matching persisted transaction reference. A reference must parse and match the original account, recipient and amount. Repeated checks preserve the marker. This closes a bypass where a caller could evade the old per-request check with another UUID.

The read-only assessment also keeps replacement/broadcast authorization false for missing hashes, rejection, pending transactions, provider absence, elapsed expiry, stale scans, mismatched destinations and reorganizations. A same-amount deposit without source linkage is labeled unattributed, not proof that this interrupted request succeeded. Assessment is a reporting tool, not an alternative transaction API.

No claim-clearing or recovery override was introduced. Existing exact persisted transaction reconciliation remains separate and requires its existing explicit broadcast flag; it was not invoked.

## Independent infrastructure

The [public provider probes](phase51-evidence/providers-2026-10-15T06-38-11.053Z.json) verified zec.rocks test-chain identity, branch `77190ad9`, block hash and Ironwood root at common height 4,498,492; its observed tip was 4,503,966.

ECC and ZEC.PRO returned connection/protocol failures from this machine. ZEC.PRO's operator publishes its testnet endpoint on [its own services page](https://zec.pro/); ECC's URL appears in [maintained Zingolib configuration](https://docs.rs/zingolib/latest/src/zingolib/config.rs.html). Published configuration is not an availability guarantee. Only these reviewed HTTPS endpoints were added for public metadata probing; the wallet scanner still uses its existing provider.

No independent-provider agreement, second-provider wallet scan, or original-transaction inclusion/absence proof was obtained. Different published operator names alone would not establish distinct upstream validating nodes. A separately operated validating testnet node/lightwalletd is the documented alternative; [official lightwalletd setup](https://github.com/zcash/lightwalletd).

## Reproduce safely

From the repository root, using the existing private local configuration:

```powershell
cargo build --locked --manifest-path services/zcash/Cargo.toml
cargo build --locked --manifest-path services/zcash-watch/Cargo.toml --target-dir target
node --import tsx scripts/phase51-investigate.ts
node --import tsx scripts/phase51-providers.ts
node scripts/phase51-audit.mjs
```

Each investigation/probe writes a new dated report under `docs/phase51-evidence`; prior Phase 5 evidence is preserved. These commands do not sign, broadcast, remove markers, import spending keys or write the source wallet database. Native watch synchronization updates only the disposable watch databases through the supported scanner. New reports are observations at their recorded time, not perpetual settlement evidence.

**Next recovery action:** recover the original transaction bytes/reference, actual expiry and selected-input evidence from original process output or a verified backup if available, then reconcile inclusion/absence and input state. Current evidence cannot substitute for these records. Retain the markers while this remains unresolved. Once replacement is proven safe, prepare exact network/address/amount/fee/expiry and obtain explicit approval before any broadcast. Additional approval alone does not resolve uncertainty about the original attempt.
