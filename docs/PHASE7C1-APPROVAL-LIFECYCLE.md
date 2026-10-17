# Phase 7C.1 approval lifecycle

Economic review, quote age, blockhash validity and exact approval are separate gates. The original shielded payment authorizes only the original order. A preparation grant binds its original recipient, pair, input limit, minimum output, 1% slippage cap and pinned pool/program; it does not authorize signing.

## Review before obtaining a blockhash

The preparation-only operator tool has only `terms`, `ready` and `rehearsal` commands. It overrides execution and network submission with unconditional errors and imports no account-unlock implementation.

For a later explicitly reviewed durable recovery, run `terms --review-unsigned-rpc`. This narrowly reviews the known unsigned RPC failure against the existing two-hour preparation grant; it cannot extend that grant. `terms` persists a digest of the immutable original economic terms for at most 30 minutes without fetching a blockhash. It does not alter the original payment or order deadline.

```powershell
# No signing/broadcast commands exist in this tool.
node --import tsx scripts/phase7c1.ts terms --review-unsigned-rpc
# Only after reviewing those terms and being ready to review exact bytes:
node --import tsx scripts/phase7c1.ts ready <terms-digest>
```

The live order was deliberately left recovery-required in Phase 7C.1. The real rehearsal uses a consistent isolated journal backup, so it does not create a live approval candidate. Do not approve a rehearsal digest for execution.

## Exact preparation

After readiness, validate the economic-review digest and fresh native confirmed-payment evidence. Fetch current validated pool state, enforce the original amount/minimum/slippage and account/inventory/rent limits, and only then fetch a current blockhash. Compile canonical instructions, estimate fees, verify blockhash validity and simulate those exact bytes with `replaceRecentBlockhash:false` and no signature verification. Recheck validity after simulation and require at least 100 remaining block heights before presenting bytes. This is a minimum preparation margin, not an extension or a guaranteed human review duration.

Quote age starts when reserves are read, before account validation, fee reads and simulation. These operations cannot reset or extend the 90-second quote lifetime. Application exact approval has a separate five-minute ceiling, clipped by the preparation grant; it never extends the quote or blockhash. The earliest expired gate wins. Expected output must meet the original minimum; a changed price that requires a higher minimum to preserve the original slippage bound stops for new economic authorization rather than silently changing terms.

Only a separate, later explicit approval of the exact new digest can reach the existing execution gate. This phase does not request or record one. The existing execution path independently rechecks quote, application approval, chain blockhash, original payment/binding and execution/refund exclusions before unlocking or signing.

## Expiry and recovery

Late approval is rejected. Expired unsigned bytes are archived only after proving there is no signing claim, signed wire or signature; old records remain auditable. The payment remains attached to the same order. New bytes require a different digest and a new exact approval. No previous human response authorizes their replacement.

An available quote cannot revive an invalid blockhash, and a valid blockhash cannot revive an expired quote or approval. There is no way to guarantee an arbitrary chat round trip within recent-blockhash validity. The existing local interactive `READY` then `APPROVE <digest>` workflow supports prompt exact review in a future separately authorized execution phase. Economic review alone is never a spending authorization. Durable nonce transactions or approval of an economic envelope for automatic signing are not implemented or implied.

Atomic preparation/execution claims prevent parallel attempts. Signed or uncertain submissions require original-signature reconciliation, never a new swap. A completed execution cannot enter refund recovery. Original payment identity cannot authorize a different order. The live refund switch remains false.

## Validation scope

Synthetic regression coverage includes primary timeout, secondary failover, wrong cluster, provider disagreement/stale context, pool-owner and program validation, liquidity/slippage changes, quote/blockhash/approval expiry, changed digests/recipient/mints, concurrent and duplicate recovery, restart reconciliation, lost submission response and completed execution. Synthetic signing tests use disposable credentials; there is no live signing in this phase. Real-chain evidence is explicitly limited to watch-only reconciliation, pool reads and unsigned simulation.

See [RPC reliability and real evidence](PHASE7C1-RPC-RELIABILITY.md). Phase 7C is not complete; Phase 8 is not started.
