# Phase 5.2 runbook

Use Node 24.x, installed pinned npm dependencies and Rust/Cargo from the repository root. This profile is disposable and testnet-only. Do not run a legacy funded wallet server or use the old funding request to support this test.

## Existing profile: safe inspection

```powershell
node --import tsx scripts/phase52-profile.ts status
node --import tsx scripts/phase52-payment.ts inspect
node scripts/phase52-preserve.mjs verify
node --import tsx scripts/phase52-audit.ts
```

Status scans only the new A/B/C and signer watch databases. Inspect queries the exact saved payment ID, compares returned bytes and never resubmits. Preservation reads file hashes and private snapshots; it does not open the quarantined wallet through a wallet API. Reports are observations at their recorded time.

Profile metadata: `.state/phase52-profile.json`. New state: `.state/phase52/99ef6572-b2ba-4d7f-a1fb-1bf333f2cb0b`. New encrypted credentials: the matching UUID under `.secrets/phase52`. The backend's configuration contains only B watch access and disabled execution/refund flags; it contains no signer key paths.

The original requested 0.002 TAZ was superseded by the user's actual 0.125 TAZ funding. **Do not fund again or send from the quarantined wallet.** Current public addresses and actual chain references are in [results](PHASE5-2-RESULTS.md).

## Reproduction on an unprovisioned checkout

```powershell
cargo build --locked --manifest-path services/zcash/Cargo.toml
cargo build --locked --manifest-path services/zcash-watch/Cargo.toml --target-dir target
cargo build --locked --manifest-path services/refund-signer-native/Cargo.toml --target-dir target --bins
node scripts/phase52-preserve.mjs init
node --import tsx scripts/phase52-profile.ts create
node --import tsx scripts/phase52-profile.ts status
node --import tsx scripts/phase52-profile.ts providers
```

The preservation initializer expects starting checkpoint `fec8341` and a previously absent preservation pointer. It must **not** be rerun on this already provisioned checkout. Creation exclusively reserves one profile and cannot overwrite or reroll it. An interrupted provision remains reserved. The reviewed `complete-new-profile <exact-id>` command can finish only missing roles/imports and refuses completed profiles, surprise key files or conflicting identity; it never replaces keys. Do not remove its pointer or directories to make creation succeed.

The native provisioner generates new seed/key material from OS randomness. New plaintext staging files are removed only after verified encryption. Development passwords are co-located with these disposable keystores; this is simulated isolation, not protection against the same Windows user. No funded historical key is imported or migrated.

Request independently supplied **0.002 TAZ**, testnet only. The estimated minimum is 0.0011 for a 0.001 payment and 0.0001 fee, assuming a single mature Ironwood input. Planned refund 0.0009 plus 0.0001 fee consumes that payment. Additional inputs or different fees require fresh review. No transparent shielding budget is included.

## Payment preparation and explicit approval

```powershell
node --import tsx scripts/phase52-payment.ts prepare
node --import tsx scripts/phase52-payment.ts review
```

Prepare requires ten-confirmation unspent Ironwood funds. It decrypts **only the new A seed**, passes 32 bytes through local stdin to the fixed-purpose native payer, and clears mutable buffers. No seed is stored in the native payer directory or passed via arguments/environment. The native command checks the seed against A's UFVK and fixes the recipient to the new B address and amount to 100,000 zatoshis with a 10,000-zatoshi fee cap.

The native wallet persists the planned expiry before proving, then stores canonical transaction bytes, actual fee, transaction ID and expiry before any submission. Preparation does not broadcast. The private native directory is `payer-native` under this profile, not a legacy wallet.

Only after the operator reviews the exact amount, destination, fee, bytes hash and expiry:

```powershell
node --import tsx scripts/phase52-payment.ts broadcast <explicitly-approved-review-digest>
```

**This profile's approved payment has already been submitted and mined. Do not run broadcast again.** Its native exclusive claim is written/flushed before the one RPC submission. A timeout, rejection, expired transaction or missing response never clears a claim or authorizes a replacement. Inspect and fresh receiver scans reconcile known bytes. Expiry does not imply a transaction mined before expiry should be treated as unmined.

## Controlled recovery

```powershell
node --import tsx scripts/phase52-payment.ts observe-recovery
```

The new SQLite ledger reuses the existing lifecycle. Two B scanners must agree on the exact transaction, note amount, mined block and at least ten confirmations with fresh complete scans. A local fault before EVM construction enters recovery and records a permanent veto. Repeating this command in a new process checks the same receipt and preserves version 7; it does not repeat payment or refund. If the tip moves or scans disagree, retain the state and collect fresh read-only evidence.

No EVM signer/contract transaction is used in this test profile. A controlled local failure must not be described as an on-chain revert.

## Real-note unsigned refund and review-only handoff

```powershell
node --import tsx scripts/phase52-refund-request.ts
node --import tsx scripts/phase52-export.mjs
```

The first command exports a PCZT only from the dedicated backend B watch wallet in verified recovery with a veto. It requires a single exact 100,000-zatoshi mature Ironwood payment input, constructs 90,000 to C with exactly 10,000 fee, and writes a construction claim before randomized PCZT creation. No spending key is read. Existing output is reused and hash-checked; an incomplete claim is never automatically regenerated.

A separate B watch database supplies its own FVK and unspent-note evidence. A separate RPC lookup retrieves the PCZT's specific anchor height; the network-free native verifier checks actual effects against that evidence. This is independent of backend reports but uses the same public provider and computer.

The **review-only** private transfer directory contains:

- `unsigned-refund.pczt`: private note/ciphertext/witness material.
- `unsigned-refund.json`: immutable construction metadata.
- `unsigned-refund-request.json`: draft request, replay IDs, input evidence and recorded native effects review.
- `portable-manifest.json`: relative filenames and SHA-256 integrity checks.

Transfer only these review files over a controlled channel to a future validated signer environment. Keep all keystores, passwords, UFVK files and signer journals private. Do not publish PCZT/request bytes or paste them into a public explorer. The request JSON records the original local PCZT location; use the relative filenames in the manifest when reviewing a transferred copy.

**This is not the authorized bundle accepted by the existing portable signer.** User/operator certificates are absent, and the physical-device gate is closed. Do not feed real data into `phase5-portable.ts sign`: that CLI is deliberately synthetic-only. The PCZT expires at height 4,504,159, and its stored review is point-in-time evidence. If stale, retain it and its claim; obtain fresh independent evidence and an explicitly reviewed new authorization before any future replacement request. Do not delete claims or assume archived reviews remain valid.

The user has no second physical computer available. Stop before live refund signing. Enabling a separate-device path requires deployment validation and explicit new approval; importing these same-account development keys elsewhere does not retroactively establish exclusive custody. Do not silently migrate or delete existing keys.

## Regression checks

```powershell
cargo test --locked --manifest-path services/zcash/Cargo.toml
cargo test --locked --manifest-path services/zcash-watch/Cargo.toml --target-dir target
cargo test --locked --manifest-path services/refund-signer-native/Cargo.toml --target-dir target
npm test
npm run typecheck
npm run typecheck:web
npm run contracts:test
npm run wallet:build
npm run test:ui
npm run test:extension
```

Run Rust builds/tests before Node native tests on Windows to avoid locking the same executable. Browser/contract regressions use local fixtures. No live transaction is part of these test commands. Existing proof tests write into disposable directories, preserving old public evidence.
