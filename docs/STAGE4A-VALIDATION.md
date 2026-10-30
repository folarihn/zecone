# Stage 4A validation — 22 October 2026

## Decision

The offline provisioning, UFVK recovery, watch-only import, encrypted watch
backup and authenticated-payment implementation are complete for disposable
local validation. Mainnet payment acceptance remains disabled until operator
infrastructure and a controlled owned-note run are available.

## Recovered work

The interrupted implementation already provided mainnet UFVK derivation and
inspection helpers, encrypted Zcash seed recovery, watch-profile path guards,
two-provider full-transaction agreement, fresh UFVK trial decryption, durable
payment/order binding, age-encrypted watch backup and single-writer/reorg
controls. It also added public header/block proof fixtures and connectivity
probes. None of that code unlocks a spending key or broadcasts a transaction.

## Completed in this continuation

- Provisioning records an explicit mainnet wallet birthday. Disposable recovery
  must reproduce the original account, address, UFVK and birthday without
  printing the seed or viewing key.
- Mainnet UFVK import rejects testnet keys, historical/repository/symlink paths,
  existing directories and duplicate imports. Restart reopens only the exact
  watch manifest and UFVK.
- Watch backup accepts only a mainnet `uview1` UFVK and a mainnet manifest,
  performs SQLite `PRAGMA integrity_check`, uses exclusive outputs and rejects
  corrupted, mismatched, incomplete or wrong-network restores.
- Payment ownership is re-established from provider-corroborated full
  transaction bytes with `zcash_client_backend::decrypt_transaction`. Account,
  pool, output index, incoming transfer type, value and receiver must match.
- The scanner does not treat lightwalletd `CompactBlock.vtx` as a complete
  transaction list. That protocol omits transactions without shielded activity.
  Instead, the scanner requires externally staged complete raw blocks named
  `<height>-<display-hash>.bin` outside the repository.
- The payment's complete block must contain the txid exactly once and pass full
  transaction-Merkle-root, header-hash, Equihash `(200,9)` and target checks.
  The bounded confirmation segment must pass the same header checks, previous
  hash continuity and accumulated-work calculation. Both configured
  lightwalletd providers must corroborate every block hash. The tip is checked
  again after evidence construction; an in-flight reorg fails closed.
- TypeScript accepts only fresh native `zcash-full-transaction-ufvk-v3`
  evidence. Copied JSON, edited SQLite state, stale observations, invalid chain
  evidence, restarts and payment reuse cannot create an execution grant.

## Trust boundary

This is not a local Zcash full node and does not verify all accumulated work
from genesis or a pinned checkpoint. The approved raw-block exporter, two
independently operated lightwalletd services, local Rust executable, watch host
and imported UFVK remain trusted. The raw bytes are cryptographically checked
against the provider-agreed block hashes, but provider independence still needs
operator evidence.

Locked Zcash dependencies are `zcash_client_backend 0.25.0-pre.1`,
`zcash_client_sqlite 0.23.0-pre.1`, `zcash_keys 0.17.0-pre.1`,
`zcash_protocol 0.11.0-pre.0` and `zcash_primitives 0.31.0-pre.1`. Their
pre-release status requires review before production custody decisions.

## Validation

- Full Node suite: **523 passed, 0 failed** with test concurrency 1.
- Focused Stage 4A Node suite: **44 passed, 0 failed**.
- Rust watch suite: **16 passed, 0 failed**.
- `cargo fmt --check` and `cargo clippy --offline --all-targets -- -D warnings`:
  passed.
- Application and web TypeScript checks: passed.
- Repository lint/Prettier check: passed.
- Wallet production build and extension build: passed.
- Preservation: all **537 + 91** protected files unchanged; Phase 7B and 7C
  remain completed with one signing claim and one broadcast claim each,
  financial rows unchanged and refunds disabled.

All provisioning and backup tests use disposable credentials and temporary
directories. No production seed, UFVK, wallet, payment, signature, broadcast or
refund was created. The Contabo deployment was not accessed or changed.

## Production blockers

1. Approve and configure two genuinely independent mainnet lightwalletd
   operators and an authenticated raw-full-block exporter.
2. Approve production provisioning, choose a recent birthday before the first
   receipt, and run the offline workflow on the designated isolated device.
3. Transfer only the UFVK, receiver and birthday to the watch host and perform a
   controlled authenticated owned-note scan.
4. Supply an approved public `age` recipient and off-host destination, then pass
   a real backup/restore drill.
5. Review the pre-release Zcash dependency set and the actual host/process
   isolation. Mainnet execution must remain paused until these checks pass.
