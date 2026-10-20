# Functional completion roadmap

20 October 2026. Starting commit `57e3b5d`. The product is shielded-ZEC-funded multichain transactions. NFT features remain supported but are not the primary integration target. This is an implementation checkpoint, not a claim of functional completion.

## Milestone A — one transfer and one swap through the wallet

Use the existing Solana delivery and pinned CPMM swap first: they already have real completed settlement evidence. Do not add a second payment or execution engine.

Implemented `SettlementReview`, a durable economic review handoff in the existing settlement Store. It checks the bounded amount, recipient/relayer separation, testnet shielded profile shape, fresh devnet reads, pinned swap terms and available inventory. Reviews expire after 90 seconds and contain no recent blockhash: economic review does not consume chain transaction lifetime. Review does not create a financial order or return its receiving address.

An exact session/digest review can be consumed once only when the trusted caller separately enables financial creation and records explicit approval. Revalidation rejects changed swap terms, expired review, insufficient inventory, lost claims and existing order identifiers. It delegates to `SolanaSettlement.quote`, retaining the existing fixed 0.001 TAZ demonstration cost and eventual verification/execution policies. It never calls payment, prepare, signer, send or refund methods. Interrupted creation becomes reconciliation-only; it cannot automatically adopt an old paid order. Existing per-profile account/address uniqueness remains in force.

`settlementReads` connects review to the real Devnet/CpmmPolicy read layer. The optional authenticated local HTTP handler binds recipient to an operator-supplied allowlist, pins source profile/relayer server-side, rejects extra fields and CSRF failures, and rechecks the session after asynchronous work. It exposes no financial authorization route. It is not mounted in historical wallet startup by this checkpoint.

The operator can run a non-spending review without starting legacy workers:

```powershell
npm run wallet:review -- <public-isolated-profile.json> transfer
npm run wallet:review -- <public-isolated-profile.json> swap
```

The input has exactly seven public string fields: `profileId`, `requestId`, `recipient`, `relayer`, `lamports`, `account` (native isolated account identifier), `paymentAddress` (testnet shielded receiver). Never supply a seed/key file. Each invocation uses a new local review journal; it cannot create a financial order. Reviews are operator-local; do not publish output or the journal as a cross-chain activity record. The script accesses only public genesis/pool/inventory reads. Review is not an exact transaction simulation or reserved liquidity.

**Remaining implementation, in order:** mount this handler in a keyless opt-in wallet runtime; provision fresh isolated watch profiles per checkout; integrate explicit financial creation with existing history handles and actual reservation policy; bind account ownership/origin to execution authorization; expose the existing watch-only verification and operator approval status; exercise one transfer and one swap through that runtime. Do not connect the dry-run checkout ID to a live worker or reuse completed Phase 7 profiles.

Before live testing, produce a separate exact capped payment/execution plan. Stop for its approval. No funding, credential unlock or financial execution has occurred in this change. This milestone remains **partial**, not blocked solely by funding.

## Milestone B — third-party execution

Connection and preview consent grant no financial authority. Preserve original request/origin/account bindings through fresh adapter terms, recipient authorization, reservation, owned-note verification and finalized delivery. Use a distinct supported ZEC-funded action result. Unknown routers/programs/token routes remain rejected; never turn an imported signing request into an arbitrary relayer call. Current real-site evidence is discovery/partial connection only; local synthetic dApps are not live marketplace compatibility.

## Milestone C — mainnet preparation

Implemented a separate identity-only reader and disabled example configuration. Base and Solana public identity probes were successful; confidence is PRIMARY_ONLY. Ethereum needs a configured provider; Zcash needs a mainnet watch implementation. Neither this configuration nor an identity match installs a destination execution adapter. See MAINNET-READINESS.md.

## Milestone D — interface

No UI polish in this checkpoint. Show only actual supported operations, demo pricing, explicit recipient and trust boundaries. Integrate review/payment/finality/recovery before visual polish. Keep signing semantics separate from ZEC-funded relay semantics.

## Validation and preservation

See `functional-evidence/`. Development uses disposable database/chain fixtures. Both completed settlements are reconciled on safe copies with poisoned signing/send access and freshly read finalized receipts. All 628 protected files and original financial rows must remain unchanged. Mainnet, live refunds and historical credential migration stay disabled.
