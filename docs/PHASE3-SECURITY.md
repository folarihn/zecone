# Phase 3 security model

Testnets only: Zcash Testnet (NU7-compatible pinned native stack), Base Sepolia chain 84532. The prototype is a trusted prefunded settlement service, not a bridge, production exchange, or anonymous transaction system.

## Authority and keys

- The user EVM key stays in the existing local user directory. Only the separate local signing helper reads it after authenticated, CSRF-protected, exact quote approval. The settlement executor loads only its provider key. The seller has a third, independent local test key.
- Native shielded proving and signing remain local. No spending key or seed goes to lightwalletd, the marketplace, RPC providers, or browser JavaScript.
- All services bind to loopback. The independent marketplace uses port 4322; the authenticated wallet uses 3210. Exact origin and opener/channel checks from Phase 2 apply. The marketplace gets the public EVM account and a limited purchase status, never shielded balances, refund addresses, signatures, or Zcash transaction history.
- Same local OS account is a trust boundary, not a hardened enclave. An operator or malicious local process with access to all private directories can defeat this separation. Keep `.secrets` and `.state` private and gitignored.

## Bound authorization

The EIP-712 quote binds chain, immutable executor, marketplace, listing, NFT, token, seller, recipient, exact ETH value, fixed gas reserve, ZEC amount, simulated rate, zero slippage, expiry, canonical buy calldata hash, refund destination hash, origin hash, and unique order identifier. The executor verifies the user signature and consumes both digest and order identifier. The provider can only execute the signed marketplace purchase; it cannot substitute a recipient or control the user's wallet.

The receiving address is created once per approved quote. Payment amount and native fee ceiling receive separate local approval. Native send request IDs and persisted signed transactions prevent replacement sends after uncertainty. A completed broadcast is not proof of payment or delivery.

## Settlement and recovery

The native scanner supplies full canonical observations. Only shielded pool outputs with at least ten confirmations and a fresh, fully scanned tip authorize settlement. Payment identity is transaction/pool/output index. Duplicate observations do not add value. Attribution cannot move between orders. Underpayment waits; excess and late payments create recovery records. Reorgs revoke eligibility or create recovery after execution.

SQLite WAL, FULL synchronous mode, atomic reservations, unique active listing constraints, and a shared service lock protect against competing quotes and provider nonce conflicts. The quoted price plus gas reserve is reserved against pending provider balance, and available liquidity is rechecked before signing. Existing Phase 0–2 execution cannot prepare a new provider transaction while reservations exist; prior transactions can still reconcile.

The contract atomically transfers the ERC-721 to the user and pays the seller. A canonical successful receipt with three confirmations, exact marketplace/executor events, consumed quote, and `ownerOf` check is required for completion. RPC or ownership uncertainty is surfaced as recovery. No automatic refund or blind rebroadcast is permitted. Failed quotes cannot silently substitute another listing.

## Trust and residual risk

The settlement provider can correlate shielded payment and public NFT purchase. RPC and light-client infrastructure are trusted for availability and chain views; this is not an independently validating full node. Confirmation depths mitigate but do not eliminate reorgs. The provider holds received test ZEC and can withhold execution/refunds; there is no cross-chain atomicity or cryptographic Zcash proof on Base. Keys and source have not undergone an independent security audit.

Base L1 data fees are additional to EVM execution gas. The service uses a conservative L1 reserve and fixed fee caps, not an onchain guarantee of total Base fees. Pricing is an explicitly simulated fixed rate with a fixed gas reserve charged even if unused. No market-rate conversion occurs.
