# Phase 7C.1 RPC reliability — implementation and unsigned validation

The original paid order is preserved. Its full cross-chain association stays in the restricted local journal, not this document. No new Zcash payment, live signing, broadcast, key unlock or refund is performed in this phase. Phase 7C remains incomplete.

## Diagnosis and evidence

The historical failure occurred in the SDK `getMultipleAccounts` request before local pool decoding. The old adapter discarded the underlying exception after three retries and emitted only `RPC_UNAVAILABLE`. There is no retained HTTP status or transport cause from that attempt. It would be unsupported to label it a proven rate limit, timeout, invalid pool or cluster outage.

Read-only reproduction now returns HTTP 200, nine accounts and approximately 999 KB of public pool/program data; the SDK validates the pool, owners, token layouts, program-data hash and upgrade metadata. See [diagnosis](phase7c-evidence/rpc-diagnosis.json). The failure is intermittent and its exact historical transport cause is unrecoverable from the old logs. New diagnostics distinguish timeout, HTTP rate limit/access/server/client failures and transport/RPC response errors without printing raw exception text.

## Adapter changes

- HTTPS primary and optional secondary configured by `ZECONE_SOLANA_RPC_PRIMARY` and `ZECONE_SOLANA_RPC_SECONDARY`. The default primary is `https://api.devnet.solana.com`. There is no implicit secondary, subscription, purchased upgrade or network fallback.
- Each request group has a ten-second timeout, abort signal, enforced deadline, at most three attempts per provider, exponential 750/1500 ms backoff and 350 ms operation pacing. Reads serialize per adapter. Transport operations remain scoped to the selected provider even if a timed-out promise completes late.
- Full devnet genesis must match `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`. Successful checks are cached for at most 30 seconds; failures and network mismatches cannot approve data. Health reads include current confirmed slot and block height.
- Pool/config/vault/mint/program accounts are read together at finalized commitment with a monotonic `minContextSlot`. Local owner/layout/mint/reserve/program-hash checks remain mandatory. No account from a partial failed response is merged into another snapshot.
- When both providers respond, complete account snapshots must match. Contradictions or context regressions stop for reconciliation. A moving pool can cause a conservative refusal across different finalized slots; the operator must repeat reads after convergence rather than select a preferred price. An unavailable corroborator is explicitly recorded as degraded single-provider evidence, not independent agreement.
- Exact blockhash, fee and simulation checks do not silently fail over. A failed exact preparation can be retried unsigned; it does not create an approval or automatically execute.

Primary validation succeeded live. No secondary endpoint/credential is configured in this environment, so live secondary identity, availability and corroboration remain **unvalidated**. Synthetic providers exercise timeout, failover, wrong genesis, stale context and disagreement. Configure an independently operated devnet HTTPS endpoint locally before relying on redundancy; never paste provider credentials into public reports.

## Existing-order recovery

Independent signer and recipient-token-account histories, account existence and the journal show no signature, signed bytes, submission claim or delivery for this order. A fresh watch-only scan retains its original confirmed 100000-zatoshi payment.

`reviewUnsignedRpcRecovery` accepts only the exact existing preparation grant/attempt, original payment/authorization and immutable intent. It independently reconciles devnet before an atomic state change. Only the known unsigned `RPC_UNAVAILABLE` preparation failure plus the original expired-payment reason can be reviewed. Other recovery reasons, changed bindings, refunds, execution claims, signed bytes, receipts, expired grants and concurrent attempts remain vetoes. Reasons and old approvals are retained; neither deadline nor grant scope is extended. No exact execution approval is created.

New transient failures during a proven unsigned `PREPARING` claim release only that claim back to awaiting review, recording the reason. They never retry execution. Interrupted preparation still becomes recovery-required on restart. No signed/uncertain attempt receives this treatment.

The real recovery rehearsal uses SQLite's consistent backup of the original order and fresh native watch-only evidence. Its preparation-only recovery and simulation run in that backup. It is **not a new paid order or a live reopened settlement**. The original journal stays `RECOVERY_REQUIRED`. The evidence explicitly labels this boundary: [unsigned rehearsal](phase7c-evidence/rpc-rehearsal.json).

## Privacy and reproducibility

RPC diagnostics contain provider indexes, attempt counts and bounded error categories. They exclude endpoint URLs, credentials, raw exception messages, request arguments, Zcash transaction identifiers, viewing/spending keys and payment-to-recipient joins. Pool corroboration queries only the fixed public route. Whole-wallet token inventory and recovery history reads do not automatically fan out to secondary providers. Recovery queries remain necessary operator-only checks of the selected relayer and recipient ATA; they are not anonymity proofs.

Solana RPC still sees client IP/timing, queried public accounts and the unsigned transaction during simulation. The trusted relayer and public token delivery permit timing/amount correlation. The same-OS development credentials and unchanged historical source key are not hardware isolation. No anonymity claim is made.

```powershell
node --import tsx scripts/phase7c-recovery-audit.ts
node --import tsx scripts/phase7c1-diagnose.ts
node --import tsx scripts/phase7c1.ts rehearsal
node scripts/phase7c-preserve.mjs
```

Sources: [Solana clusters and public endpoint limits](https://solana.com/docs/references/clusters), [consistent multi-account reads and minContextSlot](https://solana.com/docs/rpc/http/getmultipleaccounts), [blockhash validity](https://solana.com/docs/rpc/http/isblockhashvalid). These describe protocol/API behavior; they do not establish the historical transport cause.

## Validation results

427 tests pass: 302 Node, 25 wallet UI, 17 installed extension, 6 historical read-only UI, 3 real isolated-backend API, 3 real swap API/UI, 52 Solidity, 10 Rust wallet, 5 Rust watch and 4 offline signer. Both typechecks, lint and the final production build pass. One pre-existing standalone expensive signer proof remains ignored; Node integration exercises native proof/signing with isolated fixtures. A final focused transport run also passes all eight tests, including malformed-URL diagnostic redaction. Initial focused runs inside the network sandbox hit localhost `EACCES`; the full permitted regression runs pass without relaxing assertions.

Evidence: [full Node](phase7c-evidence/rpc-node-complete.txt), [transport](phase7c-evidence/rpc-transport-final.txt), [wallet UI](phase7c-evidence/rpc-ui.txt), [extension](phase7c-evidence/rpc-extension.txt), [historical UI](phase7c-evidence/rpc-historical-ui.txt), [real API](phase7c-evidence/rpc-real-api.txt), [swap API/UI](phase7c-evidence/rpc-real-swap-ui.txt), [contracts](phase7c-evidence/rpc-contracts.txt), [Rust wallet](phase7c-evidence/rpc-rust-wallet.txt), [watch](phase7c-evidence/rpc-rust-watch.txt), [signer](phase7c-evidence/rpc-rust-signer.txt), [backend types](phase7c-evidence/rpc-types-final.txt), [web types](phase7c-evidence/rpc-types-web-final.txt), [lint](phase7c-evidence/rpc-lint-final.txt), [production build](phase7c-evidence/rpc-build-final.txt), [final independent reconciliation](phase7c-evidence/rpc-final-audit.txt), [real unsigned rehearsal](phase7c-evidence/rpc-live-rehearsal-final.txt), [preservation](phase7c-evidence/preservation.json).

All 537 historical and 91 Phase 7B file hashes remain unchanged. The implementation does not edit wallet credentials, the original transfer or refund activation. Browser captures are kept in the gitignored local Phase 7C evidence archive to minimize republication of historical account details. Public reports omit the current payment-to-recipient association and full unsigned wire.
