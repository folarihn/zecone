# Phase 5 lifecycle and recovery

Status: the lifecycle and refund-authorization components are implemented and locally tested. Native shielded refunds and their live reconciliation are disabled. No historical settled order was rewritten or assigned a fabricated lifecycle history.

Continuation: [isolated native signing](PHASE5-NATIVE-REFUNDS.md) now saves genuine signed Ironwood PCZTs in its signer-owned journal. `SIGNED` in that private development journal does not advance a backend order to `REFUNDED`. Interrupted native signing claims and per-note claims are never cleared automatically; saved output is retrieved through `recover(id)`. Broadcast and live reconciliation remain disabled.

## State graph

Every transition in `services/settlement/lifecycle.ts` compares the expected version and records its previous/next state, timestamp and bounded reason code in SQLite. State and event writes are atomic. The intent digest is immutable. The legacy eight-state purchase workflow remains active; the complete twenty-state graph is not yet the universal purchase orchestrator. Explicit refund adoption starts at `RECOVERY_REQUIRED` and records that adoption rather than inventing earlier events.

| State | Permitted next states |
|---|---|
| CREATED | QUOTED |
| QUOTED | USER_APPROVED, RECOVERY_REQUIRED |
| USER_APPROVED | AWAITING_PAYMENT, RECOVERY_REQUIRED |
| AWAITING_PAYMENT | PAYMENT_DETECTED, RECOVERY_REQUIRED |
| PAYMENT_DETECTED | CONFIRMING, RECOVERY_REQUIRED |
| CONFIRMING | PAYMENT_CONFIRMED, RECOVERY_REQUIRED |
| PAYMENT_CONFIRMED | LIQUIDITY_RESERVED, RECOVERY_REQUIRED |
| LIQUIDITY_RESERVED | EXECUTION_READY, RECOVERY_REQUIRED |
| EXECUTION_READY | EXECUTING, RECOVERY_REQUIRED |
| EXECUTING | EXECUTION_UNCERTAIN, COMPLETED, EXECUTION_FAILED |
| EXECUTION_UNCERTAIN | COMPLETED, EXECUTION_FAILED |
| COMPLETED | terminal |
| EXECUTION_FAILED | RECOVERY_REQUIRED |
| RECOVERY_REQUIRED | REFUND_REQUESTED |
| REFUND_REQUESTED | REFUND_APPROVED, RECOVERY_REQUIRED |
| REFUND_APPROVED | REFUND_SIGNING, RECOVERY_REQUIRED |
| REFUND_SIGNING | REFUND_BROADCAST, RECOVERY_REQUIRED |
| REFUND_BROADCAST | REFUND_CONFIRMING, RECOVERY_REQUIRED |
| REFUND_CONFIRMING | REFUNDED, RECOVERY_REQUIRED |
| REFUNDED | terminal |

`REFUND_APPROVED` permanently sets the execution veto. The authorization service currently reaches `REFUND_SIGNING` only to indicate independent review approval; `transactionSigned` remains false. No service marks `REFUND_BROADCAST`, `REFUND_CONFIRMING` or `REFUNDED` from an approval certificate. Those graph edges describe the future verified transport.

## Operator recovery procedure

1. Preserve the database, WAL-safe backup, relevant journals and original identifiers. Keep private evidence outside Git. Do not replace a request UUID to get around an uncertain outcome.
2. Check the exact process identity before touching any stale service lock. A native send/construction marker is not a disposable lock. Never remove it because a timeout occurred.
3. Inspect destination-chain receipts and canonical blocks first. A settled purchase is not refundable. Any existing raw transaction, hash or execution-construction claim excludes refunds in the first version, even if the application says failed/recovery. An incomplete construction claim requires manual investigation, not another signing attempt.
4. Refresh the Zcash scan and require complete, current attribution with at least ten confirmations. Underpayment or an expired order can enter recovery; refund eligibility is actual confirmed receipts, not the quoted amount. Pending additional receipts block approval until all attributed funds are confirmed. Overpayment does not authorize execution of an extra asset.
5. Obtain a user-signed exact refund request with a new, explicitly supplied shielded destination. A shielded sender address cannot be recovered from a public transaction. Obtain the operator certificate, then export the unsigned authorization bundle.
6. On the separate signer, verify independent order/payment evidence, the native destination, exact amount and fee ceiling, and both prior authorizations. Explicitly approve the displayed request digest. Never feed backend fields into an alleged independent reader.
7. **Stop before funded signing.** The native PCZT signer can be exercised using isolated synthetic fixtures. The new watch-only reader has an unfunded real-chain proof and explicitly blocks live signing; there is no validated production deployment, enabled broadcast transport or separate-device funded demonstration. Do not use legacy merchant `send` to bypass this gate. See [watch-only continuation](PHASE5-WATCH-ONLY.md).

Once transport is implemented, signing must persist a durable attempt before key use and persist signed bytes/hash before broadcasting. An unknown broadcast outcome must reconcile that same hash before any resend; never construct a replacement on timeout. Only canonical chain inclusion and ten refund confirmations, corroborated by wallet history, may produce `REFUNDED`. These steps are requirements, not existing live capabilities.

## Specific failures

| Condition | Current safe response |
|---|---|
| Duplicate same refund request | Return existing request; no second order refund |
| Changed request or second ID for same order | Reject |
| User/operator/signer signature mismatch | Reject |
| Invalid/mainnet/transparent destination | Reject native validation |
| Fee ceiling consumes receipts or integer overflow | Reject |
| Reorg/stale evidence after approval | RECOVERY_REQUIRED; retain execution veto |
| Crash during signer approval | Retain claim; require reconciliation |
| Crash during EVM construction | Retain construction claim; no re-sign/refund |
| Saved EVM transaction pending/unknown | Reconcile receipt; refund refused |
| Refund request expired | Review/reconcile; no automatic replacement or veto removal |
| Lost encrypted-keystore password | Restore a separately verified backup/password; no reset bypass |

## Backups and restoration limits

The initial checkpoint is `.secrets/phase5-checkpoint`, containing 26 preserved private files and six consistent SQLite online backups. Its private manifest contains hashes; do not publish it. Public preservation reports expose counts and prior public-file hashes only. Keep this checkpoint encrypted on a separate controlled device before relying on it as disaster recovery. It remains readable by the current Windows user.

The tested encryption-copy round trip preserves an isolated source and leaves activation separate. A partial destination must never overwrite the original; investigate it and use a new explicit destination if retrying. No funded wallet migration or seed-only restoration has been demonstrated. Retain wallet databases, birth height, account derivation records and send journals as well as seeds. Do not restore stale journals over a running wallet and assume no transactions occurred afterward.
