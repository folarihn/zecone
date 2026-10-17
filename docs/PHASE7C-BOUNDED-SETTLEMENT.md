# Phase 7C — explicit one-settlement economic authorization

The human's “Complete the Swap Without Repeated Approval Prompts” instruction explicitly authorizes one existing paid devnet order under exact recipient, pair, input, minimum-output, slippage, relayer, pool/program and fee/rent/debit constraints. This is a **new authorization**, not an interpretation of previous expired exact-digest approvals. The original preparation grant, deadline, payment association and historical approvals remain unchanged.

The operator copies only those public economic constraints to a gitignored `user-bounded-scope.private.json` under `.state/phase7c`. The full order/recipient association is not embedded into public source. The CLI compares every scope field against the original immutable intent. Fresh native payment evidence, original note/payment authorization, absence of signing/refund/settlement claims and independent devnet history/ATA reconciliation must pass before registration. No web endpoint or automatic worker exposes this capability.

`solana_bounded_settlement_authorizations` binds the complete original preparation/payment binding plus economic scope to one order. Its expiry is conservatively clipped to the existing preparation grant; registration is idempotent without extending it. State is `ACTIVE` until atomically consumed with the first signing claim. It is deliberately consumed at signing rather than success: an uncertain or failed signed attempt cannot automatically authorize another transaction.

Each new validated unsigned digest gets an explicit derivation record and a transaction-scoped authorization whose audit source is `BOUNDED_ORDER`. These are not mislabeled as separately approved human exact digests. Old `HUMAN_EXACT` approval semantics remain unchanged. The exact wire still passes canonical instruction/account-meta checks, current devnet/pool/program/mint/liquidity checks, unchanged economic limits, rent/inventory/fee caps, current blockhash checks and real simulation before signing.

The operator CLI accepts at most three automatic retries for **unsigned** quote/blockhash/application expiry. Each retry refreshes native evidence, archives proven-expired unsigned bytes, fetches a fresh quote and blockhash, compiles and simulates again. No signer claim, signed wire or signature may exist before refreshing. RPC/provider disagreement, changed economics, program changes, missing liquidity, refunds or other invariant failures stop rather than broaden scope. It never submits an automatically refreshed signed transaction.

The existing settlement executor atomically consumes the digest and bounded authorization with its signing claim, persists signed wire/signature before the sole broadcast call, and prohibits further construction after a signed/uncertain attempt. A lost response is reconciled by the persisted original signature only. Finalized receipts must prove the canonical message, exact input, minimum SPL-token output, token owners/mints, network fee, rent and relayer debit before marking the order completed. Restart/replay and completed-refund-veto checks run without loading keys.

Operator command, only following explicit human scoped authorization:

```powershell
node --import tsx scripts/phase7c.ts execute-bounded-swap --user-authorized-bounded-order --allow-devnet-broadcast --unlock-local-dpapi
node --import tsx scripts/phase7c.ts reconcile
node --import tsx scripts/phase7c-verify-completed.ts
```

Privacy remains limited by public Solana activity, RPC visibility of IP/timing and public accounts/instructions, a trusted prefunded relayer, primary-only live RPC verification when no secondary is configured, and the unchanged same-OS development-key arrangement. No Zcash identifier or viewing/spending key is sent to Solana or a DEX API. Private journals retain cross-chain joins; public reports omit them. No destination anonymity is claimed. Historical wallet credentials and the unresolved transfer remain untouched. Refunds remain disabled; Phase 8 is out of scope.

Regression evidence: [bounded focused tests](phase7c-evidence/bounded-focused.txt), [full Node regression](phase7c-evidence/bounded-node.txt), [backend types](phase7c-evidence/bounded-types.txt), [web types](phase7c-evidence/bounded-types-web.txt), [lint](phase7c-evidence/bounded-lint.txt). Live completion is reported separately only after finalized effects and durable restart/replay verification.

The live bounded execution subsequently finalized successfully. See [final result](PHASE7C-TRANSACTION-EVIDENCE.md) and [verified effects](phase7c-evidence/completed-verification.json). The bounded record is consumed, durable order completed, and replay blocked. No source payment was resent and no refund was enabled.
