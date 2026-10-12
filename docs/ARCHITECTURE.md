# ZecOne architecture

## Phase 1 local application boundary

The Phase 1 Next.js/React/Tailwind application is served by one custom Node gateway bound to `127.0.0.1:3210`. A local launcher exchanges a ten-minute single-use capability for a one-hour HttpOnly SameSite=Strict session. Literal Host, Origin, fetch metadata, JSON content type and session-bound CSRF checks protect a narrow API. Production CSP uses per-request script nonces; no analytics or external assets are loaded.

The authenticated browser receives an allowlisted projection, not `Store.report()`. Internal account UUIDs, merchant receiving addresses, intent signatures, raw transactions, viewing keys and full audit mappings never enter the browser response. Local data remains private/no-store. Public Base explorer links are explicit user actions.

```mermaid
flowchart TB
  B[Browser: local paired session] --> G[Loopback gateway: auth + CSRF + approvals]
  G --> U[Separate local user signing helper]
  G --> D[Private browser checkout journal]
  G --> P[Rust payer: native balance, unsigned fee quote, approved send]
  G --> O[Existing order verifier and merchant scanner]
  O --> R[Existing prefunded Base relayer]
  R --> N[Existing NFT contract: user-owned recipient]
```

Ownership challenges bind the origin, chain, configured user address, nonce and expiry. The helper signs only gateway-authored approval files and the gateway verifies the recovered address. Creating an order signs fixed EIP-712 mint terms; it cannot send Zcash. Sending requires a separate short-lived, session/order-bound quote. The native signer rejects fees above the approved ceiling. A durable compare-and-set and stable request UUID precede construction, so retries cannot create a new payment.

The engine serializes native work and uses the original service lock for merchant scanning/settlement. Background settlement is restricted to checkouts whose payment was explicitly approved. Restarted in-flight actions enter review; reconciliation reuses saved signatures or transaction references. Session expiry or closing the browser does not cancel already authorized work.

Native balances use `get_wallet_summary`, including shielded spendable amounts; receipt totals are never used as wallet balances. Native wallet history and known ZecOne Base mint receipts are projected separately. NFT candidates come from this verifier's settled orders and are checked with live `ownerOf`. This is deliberately not a universal NFT/transaction indexer. Collection art in the UI is a local illustration, not an on-chain image.

The process split is not a security boundary against a malicious same-OS-user program. The local operator still controls payment attestation and can correlate checkout activity. See [security review](PHASE1-SECURITY.md), [runbook](PHASE1-RUNBOOK.md), and [risks](RISKS.md).

## Preserved Phase 0 payment engine

## Boundaries

1. A local user utility holds the user's Base Sepolia EOA key and signs a fixed mint intent containing chain ID, contract, recipient, amount, nonce and expiry.
2. A local TypeScript order service verifies that signature and allocates one Zcash account/address per order through the Rust service. A SQLite transaction persists the immutable intent and unique payment destination.
3. Rust connects only to Zcash Testnet lightwalletd, synchronizes its native wallet DB, and emits locally scanned shielded output observations. Unique keys are `(txid,pool,output_index)`; accounts distinguish orders. No HTTP endpoint accepts payment claims.
4. The verifier requires complete scan coverage, sufficient confirmed value, and an unexpired order. Unconfirmed value never authorizes execution. Payments arriving after expiry, overpayments and reorgs become auditable recovery work.
5. One local worker uses an ETH-prefunded Base Sepolia key to mint a fixed ERC-721 to the signed user recipient. The contract allows one mint per order hash and validates the user's intent signature independently.

```mermaid
flowchart LR
  U[User key / signed intent] --> O[SQLite order journal]
  P[Shielded testnet payer] --> Z[Zcash Testnet]
  Z --> L[lightwalletd]
  L --> R[Rust local scan / notes]
  R --> O
  O --> E[Prefunded Base relayer]
  E --> N[Base Sepolia fixed mint contract]
  N --> W[User-controlled EOA owns NFT]
```

## Persistence and retries

SQLite WAL plus immediate transactions protect state transitions. A unique intent nonce prevents replay; a unique payment output key prevents double counting. Payment snapshots replace canonical observations only after successful sync. Journal entries record state transitions. Settlement progresses from awaiting payment to verified to prepared/submitted to settled. A signed raw Base transaction is persisted **before** broadcast, allowing an identical rebroadcast after crash/timeout; a transaction receipt, event and order-consumed state are reconciled before declaring settlement. Unknown broadcast results cannot justify issuing a new transaction. One worker owns a local exclusive process lock; no automatic stale-lock takeover.

Expired, underpaid, overpaid, orphaned and failed settlements remain visible. Recovery records are manual-review cases, not claims that a refund happened. A refund needs a payer-specified shielded address, ownership/context review, current canonical funds, a local shielded transaction and confirmed refund evidence. It must never race a pending Base mint. Automatic refunds are outside this slice.

## Security and ownership

No arbitrary contract calls, chain selection or calldata are accepted in an order. Only the configured Base Sepolia contract and fixed mint method are permitted. Recipient signatures bind all order terms and contract address. Contract-level replay protection survives application restarts. User key and relayer key have separate files and code paths; no server key becomes the NFT owner. Same-OS-user filesystem isolation is a development boundary, not hardened key custody.

The merchant Zcash seed is local. A separate payer seed models the paying user. For scale, migrate receiving to a viewing-key-only scanner and an isolated signing process. Testnet only; no bridge liquidity, pricing oracle or production exchange. Phase 1 adds the explicitly authorized local frontend above this unchanged settlement model.
