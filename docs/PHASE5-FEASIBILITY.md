# Phase 5 feasibility — audit before implementation

2026-10-13. Starting checkpoint `acc982e076c69e90f1b67f405d8abe2ee97e9706`, branch `codex/phase4e-extension`, clean before this phase's evidence was added. Work is on `codex/phase5-secure-settlement`. Phase 5 is **partial, not a verified live refund implementation**. See [results](PHASE5-RESULTS.md) for the implemented checkpoint and [limitations](PHASE5-LIMITATIONS.md) for remaining gates.

## Preservation and baseline

The new local checkpoint `.secrets/phase5-checkpoint` contains 26 private wallet/key/journal files and six consistent SQLite online backups. Each backup passed `integrity_check`; copied private files were compared without printing their contents. Public preservation inventory: [284 hashes](phase5-evidence/preservation.json), including prior documentation/evidence, Cargo manifests/lock and npm lock. Three legacy orders and five purchase/swap/Seaport orders were settled, with eight recorded destination broadcast attempts. No historical order, credential, deployment or previous evidence is to be rewritten. Native wallet files continue to be updated by the existing scanner; byte-for-byte equality of a running wallet database is not an appropriate preservation assertion.

Baseline: 148 Node tests, 52 Solidity tests, four Rust tests, 12 UI tests and 13 installed-extension tests passed (229 total). Both TypeScript checks passed. Initial sandbox Node/UI runs stalled; an unsandboxed regression run passed, with one intermediate UI attempt blocked by its test-only port. Logs retain these unsuccessful attempts as well as the passing runs. Local Anvil forks read public RPC data; their transactions and browser fixtures are synthetic. No Phase 5 live payment or refund has occurred.

## Existing code and security audit

Critical paths reviewed: `services/zcash/src/main.rs`, execution Store/worker/io/Zcash wrapper, wallet Engine/native/security/server, marketplace Journal/service/purchase, swap and Seaport adapters, OpenSea service/inspection, local signer helpers, and prior architecture/security/results documentation. This is an engineering review, not an independent security audit.

Current persistent order states are `awaiting_payment`, `verified`, `prepared`, `submitted`, `settled`, `expired`, `failed`, `recovery`. The purchase request also has draft/creating/awaiting/sending/sent/review/cancelled stages. Recovery records do not send or prove refunds. State transitions currently trust their callers rather than an explicit transition graph. A future refund must durably veto execution in the same transaction boundary and must not infer failure from a pending EVM receipt.

The native wallet validates the test network and shielded destination, proposes ZIP-317 fees, checks a maximum approved fee, writes a construction-started marker, constructs locally, persists the transaction reference, then broadcasts. A crash between construction and the reference remains deliberately uncertain. Reconciliation must use the original UUID and wallet transaction, never remove a marker and create a replacement. A signed destination EVM transaction remains executable independently of an application state flag: no refund may be authorized while that transaction can still execute.

Plaintext credentials currently reside under `.secrets/user`, `.secrets/merchant`, `.secrets/relayer`, `.secrets/marketplace-seller`, and private earlier checkpoints. EVM `loadAccount` reads plaintext JSON; Zcash `seed()` reads `seed.bin`. Every native wallet command currently initializes the database using the seed, including scanning. Allocation derives a new spending account. Merely moving a signer script or encrypting an additional copy would not remove backend access to existing keys. Existing Windows ACLs protect against other ordinary OS users, not this backend's OS identity.

Sensitive correlation persists in `orders`, `payments`, `audit`, purchase requests, browser checkouts, dApp requests and native wallet journals. Existing public purchase projections omit payment output identities, refund addresses and signatures. The authenticated local operator still sees cross-chain associations; no privacy from that operator is claimed. Old evidence is intentionally retained even where it contains user-authorized transaction references. New evidence should disclose counts/statuses rather than private mappings.

OpenSea remains authenticated read-only discovery/validation. Mainnet previews have `executable:false` and no payment address. Seaport execution is restricted to the pinned testnet protocol, signed exact consideration, NFT/recipient and expiry. No Buy-button interception is needed. A future URL import must parse an exact official hostname/path and resolve the authoritative order through this existing adapter; URL text is not a price or authorization.

## Independent signer decision

The user explicitly chose a **separate computer / offline signer**, and authorized isolated development credentials only. Existing credentials must not be modified, deleted or migrated. Implement the unsigned refund request and independent verification architecture locally, but require a separate device for a funded live signing proof. A same-user test process is a development fixture, not true isolation.

Required separation: backend payment verifier and unsigned request exporter; independently authenticated user request; operator approval key; independent signer with its own trusted order/payment evidence, destination decoder, spend keys and durable anti-replay journal. The signer must compare destination, amount, fee ceiling, order identity and authorizations against its own evidence. It must not accept a backend `approved:true`, backend-calculated eligible balance, or backend-provided verification callback as a production trust anchor. Backend imports only public verification keys and completed transaction evidence. A signed approval envelope is **not** a shielded transaction signature or refund.

A signer device needs independently provisioned testnet funds/keys and a seed-free receiving/scanning backend. Existing funded merchant credentials stay legacy-only. New live demo orders cannot reuse them while claiming the backend lacks refund keys. Offline synchronization/transaction handoff requires more than a JSON request: note witnesses, anchors and actual transaction effects must be checked using supported native APIs. Until this transport is tested, funded refund actions must remain disabled.

## Pinned native capabilities

Keep Zcash TestNetwork, TLS `https://testnet.zec.rocks:443`, NU7 consensus check, and all current exact Rust crate pins. Installed source for `zcash_client_backend=0.25.0-pre.1` exposes feature-gated `create_pczt_from_proposal`, `redact_pczt_for_signer`, `redact_pczt_for_batch_signer`, and `extract_and_store_transaction_from_pczt`. Its PCZT dependency is exactly `0.10.0-pre.1`, already present in Cargo.lock. Source documents single-step proposals and v6/Ironwood PCZT support. This establishes an available API, **not** a tested ZecOne offline signer. Review the [maintained PCZT source](https://github.com/zcash/librustzcash/tree/main/pczt). No dependency upgrade or new capability is assumed from an SDK name.

## Market data and quote policy

Use real prices as reference data only. Test TAZ/test ETH/test tokens have no redemption guarantee. The provider should commit to the immutable quoted test amounts until the execution deadline and absorb price movement; if the exact asset/route is unavailable, recover rather than reprice or substitute. Source-price freshness applies at quote creation, with a separately bounded maximum movement policy stated before approval. A committed quote cannot be silently replaced after payment.

Candidate sources: CoinGecko ID-based `simple/price` (`zcash`, `ethereum`) with `include_last_updated_at=true`, using its documented Demo or Pro key/header; Kraken public `Trades` with a verified `AssetPairs` mapping and exchange timestamps. A ticker's HTTP retrieval time alone is not source freshness. Validate two distinct configured sources, reject missing/nonpositive/overflowing prices, stale/future timestamps and excessive disagreement. Public feeds can disagree or be unavailable; fail closed rather than silently use the old fixed conversion. [CoinGecko](https://docs.coingecko.com/reference/simple-price), [Kraken recent trades](https://docs.kraken.com/api-reference/market-data/get-recent-trades).

Implementation follow-up: Coinbase Exchange and Kraken are the default public quorum; both ZEC and ETH references were fetched and validated live. Coinbase product metadata binds base/quote identity and its ticker includes a trade timestamp. CoinGecko's Demo adapter is optional and has not been live-tested here. The reference calculation remains distinct from existing payable fixed-rate intents; replacing the contract-bound rate requires a versioned execution change. [Coinbase ticker](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker).

Base/Ethereum/Robinhood test gas assets use an explicitly labeled ETH mainnet reference, not a claimed market price for testnet currency. The controlled ERC-20 fixture has no independently established USD market: quote its onchain pool output/minimum and label it unpriced. Do not invent a token/USD ticker. NFT quotes bind exact listing, seller, total consideration, recipient and deadline; swaps bind route, exact input, minimum output and maximum slippage. Existing shared purchase reservations must remain authoritative across products.

## Keystore approach and gates

An isolated-development keystore can use Node's maintained OpenSSL-backed scrypt and AES-256-GCM primitives, cryptographic random salts/nonces and authenticated version/purpose metadata. No new encryption algorithm. Enforce fixed bounded KDF parameters to avoid attacker-controlled resource exhaustion; reject tampering/wrong passwords without exposing which private field failed. Unlock belongs to the local signer, not a backend/browser plaintext-key API. Limit unlocked lifetime and erase mutable buffers on lock; JavaScript cannot promise perfect zeroization of all runtime copies. [Node crypto](https://nodejs.org/api/crypto.html).

Existing credentials must not be enrolled automatically. Any future migration needs an explicit source/destination, exclusive new file, decrypt-and-compare verification, backup and rollback procedure, and separately approved activation. Keeping a readable plaintext original does not create signer isolation. Seed-only restoration is not yet independently demonstrated; wallet database/birthday/derivation/send journals remain essential recovery records.

## Implementation order and live gate

1. Preserve baseline and add durable transition/refund authorization components using isolated fixtures.
2. Add independent signed request verification, encrypted test keystore, anti-replay and crash-safe signer journal; distinguish authorization signatures from native transaction signatures.
3. Integrate the native PCZT construction/effects-verification/sign/extract path without granting backend spend access; verify round trips and crash/reorg cases before enabling live transport.
4. Add bounded multi-source pricing and shared checkout integration without changing historical signed intents.
5. Test authenticated browser/refund flows against actual backend state. Provision a separate signer device and new watch-only receiving wallet before the funded demonstration.

Stop at any failed security gate. No Phase 5 success claim, synthetic-to-live substitution, production assets or Phase 6 work is authorized.

The live native-signing gate remains unmet. A subsequent [isolated native integration](PHASE5-NATIVE-REFUNDS.md) validates exact Ironwood effects and creates genuine spend signatures, with a successful synthetic proof/extraction round trip. The [watch-only continuation](PHASE5-WATCH-ONLY.md) adds seed-free imports and independently fetched real testnet evidence from two unfunded databases. Funded-note validation, separate-device validation and refund transport remain outstanding. Funded refund execution is stopped. An additional review found and closed the pre-sign EVM/refund race using a durable construction claim before the asynchronous signer call.
