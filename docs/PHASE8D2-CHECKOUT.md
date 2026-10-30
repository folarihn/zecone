# Phase 8D.2 — intent-to-ZEC checkout rehearsal

Starts at `8aa6bc1`. This phase connects one consented EVM request to a fresh adapter-backed quote and a durable **dry-run** checkout handoff. It does not create a financial checkout, reserve financial inventory, allocate a shielded payment address, obtain a signature, start a worker, submit a transaction or activate refunds.

## Selected action and mapping

Selected: the existing **Base Sepolia ERC721 marketplace purchase**. `services/marketplace/purchase.ts` already implements `interpret`, `inspectListing` and `priceZatoshis`, with extensive marketplace/settlement fixtures. It checks exact `buy(uint256,address)` calldata, chain, marketplace, connected recipient, listing NFT, seller ownership/approval, active/expiry status, price, direct buy simulation and gas estimation. Unlike the tuple-based Phase 0 mint, the imported purchase request does not first require a recipient-signed ZecOne mint tuple. No contracts, routers, programs, networks or dependencies were added.

`PurchaseIntentQuote` in `services/wallet/purchase-intent-quote.ts` maps exactly one registered `nft-purchase` intent to these existing **read-only functions**. It never constructs `PurchaseBase`, `Purchases`, `Engine`, a wallet client or a financial Store. Importing the purchase module does not instantiate those classes or load their legacy credentials.

Trusted local configuration must pin the Base Sepolia marketplace, executor, NFT, public relayer, allowed origin, runtime bytecode hashes and the Phase 8D.1 route. The route must match this market and operation; an optional legacy provider address must match the relayer. The mapper re-derives the canonical intent from the original persisted request. Exact request digest, operation, target, destination, input, account/recipient and existing preview consent must match. Arbitrary calldata, mint/swap actions, other chains/targets, unknown fields, noncanonical ABI encodings and relayer-as-recipient are rejected.

The backend obtains two explicitly supplied read clients. Both must report chain 84532 before account queries, agree on the same block number/hash/timestamp, validate the three runtime hashes and executor's marketplace/relayer, run the existing listing checks and simulation at that block, verify preliminary fee limits and relayer inventory, and still agree on the block/chain afterwards. Contract reads, code reads, buy simulation, gas estimation and balance snapshot use the same block number. Fee estimates must agree in the resulting quote. A configured disagreement never triggers failover or primary-only acceptance.

The route fee cap must equal this adapter's existing fixed gas reserve. A tighter incompatible cap is rejected rather than silently expanded by the quote or handoff.

The two clients in the new tests are **synthetic fixtures**. Two different client objects do not prove independent infrastructure, RPC honesty, contract correctness or consensus finality. No live pair is configured by this phase, no endpoint is invented/purchased and no independent live quote is claimed. A future live integration needs explicitly configured bounded read transports and verified operator independence. Existing Phase 8C receipt verification remains unchanged; its receipt-only RPC allowlist is not broadened for quoting.

## Quote economics and lifetime

- Destination: one ERC721 NFT, identified by marketplace/listing, pinned collection, token ID, seller and exact user recipient. Input is the listing's exact native ETH price, at most 0.001 test ETH and further bounded by the registry. A dApp's value must equal the independently read listing price; the dApp does not set the authoritative price.
- Testnet ZEC amount: reuse `priceZatoshis(price,84532)`, with the existing fixed demonstration rate **1 TAZ = 0.02 test ETH** and fixed **0.0001 test ETH** gas reserve. This is simulated testnet pricing, not a market rate or asset exchange. The reserve would be charged even if unused.
- Slippage: exactly zero. This is not a swap quote; extra slippage fields or router instructions are rejected.
- Preliminary fee: direct buy gas estimate with the existing 20% margin plus one gas unit, at most 600,000 gas; fee-per-gas at most 100,000,000 wei, valid priority fee, plus 40,000,000,000,000-wei data reserve, all within the registry/network gas reserve. Public relayer inventory must cover price plus reserve at the snapshot. No inventory is reserved by this rehearsal.
- Review quote lifetime: at most 120 seconds, additionally clipped by the original intent and session deadlines. Quote construction must finish within 30 seconds of its start and the block timestamp must be within 60 seconds. The proposed destination deadline preserves the old purchase service's one-hour/listing-minus-60 bound and requires at least 30 minutes remaining for eventual shielded confirmation. That proposed deadline grants no financial authority.

The preliminary estimate is for the direct marketplace buy, **not the signed executor transaction**. Existing executor/recipient signature validation, full executor simulation, final fees, inventory reservations and payment eligibility remain required before any future real execution. The new quote must not be mistaken for proof that the complete financial transaction is executable.

Each quote has a new UUID and digest binding its version, request ID, scope, exact terms, bytecode configuration digest, destination block, observation time and deadlines. Refresh supersedes old quote records without deleting history and requires a new exact review. Price changes invalidate the original dApp transaction; they are not silently substituted into it. At checkout authorization, the adapter rereads and resimulates and compares all economic/listing/fee terms and configuration. Any change or expired approval fails closed. It never automatically accepts a worse or different quote.

## Independent authorizations and local API

The existing browser-authenticated provider and local session/CSRF boundary remain authoritative. The following are distinct:

1. Origin account connection.
2. Exact Phase 8D.1 intent preview consent.
3. Exact quote review.
4. A separate click authorizing **only a dry-run checkout handoff**.
5. Existing financial signing/payment/settlement authorization, which is absent here.

Local POST endpoints under `/api/dapps/` accept request bodies only, with strict allowed keys and no query parameters:

- `intent-quote`: `{id}`; fetches an adapter-backed quote for the persisted consented request.
- `intent-quote-review`: `{id,quoteId,digest,approved}`; records exact review or terminal cancellation. It creates no checkout.
- `intent-checkout-preview`: the same fields, with a separate `approved:true`; creates the dry-run handoff only after fresh revalidation.
- `intent-checkout-status`: `{id}`; returns the scoped rehearsal state/handoff.

Session getters are rerun before and after asynchronous work and inside final commit claims; they do not rely on a request-start session snapshot. Deadlines are checked again inside the final transaction, after acquiring its lock. Revocation, logout, expiration, origin/channel/session/account mismatch or chain changes reject access and prevent finalization. Revocation marks prior preview consent cancelled; reconnecting the same account/origin cannot revive it. Quote/checkout identifiers are scoped references, not authorization tokens. Original request parameters cannot be replaced through these endpoints.

The existing approval popup offers the three explicit buttons after preview consent: **Get checkout quote**, **Review quote only**, **Authorize dry-run checkout**. It displays the exact NFT/recipient, ETH price, TAZ cost, fee reserve, preliminary simulation limitation, zero slippage, expiry and trusted-relayer/public-ownership disclosures. Expiry does not trigger automatic refresh or creation. Permission/session/chain loss clears this local view; closing it drops component state. There is no browser persistence or UI polish.

The dApp still receives the existing clear non-execution error for `eth_sendTransaction`, never a fabricated transaction hash. Quote/payment data is not posted back to it. A local-only consent flag enables the rehearsal controls only for the selected registered purchase/origin/target when a trusted backend explicitly injects `checkoutPreview: IntentCheckout`. That policy additionally requires intent interception, explicit `signingDisabled:true` and no financial `Purchases` service. Invalid combinations fail construction; legacy personal/typed signing and the custom financial purchase method are rejected in this opt-in mode. Historical modes remain unchanged. The production server **does not automatically install** that policy or any live read clients. The new complete path is verified with disposable provider/API/UI fixtures only.

## Durable handoff and recovery

`IntentCheckout` uses a separate SQLite ledger with its own application ID, tables and audit. It refuses to write to an existing unrelated database. It has no financial Store, Zcash scanner, native signer, spending key or worker dependency. It never opens original settlement journals for writes.

Transitions: new request → PREPARING → QUOTED → QUOTE_REVIEWED → CREATING → HANDOFF_READY. Preparation failure becomes REQUOTE_REQUIRED; a creation/revalidation failure becomes RECOVERY_REQUIRED. Cancellation is terminal. Refresh supersedes prior unconsumed quotes. Immediate SQLite transactions claim preparation/creation before asynchronous reads; duplicate/concurrent claims are rejected. Exact quote approval cannot be transferred to replacement records.

The handoff reuses `unifiedCheckouts` and the Phase 8A `checkoutBrowserView` projection, producing the existing purchase/USER_REVIEW display shape plus explicit dry-run/false-authority fields. Its random display ID is not inserted into financial tables or the real checkout scopes; it cannot select a live order or reveal a payment request through legacy APIs. No dummy payment or “successful” settlement is created.

On restart, completed rehearsal state is retained, consumed quote authority cannot run again, and interrupted PREPARING/CREATING rows become RECOVERY_REQUIRED. No automatic resume/recovery/reset exists. A lost response can be reconciled through the same scoped status call rather than repeating creation. Expired/revoked sessions cannot reclaim old handoffs; records remain operator-only. Reopening an interrupted rehearsal or binding it to a new session requires later explicit design, not hidden reuse of consent.

## Privacy and remaining boundaries

No Zcash payment ID, shielded transaction, receiving address, account, refund destination or source-to-destination payment join is generated or sent to the dApp/RPC. Quotes contain destination facts and a proposed testnet funding amount, not payment evidence. RPCs see relevant public contract/account reads, buy calldata, client IP/timing and simulations. ABIs are local decoding metadata, not additional RPC fields. Diagnostics/tests do not publish credential values or private funding joins.

The operator retains scoped origin/request/quote audit relationships; future actual settlement would additionally let it correlate funding and destination execution. Destination ownership/activity is public, and timing/amount correlation remains possible. No anonymity, trustless bridging, production custody, hardware isolation or legacy-credential migration is claimed. Historical plaintext credential exposure and refund/device-validation restrictions remain unchanged.

Before a real end-to-end transaction: configure verified historical deployment pins and genuinely independent bounded read providers; finish financial inventory reservation and recipient signing through the unchanged existing purchase flow; allocate/verify a real shielded payment only under a separately authorized live phase; simulate the signed executor and verify its fee/deadline limits; explicitly authorize settlement and reconcile finalized effects. This phase deliberately stops before those actions.

See [selected-action record](phase8d2-evidence/selected-action.json) and [validation](PHASE8D2-VALIDATION.md).
