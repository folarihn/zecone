# Functional completion roadmap

20 October 2026. Starting commit `57e3b5d`. The product is shielded-ZEC-funded multichain transactions. NFT features remain supported but are not the primary integration target. This is an implementation checkpoint, not a claim of functional completion.

## Milestone A — one transfer and one swap through the wallet

Use the existing Solana delivery and pinned CPMM swap first: they already have real completed settlement evidence. Do not add a second payment or execution engine.

Implemented `SettlementReview`, a durable economic review handoff in the existing settlement Store. It checks the bounded amount, recipient/relayer separation, testnet shielded profile shape, fresh devnet reads, pinned swap terms and available inventory. Reviews expire after 90 seconds and contain no recent blockhash: economic review does not consume chain transaction lifetime. Review does not create a financial order or return its receiving address.

An exact session/digest review can be consumed once only when the trusted caller separately enables financial creation and records explicit approval. Revalidation rejects changed swap terms, expired review, insufficient inventory, lost claims and existing order identifiers. It delegates to `SolanaSettlement.quote`, retaining the existing fixed 0.001 TAZ demonstration cost and eventual verification/execution policies. It never calls payment, prepare, signer, send or refund methods. Interrupted creation becomes reconciliation-only; it cannot automatically adopt an old paid order. Existing per-profile account/address uniqueness remains in force.

`settlementReads` connects review to the real Devnet/CpmmPolicy read layer. The optional authenticated local HTTP handler binds recipient to an operator-supplied allowlist, pins source profile/relayer server-side, rejects extra fields and CSRF failures, and rechecks the session after asynchronous work.

The keyless runtime is now opt-in for financial creation: `npm run wallet:review-ui -- <public-profile.json> --state <dir> --enable-financial-creation`. Without the flag it remains review-only. With it, the local UI/API can consume the exact review once, create one durable order, and reveal the testnet shielded payment request. It still loads no sender, signing key or broadcast worker. A `GET /api/settlement-review/status` route lists only that session's reviews. SPL delivery uses the profile's explicitly configured mint; EVM transfer quotes and settlement live in `services/settlement/evm-transfer.ts` and `services/evm/transfers.ts`, with empty operator allowlists by default.

Payment verification is operator-mediated: `npm run wallet:observe -- <state-dir> <watch-snapshot.json> [--solana-authorize]` applies a real watch-only snapshot to the same durable journal. `--solana-authorize` can mark a funded Solana order ready for separately approved execution; it cannot execute. EVM receipts are reconciled by the existing settlement worker when an executor and read-only network are configured.

EVM transfer review is available without creating an order:

```powershell
npm run wallet:evm-review -- <public-evm-request.json> [--policy <policy.json>]
```

The request contains only public profile, recipient, relayer, amount, asset, fee cap and shielded payment address; the operator policy file supplies explicit ERC-20/SPL allowlists and value caps. The command quotes against the real testnet RPC, prints the exact call and returns `financialOrderCreated:false`. It cannot pay, sign or broadcast. Creating the reviewed order still requires a separate explicit operator action.

The operator can run a non-spending review without starting legacy workers:

```powershell
npm run wallet:review -- <public-isolated-profile.json> transfer
npm run wallet:review -- <public-isolated-profile.json> swap
```

The input has exactly seven public string fields: `profileId`, `requestId`, `recipient`, `relayer`, `lamports`, `account` (native isolated account identifier), `paymentAddress` (testnet shielded receiver), plus optional public `spl` `{kind:"SPL",mint,decimals}` in the wallet runtime. Never supply a seed/key file. Reviews are operator-local; do not publish output or the journal as a cross-chain activity record. Review is not an exact transaction simulation or reserved liquidity.

**Remaining implementation, in order:** provision fresh isolated watch profiles per checkout; bind account ownership/origin to execution authorization; add operator-controlled reservation and executor/receipt-provider configuration; verify the native watch scanner feeds `wallet:observe`; exercise one transfer and one swap through the runtime with an explicitly approved capped plan. Do not connect the dry-run checkout ID to a live worker, recycle completed Phase 7 profiles, or treat the EVM/SPL allowlist defaults as live configuration.

Before live testing, produce a separate exact capped payment/execution plan. Stop for its approval. No funding, credential unlock, payment, signature or broadcast occurred in this change. This milestone remains **partial**, not blocked solely by funding.

## Milestone B — third-party execution

Connection and preview consent grant no financial authority. Preserve original request/origin/account bindings through fresh adapter terms, recipient authorization, reservation, owned-note verification and finalized delivery. Use a distinct supported ZEC-funded action result. Unknown routers/programs/token routes remain rejected; never turn an imported signing request into an arbitrary relayer call. Current real-site evidence is discovery/partial connection only; local synthetic dApps are not live marketplace compatibility.

## Milestone C — mainnet preparation

Implemented a separate identity-only reader and disabled example configuration. Base and Solana public identity probes were successful; confidence is PRIMARY_ONLY. Ethereum needs a configured provider; Zcash needs a mainnet watch implementation. Neither this configuration nor an identity match installs a destination execution adapter. See MAINNET-READINESS.md.

## Milestone D — interface

No UI polish in this checkpoint. Show only actual supported operations, demo pricing, explicit recipient and trust boundaries. Integrate review/payment/finality/recovery before visual polish. Keep signing semantics separate from ZEC-funded relay semantics.

## Validation and preservation

See `functional-evidence/`. Development uses disposable database/chain fixtures. Both completed settlements are reconciled on safe copies with poisoned signing/send access and freshly read finalized receipts. All 628 protected files and original financial rows must remain unchanged. Mainnet, live refunds and historical credential migration stay disabled.
