# Phase 5 watch-only integration and real-chain evidence

2026-10-13. Testnet only. **Live refund signing and broadcasting remain disabled pending separate-device validation.** Existing funded wallets, seeds and wallet dependency pins were not migrated or changed.

## Implemented boundary

`services/zcash-watch` is a separate Rust workspace with its own lockfile. Its CLI exposes only `import` and `observe`. Import requires a new directory and a valid testnet unified full viewing key (UFVK). It initializes `WalletDb` with `init_wallet_db(None)` and calls `import_account_ufvk`. `AccountPurpose::Spending { derivation: None }` retains note/nullifier/witness data for independent review; it does **not** supply a spending key. A test imports a fresh UFVK, discards its in-memory seed, closes and reopens the database without a seed. Legacy seed directories, unexpected files and directory symlinks are rejected before opening the database.

The supported API was checked against the installed exact crate sources and [WalletWrite documentation](https://docs.rs/zcash_client_backend/0.25.0-pre.1/zcash_client_backend/data_api/trait.WalletWrite.html). The [maintained repository](https://github.com/zcash/librustzcash) remains the upstream source. Pins: `zcash_client_backend=0.25.0-pre.1`, `zcash_client_sqlite=0.23.0-pre.1`, `zcash_keys=0.17.0-pre.1`, `zcash_protocol=0.11.0-pre.0`, `orchard=0.16.0`. These are the already-installed prerelease versions needed for this NU7 testnet, not a claim of stable production support. The dependency audit compares registry versions **and checksums** with the preserved legacy lockfile.

Every observation connects over TLS to `https://testnet.zec.rocks:443`, checks the test chain and local consensus branch, performs native compact-block scanning/decryption, requires complete scanning to the tip, and compares the scanned block hash with server tree state. It selects a sparse Ironwood checkpoint at least ten confirmations deep and compares the locally maintained root to the independently requested server tree at that height. A changed tip or final tree state fails closed for retry. The endpoint is listed by [the provider's status service](https://hosh.zec.rocks/zec/testnet.zec.rocks%3A443); [lightwalletd upstream](https://github.com/zcash/lightwalletd) documents its light-client role.

`WatchOnlyZcash.observe()` fits the settlement `Snapshot` interface. A dedicated imported account uses SHA256(UFVK) as its stable account identity across databases; database UUIDs and diversified receiving addresses are not necessarily equal. Each payment order must have a **distinct preprovisioned UFVK/account**. Automatic seed-based `allocate` is intentionally unavailable. The existing wallet server has not been switched to this experimental adapter.

`WatchRefundReader` implements both independent authorization evidence and native note evidence. It runs its own native scan, recomputes receipt-set and intent digests, requires all known receipts to have ten confirmations, matches note nullifiers/amounts/heights to actual received outputs, and rejects spent, locked, mixed-pool, missing, duplicate or post-anchor inputs. The native refund profile remains Ironwood-only. A second scan whose payment digest changes between authorization and native review is rejected before native IPC.

The signer-owned SQLite registry requires explicit review of immutable order/account/intent/destination bindings and a time-limited recovery decision. It is never populated automatically from a backend refund bundle. **“Never constructed” EVM status is an independently reviewed operational assertion, not a fact proven by Zcash or EVM RPC.** An undisclosed signed EVM transaction cannot be disproved by a chain query. A separate-device deployment and durable execution interlock remain required before live use.

The reader identifies itself as `liveChain: true`; `IsolatedNativeRefundSigner.sign` rejects this source before vault access or native signing. The existing synthetic native signing/proof tests remain available. No environment flag enables live refunds.

## Real testnet result

The [sanitized proof](phase5-evidence/watch-only-real-chain.json) records two separate scanner databases and fresh isolated credentials. At 16:19:40 UTC both scanners reached **4,498,450**, with block hash:

`0000180721b443cc645b43354eaff7b553803c6bbd3de754ae4ed4db52949d9a`

Both computed Ironwood root `2e095285abc8cc1add5067223504e2571d02498d66f6c3c9cb5848a601c92d16`. Their sparse checkpoint heights differ (4,498,439 and 4,498,437); the root was unchanged across those checkpoints. Both found **zero payments and zero unspent Ironwood inputs**. No paid-order or refund success is claimed. There is no new transaction ID.

Validation: [188 Node tests passed](phase5-evidence/watch-only-node-tests.txt), including seven new independent-evidence cases; [three native watch tests passed](phase5-evidence/watch-only-rust-tests.txt); [typechecking passed](phase5-evidence/watch-only-typecheck.txt). Tests cover ten-confirmation boundaries, empty/spent/mixed/duplicate notes, immutable/expired registrations, receipt-set changes between scans, reorg removal in the settlement store and blocking live signing before vault access. The initial full Node run encountered sandbox `EACCES` for local fixture servers; it was stopped and rerun successfully with appropriate access.

Fresh backend receiving address:

```text
utest14kn6vrrhh532qz2za3a6tgmy0868zvm0p04r4eg4dvge7f6ytrpaljag0ar2wsphssau6wsm6nanjd0265jdy3fxv9pny99vuuj6hw9q
```

This is an isolated test wallet, not a replacement for any existing funded wallet. Funding is not required to repeat the read-only proof. A paid-receipt demonstration would require new testnet funds; live refund work must additionally wait for separate-device validation.

## Reproduce

Run from the repository root with the installed Rust 1.88+ / Node 24 toolchains:

```powershell
cargo build --offline --locked --manifest-path services/zcash-watch/Cargo.toml --target-dir target
cargo build --offline --locked --manifest-path services/refund-signer-native/Cargo.toml --target-dir target --bin provision-watch-test
# Only on a fresh setup; exclusive creation refuses to replace an existing proof configuration:
node --import tsx scripts/phase5-watch-proof.ts --create-isolated
# This checkout is already provisioned. Repeat independent scans without creating any keys:
node --import tsx scripts/phase5-watch-proof.ts
node --import tsx --test tests/watch-evidence.test.ts
cargo test --offline --locked --manifest-path services/zcash-watch/Cargo.toml --target-dir target
node scripts/phase5-watch-audit.mjs
```

The proof script encrypts only newly generated seed and Orchard spending-key staging files using the existing verified scrypt/AES-GCM keystore, then removes those new plaintext staging files. It keeps a development recovery password alongside those encrypted test files. That is recoverable local development storage, **not effective separation from the same Windows user**. File permissions inherit Windows ACLs. No existing credential is read for provisioning or scans. The scanners receive only UFVK copies; private material is not passed in command arguments, environment variables, logs or network requests. UFVKs reveal wallet activity and must also remain private. The public report excludes UFVKs, note nullifiers and decrypted wallet details.

The local configuration `.state/phase5-watch-proof.json` contains only paths to the new test directories. Scanner directories contain the marker, viewing key, SQLite files and transient lock only. A crash leaves incomplete creation or a lock for manual inspection; the script does not erase a wallet or automatically clear a lock. Repeating the proof updates its dated public read-only report.

## Limits and required next gates

- **Independent of the backend, not independent consensus infrastructure.** Both databases fetch the same public lightwalletd service. Local decryption, continuity and root checks do not establish full consensus validation, server completeness, or resistance to a malicious provider. Use a separately operated validating testnet node/provider and signer device for the live gate.
- Positive live note/nullifier/witness handling remains unproven because this new wallet is unfunded. Unit tests label synthetic evidence explicitly. Compact-block scanning observes mined receipts; mempool absence is not proof that no additional payment is pending.
- The birthday was obtained for a newly generated wallet, 100 blocks behind the then-current tip. Importing an older UFVK with an incorrect birthday can miss payments. Birthdays require independent review when transferring wallets.
- Note queries use the pinned SQLite schema. Upgrade requires renewed schema and real-chain tests. Any recorded spend or lock excludes a note conservatively, including expired transactions that need manual reconciliation.
- Native unsigned-PCZT proposal/export from this new watch wallet, funded note verification, exact signed transaction broadcast/reconciliation and confirmed refund recovery still need integration and validation. No production key migration, frontend changes or live refunds were performed here.
