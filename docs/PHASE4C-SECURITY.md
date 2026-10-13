# Phase 4C security model

This is a testnet proof with a trusted prefunded operator. It is not a trustless bridge, atomic cross-chain exchange, or audited production wallet.

## Authorization and recipient

The local user signing helper reads the existing user key separately from the settlement adapter. The provider uses its own key and ETH. The fixed `ZecOneSeaport` EIP-712 domain binds Base Sepolia chain 84532 and the deployed wrapper. The signed `SEAPORT_PURCHASE` action binds the source network, unique order ID/nonce, provider, user recipient, protocol/version/order hash, NFT/token/seller, consideration and fee, gas/value ceilings, ZEC amount, expiry, refund hash and exact reconstructed fulfillment calldata hash. Historic NFT/swap domains remain unchanged.

The immutable wrapper only calls the verified public Seaport 1.6 address. It does not expose an arbitrary target/call path. It checks its pinned runtime hash, full-open order shape, counter/status, exact ETH, signature and consumed order/nonce/digest. Seaport verifies the seller authorization and performs `fulfillAdvancedOrder` with the user recipient. Atomic postconditions require the user to own the NFT and the configured seller/fee recipient to receive their exact consideration. A failure reverts everything. There is no intermediate NFT custody.

The operator can still censor or refuse settlement. The local desktop process/OS is trusted: a separate helper is a key-access boundary, not hardware-wallet isolation or protection against a compromised machine. Secrets stay in ignored local files, are never sent to OpenSea, and are not included in public evidence.

## Listing and API validation

Only a single fixed ERC-721, native ETH, FULL_OPEN order is supported. Zero zones, zero conduit keys, direct seller approval, no criteria/bundles/partial fills/dynamic amounts/tips. The wrapper fixes the collection, seller and fee-recipient policy; both consideration recipients must have no contract code. Fees are bounded and explicitly authorized. The controlled test fee is not represented as an OpenSea fee.

The adapter checks canonical contract bytecode, chain/version/domain/configuration, authoritative order hash/counter/status, seller ownership/approval, seller EIP-712 signature or onchain validation, expiry and price. It reconstructs and simulates the call before approval/payment and again before settlement. RPC errors fail closed. Three canonical destination confirmations and exact transaction/event/ownership checks are required to report completion. Delivery ownership is checked at the receipt block so a later legitimate user transfer does not retroactively invalidate the purchase.

The optional OpenSea adapter is read-only, allows documented paths only, disables redirects, limits response size/time and observes authorization/rate-limit failures. It rejects unsupported chains. The documented structured fulfillment transaction is encoded and decoded locally, then compared byte-for-byte to the independently constructed call. Additional consideration, recipient changes, attribution suffixes and other methods are rejected. API data alone never authorizes execution. No Zcash wallet, viewing key, payment address or scan result is sent to OpenSea.

## Settlement, concurrency and recovery

The existing native Rust wallet allocates an idempotent unique account/address for each intent. Fully synchronized local shielded observations, transaction output identities and canonical block hashes are journaled. At least ten confirmations and sufficient correctly attributed payment are required before preparation. Nine confirmations, underpayment and stale/incomplete scans cannot authorize execution. Reorgs after authorization produce recovery liabilities; ten confirmations are a risk policy, not irreversible finality.

SQLite WAL/FULL transactions and a shared service lock coordinate all purchase/swap adapters. Reservations share the same per-chain provider balance. A unique index also prevents two active reservations for the same Seaport order. The worker persists the signed destination transaction and hash before broadcasting; uncertain outcomes reconcile that exact hash instead of signing replacements. Native sends use a durable request UUID. Onchain replay guards supplement database idempotency.

Listing cancellation, transfer, approval revocation, expiry, gas/liquidity failure or failed destination execution after payment leaves an auditable recovery state. Excess/duplicate payments are tracked as liabilities; there is no second NFT settlement. Recovery does not mean a refund was sent. Operators must investigate both chains and preserve original request/transaction records before any separately authorized manual refund. Never delete a journal, payment marker or active lock to force a retry.

## Evidence limits

Shielded amounts and recipients cannot be independently read from a public explorer. The payment proof combines the native local wallet scan, durable note attribution and public transaction/block references. Trust in the native wallet, configured lightwalletd service, RPC providers and local evidence remains explicit. Provider funding and public NFT ownership reveal correlation; this does not hide destination-chain activity.
