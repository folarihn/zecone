# Phase 8B validation and preservation

Starting commit: `48485cb`. Scope: opt-in development credential persistence and revocable Solana signer lifecycle. No new live wallet was provisioned or unlocked. No live payment, transaction signing, broadcast, refund, credential migration or mainnet activation occurred. Cryptographic tests use disposable local credentials, synthetic messages/transactions and fake providers only.

## Exact changes

- `services/signer/lease.ts`: explicit role-bound states; monotonic inactivity and maximum deadlines; generation cancellation; failed-attempt cooldowns; concurrency rejection; revocation before cleanup; fail-closed cleanup errors; stale-result rejection.
- `services/solana/leased-signer.ts`: frozen message/transaction facades without `CryptoKeyPair`, generation checks and SDK compatibility adapter. New managed facades accept one operation per call.
- `services/solana/encrypted-accounts.ts`: leases instead of returned raw signers; public-only metadata listing; role/label binding in newly encrypted payloads; compatible read/backup/restore for old age credentials without rewriting existing files.
- `services/signer/wallet-vault.ts`: new opt-in encrypted seed32 records with user/relayer/refund-approver namespaces, authenticated identity/role/network metadata, public-only responses and throttled password verification without signer activation.
- `services/signer/keystore.ts`: narrowly extends the accepted authenticated-purpose vocabulary for the new vault. Existing KDF/cipher parameters, old approval purposes and ciphertext format are unchanged.
- `services/solana/settlement.ts`: signer parameter type and one mechanical signing-adapter call only. Payment, approval, claim, persistence, broadcast and recovery policy blocks are unchanged.
- `scripts/phase8-wallet.ts`: local opt-in create and read-only list CLI. No import-file, unlock, signing or broadcasting command; passphrase files must resolve outside the project.
- `scripts/phase8-preserve.mjs`: explicit `--phase8b` output/baseline namespace; no previous preservation output is overwritten during this phase.
- `scripts/phase6-lint.mjs`: includes the new security source and tests.
- `tests/phase8-keys.test.ts`: eighteen disposable security regressions.
- `docs/PHASE8B-KEYS.md`, this report, `PROGRESS.md` and new `docs/phase8b-evidence/` results.

No historical EVM/Zcash/Solana credential loader, deployment, protected inventory, existing wallet file, existing encrypted secret or financial authorization policy was migrated or replaced. No browser unlock API or UI key store was introduced.

## Security assertions tested

1. Explicit consent and validated lifetime/throttle bounds; no loader access without consent.
2. Locked/unlocking/unlocked states, inactivity expiry and a hard lease deadline that signing cannot renew beyond.
3. Proactive timer lock and synchronous expiry checks when timers are delayed.
4. Lock while decryption is pending; the real age decrypt result cannot restore signing authority.
5. No overlapping unlocks of a pending lease and no unlock/sign race while one operation is active.
6. Lock or expiry during an operation suppresses its result; stale facades remain revoked after a new unlock.
7. Wrong-role access is rejected, independent leases remain independent, and newly encrypted age ciphertext cannot be relabeled as another role.
8. Wrong passwords fail; attempt limits survive lock calls; cooldown prevents another KDF; restart starts locked. Limits are process-local, not protection against offline attacks or restarting another process.
9. Cleanup failure cannot retain authority or leak its raw exception; the lease stays locked and refuses further unlock.
10. Facades expose no raw keypair and reject empty/batch signing requests.
11. The SDK adapter produces identical canonical wire bytes with a leased facade and a raw legacy signer for the same disposable transaction/key.
12. New encrypted files contain neither raw seed bytes, seed hex nor the passphrase; role/network metadata substitution fails authenticated decryption.
13. New approver seed storage cannot be accessed as a user wallet and does not activate native refund signing. Mainnet, Zcash native provisioning and mismatched role/network combinations are rejected by this vault interface.
14. API-style projections, diagnostic exports and CLI output contain no plaintext credential material. No new browser-storage integration exists.
15. The local CLI requires opt-in; public listing creates nothing and changes no encrypted record. Passphrase path checks reject internal paths, including misleading names starting with two dots.
16. Public encrypted-account address/list/status paths never decrypt or unlock; a test subclass fails if decryption is attempted.
17. Legacy age-v1 fixture unlock remains compatible and leaves ciphertext/public metadata byte-for-byte unchanged; existing age backup/restore regressions remain passing requirements.
18. A completed synthetic settlement vetoes duplicate execution before reading any signer or accessing the network; completed real records receive separate read-only copy/reconciliation checks.

These tests verify application boundaries and lifecycle behavior, not independent cryptographic certification, OS isolation or universal secure erasure. Tests deliberately distinguish synthetic fixtures from prior real finalized settlements.

## Final regression results

**464 tests pass**: 335 Node (including all 18 new key-security cases), 29 wallet UI, 17 extension, 6 historical UI, 3 isolated API/UI, 3 completed swap API/UI, 52 Solidity, 10 Rust wallet, 5 Rust watch and 4 Rust signer. Zero failures in the final runs. Both TypeScript checks, scoped lint and production build pass. Focused key/swap/settlement validation also passed 68 tests; those cases are not double-counted.

Sanitized logs are in [phase8b-evidence](phase8b-evidence/): `node.txt`, `ui.txt`, `extension.txt`, `phase6c-ui.txt`, `phase7a-ui.txt`, `phase7c-ui.txt`, `contracts.txt`, `rust-wallet.txt`, `rust-watch.txt`, `rust-signer.txt`, `types.txt`, `types-web.txt`, `lint.txt` and `build.txt`. Initial interrupted/sandbox-constrained runs remain in the private development directory. One browser attempt started before build readiness; local Anvil tests needed permitted loopback connectivity. Final suites ran sequentially after the build; no application policy or test assertion was weakened to pass them.

Final preservation verifies **537 + 91 = 628 protected files unchanged**, both private historical inventory copies still matching, and both original financial journals unchanged against their pre-validation baseline. Both settlements remain completed with signed evidence, finalized receipts and exactly one signing/broadcast claim each; refunds remain disabled. Fresh read-only finalized receipt reconciliation and restart/replay/refund-veto checks on consistent journal copies pass with **zero signer access and zero broadcast calls**. See `preservation.json`, `inventory-check.json` and `completed-order-audit.json`.

Node files are serialized with `--test-concurrency=1` to bound memory pressure from age/scrypt and native proof fixtures. Every existing test file still runs; no new security test is skipped. The pre-existing standalone expensive native signer proof remains ignored, while Node integration exercises native signing/proof with isolated fixtures.

Reproduction (PowerShell, repository root):

```powershell
node --import tsx --test --test-concurrency=1 tests/*.test.ts
npm run typecheck
npm run typecheck:web
npm run lint
npm run wallet:build
New-Item -ItemType Directory -Force '.state/phase8b/browser' | Out-Null
$env:ZECONE_QA_EVIDENCE_DIR='.state/phase8b/browser'
npm run test:ui
npm run test:extension
npm run test:phase6c
$env:ZECONE_PHASE7C_REGRESSION='1'
npm run test:phase7a
$env:ZECONE_PHASE7C_FINALIZED='1'
npm run test:phase7c
forge test
cargo test -p zecone-zcash
cargo test --manifest-path services/zcash-watch/Cargo.toml
cargo test --manifest-path services/refund-signer-native/Cargo.toml
node scripts/phase8-preserve.mjs --phase8b
```

Use the existing private preservation baseline. On a fresh environment, initialize the new private Phase 8B baseline with `--initialize` **before** validation; that does not replace comparison against the historical inventories. Browser suites run sequentially and need their existing isolated/snapshot profiles, Edge and public devnet read access. Screenshot outputs remain private. Never launch the legacy signing-capable server for read-only QA.

## Historical financial guarantees

The preservation checker hashes all 537 historical and 91 Phase 7B protected entries without publishing individual hashes/credential paths. It opens original financial journals read-only and compares private fingerprints of original orders, payments, settlement rows (including signed bytes/signatures/receipts) and verified payment authorizations. Session/history attachment metadata is separate from those financial records.

Additional restart/replay verification runs on consistent private SQLite backups, never by reopening paid orders in the original journal. Signer access and submission are poisoned. Fresh devnet receipt reads are compared against saved finalized receipts; no Zcash identifier is sent to the destination RPC. Both completed orders must remain `COMPLETED/settled`, retain exactly one signing and one broadcast claim, reject duplicate preparation/execution, and veto completed-order refunds.

The local verifier is retained at `.state/phase8b/replay-audit.ts`; sanitized assertions are in `docs/phase8b-evidence/completed-order-audit.json`. New evidence paths and private screenshots do not overwrite previous Phase 8A, Phase 7B or historical preservation reports.

## Remaining exposure and Phase 8C readiness

The new vault is deliberately inactive storage/verification, not an encrypted EVM/native wallet migration. Historical plaintext EVM JSON, Zcash seed files and Solana legacy seed JSON remain. The historical funded Solana relayer still uses its original authorized loader. Raw signer references from that legacy class do not acquire the new revocation property. The legacy EVM server still eagerly loads a relayer and is not a read-only entry point.

Legacy age-v1 data remains compatible without the role-authenticated payload of newly created records. Existing DPAPI unlock files remain same-user Windows protection, not an independent password/device boundary. Private buffers are minimized, but JavaScript strings, platform crypto, process memory and already released signatures cannot be reliably erased/revoked. Cleanup failure leaves a lease closed; in-flight crypto cannot be forcibly preempted, and its late result is suppressed.

No live key migration, new active EVM/native signer, hardware custody, separate-device refund validation, independent RPC quorum or mainnet readiness is claimed. These do not block a separately authorized Phase 8C provider-confidence implementation, but must remain explicit demo limitations. **Stop after Phase 8B; do not begin Phase 8C automatically.**
