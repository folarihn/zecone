# Phase 5 runbook

Use the repository root on Windows with Node 24.12.x, the installed pinned npm dependencies, Rust/Cargo and Foundry. This checkpoint does not enable a funded refund. Read [limitations](PHASE5-LIMITATIONS.md) and [recovery](PHASE5-RECOVERY.md) before operating any wallet.

## Reproduce local checks

Build the isolated native signer before the Node suite (it now includes eight native integration tests):

```powershell
cargo build --locked --manifest-path services/refund-signer-native/Cargo.toml --target-dir target
cargo build --locked --manifest-path services/zcash-watch/Cargo.toml --target-dir target
cargo build --locked --manifest-path services/zcash/Cargo.toml
```

Native verification, genuine signing, synthetic proof/extraction and their separate-device gates are documented in [the native runbook](PHASE5-NATIVE-REFUNDS.md). No existing wallet credentials are used for those tests.

```powershell
npm run typecheck
npm run typecheck:web
node --import tsx --test tests/phase5.test.ts tests/orders.test.ts
npm test
npm run contracts:test
cargo test --locked --manifest-path services/zcash/Cargo.toml
cargo test --locked --manifest-path services/refund-signer-native/Cargo.toml --target-dir target
cargo test --locked --manifest-path services/zcash-watch/Cargo.toml --target-dir target
npm run test:ui
npm run test:extension
npm run wallet:build
node scripts/phase5-verify.mjs
node scripts/phase5-secret-check.mjs
node --import tsx scripts/phase5-isolated-secret-check.ts
```

The Phase 5 authorization/keystore tests create isolated keys and SQLite fixtures in temporary directories. They never load existing spending keys or broadcast. The native address-decoder test needs the local `target/debug/zecone-zcash.exe` binary; build it with `cargo build --locked --manifest-path services/zcash/Cargo.toml` if absent. Other existing Node/Foundry/browser suites use local chains and synthetic fixtures; some need public RPC access or an installed Edge browser. Logs distinguish baseline and subsequent runs. Do not run concurrent copies of the same browser test server.

The preservation verifier requires the original private `.secrets/phase5-checkpoint/manifest.json`; it is intentionally not committed. It compares prior public files, private credentials and historical core order/broadcast records without printing credentials. Scanner changes to wallet databases are expected and are not checked as byte-identical files. Do not run the checkpoint creator again to overwrite the original baseline.

## Read-only market data and browser checks

```powershell
node --import tsx scripts/phase5-prices.ts
node --import tsx scripts/phase5-swap-readiness.ts
npm run wallet:start
```

Start only one local wallet server on `127.0.0.1:3210`. Its existing background reconciliation may scan legacy wallets and reconcile receipts; inspect uncertain orders before starting it. Existing credentials remain legacy-only. For the recorded Phase 5 browser check all eight historical orders were already settled.

In a separate terminal, the optional `node --import tsx scripts/phase5-browser.ts` uses Edge headless, consumes the one-use local pairing token privately, approves a local ownership-login signature, fetches market references, attempts a swap quote and cancels it before intent/payment approval, inspects historical terms, rejects a malicious URL, then logs out. It does not approve a purchase or send funds. It saves a sanitized report and screenshots in `docs/phase5-evidence`. The pairing code expires; `node --import tsx scripts/pair-wallet.ts` creates a new one without printing spending credentials. Do not paste credentials into the browser console or CLI arguments.

If a quote is unavailable, inspect the reported stage and existing service locks rather than raising gas/slippage limits. `phase5-swap-readiness.ts` performs public contract reads and `eth_call`/gas estimation only, reporting bounded error categories without raw RPC errors. Never automatically delete a lock or send marker to make a test pass.

## Portable simulated signing rehearsal

This workflow uses disposable synthetic notes only. Never fund a synthetic-fixture address. There is no live option. Build the native signer above and the original wallet binary used only for offline address decoding. Run Rust builds/tests serially with native Node tests on Windows to avoid locking the same executable.

```powershell
cargo build --locked --manifest-path services/zcash/Cargo.toml
node --import tsx scripts/phase5-portable.ts prepare-simulation
node --import tsx scripts/phase5-portable.ts review <session-json-path>
node --import tsx scripts/phase5-portable.ts sign <session-json-path> <approved-digest>
node --import tsx scripts/phase5-portable.ts recover <session-json-path>
```

Replace the placeholders with the session path printed by preparation and the digest from review. Inspect the displayed order/request IDs, recipient, amount, fee/cap and expiry before signing. Do not pass passwords or keys in arguments. Review evidence expires after 120 seconds and the request after 300 seconds; prepare a new disposable fixture if it expires, retaining all old journals. Recovery returns previously saved bytes without new signing. Never reset an uncertain claim.

Preparation creates new gitignored files under `.secrets/phase5-portable/<id>` and `.state/phase5-portable/<id>`. Only the unsigned request and returned `signed-transaction.json` are transfer artifacts. Signer-owned evidence, approval keys, spending keys, development password and journal stay on the signer side. The current CLI stores a development password locally beside its encrypted keys and uses the same Windows account, so this is not real isolation. The returned envelope contains transaction bytes and public binding metadata, not PCZT/evidence/keys.

The fully automated regression harness is `node --import tsx scripts/phase5-portable-rehearsal.ts`. Its approval is a synthetic fixture action, never operator authorization for a live transaction. [Recorded result](phase5-evidence/completion-portable-cli.json).

## Funding recovery and independent evidence

The authorized 0.002 ZEC transfer from the original payer was interrupted. Request `bcb86911-fb11-44e5-9f76-cbfaa713091f` retains a construction marker and process lock, with no saved hash. The latest receiver scan found zero receipts. Do not run another send or remove either marker to unblock it. Use `node --import tsx scripts/phase5-funding-status.ts` for read-only source inspection and receiver scanning; it performs no signing or retry. It updates its public observation report, so preserve the committed checkpoint when collecting later observations.

Public disposable receiving addresses and estimated funding are in [completion-test-wallets.json](phase5-evidence/completion-test-wallets.json). The 0.002 request remains unresolved; it must not be described as sent. Do not rerun wallet provisioning merely to retry funding.

`node --import tsx scripts/phase5-provider-check.ts` checks the two allowlisted providers without opening a spending wallet. The recorded ECC probe supplied no usable evidence. Agreement requires different operator identities, matching network/branch/hash/root and fresh confirmations; it is not consensus validation. See [submission readiness](PHASE5-SUBMISSION-READINESS.md) for actual evidence and remaining gates.

Live signing stays disabled until physical-device validation and actual-note construction/reconciliation are complete. Any eventual refund broadcast additionally requires explicit approval of the exact transaction, followed by ten confirmations and destination receipt verification.


## Pricing configuration

Default `marketReferences()` uses Coinbase Exchange and Kraken public APIs for **both** ZEC/USD and ETH/USD; no credential is required. Each feed validates the product/base/quote identity. Prices use eight-decimal integer USD values and the exchange trade timestamp, not merely HTTP retrieval time. Default maximum age is 120 seconds and cross-source deviation is 300 basis points; future timestamps allow only five seconds of skew. Failure of a configured feed rejects the reference rather than downgrading the quorum. Cache lifetime is at most 30 seconds and never past source expiry.

`reference(asset, sources, clock, maxAge, deviationBps)` is the configurable service interface. `CoinGeckoPrices(demoKey)` is an optional adapter; configure a Demo key through private deployment plumbing, never source control or browser APIs. It is not automatically activated by an environment variable. Its supported endpoint uses `include_last_updated_at=true` and a private `x-cg-demo-api-key` header. [CoinGecko](https://docs.coingecko.com/demo/reference/simple-price), [Coinbase ticker](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker), [Kraken trades](https://docs.kraken.com/api-reference/market-data/get-recent-trades).

Reference quote policy is provider-committed testnet liquidity: integer-rounded fees, approval within 60 seconds/source freshness, execution deadline within one hour, bounded movement before approval, no repricing after approval. The immutable asset/minimum output and liquidity/gas checks still apply. **These reference quotes are not payable intents in the running wallet.** The existing test contracts bind the old simulated rate, so shared checkout explicitly labels that rate and shows optional market data separately. The controlled ZTEST token has no asserted USD market. Testnet ETH/TAZ has no redemption value.

## Independent signer deployment contract

Backend side: new seed-free wallet database and imported viewing accounts, independent public approval keys, verified payment journal, and unsigned authorization export. Signer side: separately provisioned spend keys, encrypted approval vault, own trusted payment/order evidence, native destination/transaction verifier and durable journal. Transfer a bounded versioned request; compare public key fingerprints through an independent channel. Do not mount the signer's credential directory on the backend or copy old merchant seeds into the new service.

The current library entry points are `Refunds.draft/request/approve/exportUnsigned`, `IndependentRefundReviewer.review/approve`, and `Refunds.acceptSignerApproval/reconcilePayment/view`. There is intentionally no HTTP refund route or functional broadcast CLI. `WatchRefundReader` now implements independent evidence through a separate UFVK scanner and local recovery registry; accepting backend-supplied evidence as this reader defeats the design. Its real-chain source is blocked from signing. `Refunds.broadcast()` always throws. See [watch-only reproduction and new isolated paths](PHASE5-WATCH-ONLY.md).

Isolated native PCZT effects validation and signing now have a separate signer-only integration; neither wallet HTTP routes nor the backend call it. Activation still requires a separate device, independently synchronized actual-note evidence, seed-free account allocation/scanning, transaction/broadcast/confirmation persistence and successful reorg/broadcast-crash tests. Then use a new test order and ten-confirmation payment/refund evidence. Do not repurpose an old settled order or use the existing merchant seed to bypass these requirements.

## OpenSea handoff

The Seaport screen accepts explicit `https://opensea.io/item/ethereum/<contract>/<id>` or `/assets/ethereum/...` URLs (also `www.opensea.io`). Queries, fragments, credentials, ports, percent escapes, dot segments and lookalike hosts are rejected. The adapter resolves official NFT metadata, the best listing, exact order and fulfillment inspection. [OpenSea best listing endpoint](https://docs.opensea.io/reference/get_best_listing_nft).

Existing private OpenSea development credentials are reused only by the read-only adapter and remain unmodified. API unavailability or unsupported listings fail closed. Mainnet previews remain non-executable with no payment address. This phase does not intercept OpenSea's native Buy button.
