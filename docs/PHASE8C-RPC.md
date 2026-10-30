# Phase 8C — RPC evidence reliability and confidence

Checkpoint: `e66ac6c`. Testnet infrastructure only. No new payment, live key unlock, signing, transaction submission or refund activation. Confidence is observation metadata, never financial authorization.

## Current paths and scope

The existing Solana `Devnet` client pins the devnet genesis, bounds reads with deadlines and retry/backoff, permits read failover, and checks pool-account snapshots for contradictions. Its selected provider can change on read failure. Two configured pool URLs were never proof of independent operation. Pool snapshots are mutable and can differ across slots; their existing conservative disagreement veto is retained. The old status-only `corroborate()` helper is not an independent finalized-effects verifier and is not used by the new confidence path.

Existing Solana settlement persists signed bytes/signature before its sole submission, records execution/broadcast claims, and reconciles by original signature after uncertainty. The new code does not change those blocks. Default `receipt()` retains the bounded SDK read path. New `receiptEvidence()` performs explicit, read-only confidence verification. With required corroboration configured, `receipt()` accepts only corroborated evidence from that verifier. A verification failure leaves reconciliation pending; it cannot initiate a replacement. Original completed journals are not upgraded or rewritten to assert a stronger historical confidence.

Existing EVM adapters pin the allowed chain ID, check fresh head health, enforce gas limits, and verify receipt canonical block identity and configured confirmation depth. `receiptEvidence()` adds compatible evidence confidence. With required corroboration enabled, `receipt()` verifies that policy first and formats that same checked raw receipt through the installed viem formatter. Preparation, gas/economic bounds and submission remain unchanged. Legacy EVM execution classes outside `EvmAdapter` remain single-provider paths; this is not a retrofit of every historical worker.

Balance reads, inventory, quotes, simulations, mutable pool state, old browser read proxies, legacy EVM workers and Zcash light-client scanning retain their existing provider model. A corroborated destination receipt does **not** imply those operations were independently verified. No new browser route exposes raw evidence or RPC configuration.

## Confidence result

Every new result pairs the checked primary evidence with a finite confidence record:

- `PRIMARY_ONLY`: complete required evidence from the configured primary; no secondary configured.
- `DEGRADED`: primary evidence missing, secondary absent/unavailable/pruned/insufficiently finalized, or independence not established. An unavailable primary is not silently replaced with secondary evidence.
- `CORROBORATED`: two complete, compatible observations agree on material evidence, and configuration explicitly asserts distinct operators.
- `CONFLICTED`: wrong network, invalid evidence, or material disagreement between compatible observations. Returned evidence is null.

`scope` is `SOLANA_FINALIZED_TRANSACTION` or `EVM_CANONICAL_DEPTH_RECEIPT`. `providersChecked` counts complete evidence observations, not merely successful HTTP calls. `providerOutcomes` gives finite classifications without URLs, headers, raw exceptions, account lists or payment data. Missing or late evidence is not agreement. Confidence is fresh per call, not cached as execution authority. Errors and contradictions cannot clear signing claims or authorize retry spending.

`EvidenceReader.assertAccepted()` rejects absent/conflicted evidence and rejects any non-corroborated mode when `requireCorroboration` is true. Operators using the separate reporting API must apply their policy before relying on it; the report alone grants no authority. An RPC failure is not evidence of transaction absence or permission to resend.

## Compared evidence

Solana checks genesis, finalized `getTransaction`, history-aware signature status, matching status/transaction slot and error, a finalized head at/after that slot, and finalized block context (blockhash, parent slot, previous blockhash). It compares signature set, transaction version and full message, error, fee, native pre/post balances, token account index/owner/mint/program/raw amount/decimals, loaded addresses and inner instructions. UI token formatting and current head values are not compared. Unsafe integer values and malformed required fields fail closed. A missing/pruned transaction or block, lagging head or not-yet-finalized status is unavailable evidence rather than a fabricated contradiction.

Different finalized **transaction slots** are material disagreement. Different current finalized **head slots** alone are expected observation-time differences. A receipt's token effects are historical transaction deltas; the verifier does not fetch today's wallet history or mistake current balances for the original delivery. Existing settlement message/economic-effect validation still determines whether those effects satisfy an authorized order.

EVM checks allowed chain ID, receipt transaction hash/status/block identity, canonical block number/hash, transaction index, from/to/created address, gas used/effective gas price and material logs (address/topics/data/index). Each provider must independently meet the registry confirmation threshold. Different current head heights and confirmation counts are not compared for equality. A lagging provider cannot corroborate yet. This is canonical **depth confirmation**, not independent proof of Ethereum consensus finality or L2 settlement on L1; no stronger rollup/L1 or arbitrary-contract economic guarantee is claimed. Chain-specific optional fee extensions are not part of the standard receipt scope.

Read protocol references: [Solana getTransaction](https://solana.com/docs/rpc/http/gettransaction), [signature statuses](https://solana.com/docs/rpc/http/getsignaturestatuses), [getBlock](https://solana.com/docs/rpc/http/getblock), and [Ethereum JSON-RPC](https://ethereum.org/developers/docs/apis/json-rpc/). Installed SDKs and versions are unchanged.

## Configuration and independence

Only trusted local operator configuration may choose endpoints. HTTPS is required; URL userinfo/fragments are rejected. Query/path API credentials may be configured locally and are never returned in confidence reports. No endpoint or plan is purchased/enabled automatically.

Solana uses these environment names:

```text
ZECONE_SOLANA_RPC_PRIMARY
ZECONE_SOLANA_RPC_SECONDARY
ZECONE_SOLANA_RPC_PRIMARY_OPERATOR
ZECONE_SOLANA_RPC_SECONDARY_OPERATOR
ZECONE_SOLANA_RPC_INDEPENDENT=1
ZECONE_SOLANA_RPC_REQUIRE_CORROBORATION=1
```

EVM uses the same suffixes under `ZECONE_EVM_<chainId>_RPC`, for IDs 84532, 11155111 and 46630 only. Reporting defaults to the existing registry endpoints; Solana defaults to `https://api.devnet.solana.com`. EVM verification configuration does not redirect preparation or broadcasting. No mainnet entry was added. A trusted local library caller can also supply `VerificationConfig` directly.

Boolean environment flags accept only `0`, `1` or absence. Other values fail configuration validation instead of silently disabling a required policy. Direct configuration flags must be booleans.

Operator labels must be distinct lower-case identifiers (1–60 characters, letters/digits/hyphens), hostnames must differ, and `INDEPENDENT=1` must acknowledge actual operational independence. Duplicate operators, two paths on one host, missing labels or missing acknowledgement never produce `CORROBORATED`, even if data agrees. Contradictory responses still conflict regardless of operator labels.

This is an operator assertion, **not automatic discovery or cryptographic proof of infrastructure independence**. Different hostnames may alias one vendor or upstream node. Verify ownership, upstream dependence and archival support before setting the acknowledgement. No independent secondary was configured for this phase; synthetic two-operator tests are not live independent verification.

The read-only transport permits only the required receipt/status/block/genesis/head methods; it has no transaction-send, signing, balance-history or wallet-key operation. Each request has an 8-second default timeout (maximum 20 seconds), at most two attempts, 100 ms backoff, redirects disabled and a 2 MiB response limit. Abort plus a timeout race bounds uncooperative operations. Access-denied/oversized responses stop without retry. Requests are bounded per evidence call, not a background poller or fanout of wallet history.

## Live read results and privacy

See `docs/phase8c-evidence/live-confidence.json` for current results and finite provider outcomes. The audit reads only destination references from fixed local historical evidence/journals and emits no reference, recipient, order ID or source-payment join. No new financial operation occurs. Existing protected evidence containing older joins is not rewritten or republished.

The operator still possesses cross-chain correlation records. RPCs learn client IP/timing and queried public destination transactions, which reveal public recipient/token effects. A secondary expands that exposure. Confidence reporting omits those joins and credentials, but does not anonymize Solana/EVM ownership, prevent timing analysis, independently run consensus, or remove trust in RPC operators. Keys, viewing authority and Zcash payment IDs are never sent to destination RPCs by this verifier.

Live refunds stay disabled. Stop after Phase 8C; Phase 8D requires separate authorization.
