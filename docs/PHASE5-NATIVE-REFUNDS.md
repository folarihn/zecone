# Native refund verification and signing — isolated development

2026-10-13. **Implemented and tested for a narrow NU7 Ironwood profile. Live refunds remain disabled.** Existing wallet credentials, databases, historical orders and the legacy Rust dependency lock were not used or changed by these tests.

## What now works

The final validation continuation adds `finalize-isolated`: it revalidates the original PCZT and review digest, imports only verified signatures from the signed PCZT, then proves/extracts the transaction without a key input. `PortableRefundSession` persists a finalization claim before proof generation and stores exact transaction bytes for recovery. The narrowly scoped returned envelope omits keys, viewing data, witnesses and PCZT. The separate-process CLI uses synthetic evidence only; the real-chain reader and live broadcast gates remain closed. [Portable reproduction](PHASE5-RUNBOOK.md), [current test counts and blockers](PHASE5-SUBMISSION-READINESS.md).

`services/refund-signer-native` is a separate Rust package and resolution boundary. Its library parses an actual PCZT, verifies its transaction effects, produces genuine Ironwood spend authorization signatures with an isolated key, verifies those signatures, and checks that the shielded signature hash is unchanged. The independent TypeScript signer calls it through bounded local stdio, after checking user/operator/independent-signer authorization and an explicit native review digest.

The new tests construct hypothetical notes using fresh OS randomness. They do **not** observe a Zcash payment. One explicit expensive test signs, creates a real Ironwood proof, extracts a native Zcash transaction and serializes it. Its anchor is synthetic; this is a cryptographic round trip, not a confirmed refund or evidence of spendable testnet funds. No transaction hash from it is presented as a chain reference.

## Exact supported profile

| Property | Enforcement |
|---|---|
| Network/format | Testnet coin type, NU7 branch from pinned TestNetwork schedule, v6 version/group; no transparent/Sapling/Orchard bundles |
| Input evidence | Signer-owned FVK, exact nullifier/value set, positive amounts, no duplicate inputs, ten-confirmation minimum, fresh evidence within 120 seconds |
| Witnesses | Required for every real input; reconstructed note commitment and witness must produce the signer-approved Ironwood anchor |
| Spend ownership | Native nullifier and randomized verification-key checks against the signer's FVK; spending key must derive that same FVK |
| Transaction bounds | At most eight real inputs / ten actions, 256 KiB PCZT, immutable transaction, no fallback timelock, expiry within forty blocks |
| Refund destination | Shielded-only testnet UA with Orchard receiver used by Ironwood; expiring UAs and the signer's own recipient addresses are rejected in this version |
| Outputs | Exactly one positive refund output of the approved amount; at most one positive change output, owned under the signer's internal scope |
| Encryption | Verify commitments and value commitments; recover positive ciphertexts with signer's external OVK; compare recipient/value; independently decrypt internal change; empty memos only |
| Fees | Input total equals eligible receipts; actual input-minus-output fee equals the bundle balance, meets pinned ZIP-317 minimum and stays within approved ceiling |
| Explicit approval | Review digest binds the complete native policy and original PCZT bytes; signing repeats all checks and requires that digest |

Zero-value padding still passes native value/commitment checks; its ciphertext need not decrypt. Redacted or plaintext-memo ciphertext representations are rejected. Dummy signatures are checked along with returned real-input signatures. Unsupported profiles fail closed rather than being converted into another transaction.

The first implementation deliberately excludes migration of Orchard notes into Ironwood, Sapling refunds, multi-pool transactions, expiring Unified Addresses, and backend-supplied arbitrary change recipients. These are limitations, not claims that Zcash lacks those capabilities.

## Independent signer integration

`services/signer/native-refund.ts` supplies `IsolatedNativeRefundSigner`, `IsolatedSpendVault`, and a bounded stdio transport. It is not imported by the wallet HTTP server, execution backend or refund-authorization service. The native process has no RPC endpoint, wallet path, wallet scanning, networking or broadcast operation.

1. Verify the existing user and operator signatures against the request and independent order/payment evidence.
2. Read native note/nullifier/anchor evidence from the signer-owned `NativeEvidenceReader`. Do not populate this interface from the incoming backend bundle.
3. Obtain a native review of the exact unsigned PCZT, including actual fee/change, input count, expiry, PCZT digest and signature hash.
4. Require the independent signer certificate and explicit native review digest, plus an unlocked isolated spending-key vault.
5. Atomically claim the request ID, order ID and each input nullifier before key use. The journal uses `synchronous=FULL` through the independent reviewer database. Input claims prevent reuse across different refund requests.
6. Sign through the native process, validate its response, then atomically save the signed PCZT, hash and review. Audit events contain the request ID/status only.
7. Retry returns the original saved PCZT. A `SIGNING` claim without saved output is uncertain and cannot sign again. `recover(id)` returns already persisted output after restart without unlocking keys. It does not create or broadcast anything.

The key travels only through the signer's private child-process stdin, never command arguments, environment variables, browser APIs or external services. Mutable Node and Rust input/key buffers are cleared where practical; JSON strings, OS pipes and runtime copies cannot be guaranteed erased. The existing approval vault remains separate from the isolated 32-byte Orchard spending-key vault. Operator and signer public keys must differ.

The low-level binary is a stateless development primitive. **Durable authorization and replay protection are provided by the TypeScript signer journal**, not by invoking the binary repeatedly by hand. The standalone Rust API does not authenticate EVM user/operator certificates; the integrated signer performs that step. A complete deployment must preserve this boundary.

## Test results and reproduction

Build the new binary before running the Node tests:

```powershell
cargo build --locked --offline --manifest-path services/refund-signer-native/Cargo.toml --target-dir target
cargo test --locked --offline --manifest-path services/refund-signer-native/Cargo.toml --target-dir target
node --import tsx --test tests/native-refund.test.ts
npm run typecheck
node scripts/phase5-native-audit.mjs
node scripts/phase5-verify.mjs
```

If the pinned crates are not cached on a new machine, omit `--offline` for the initial build while retaining `--locked`. A default Rust run reports four passing tests and one deliberately ignored expensive proof test. Run that proof test explicitly:

```powershell
cargo test --locked --offline --manifest-path services/refund-signer-native/Cargo.toml --target-dir target --test verification signed_synthetic_pczt_proves_and_extracts_a_native_transaction -- --ignored
```

The explicit proof test passed in approximately 48 seconds on this machine. Six Node integration tests cover real native signing with synthetic notes, exact replay/restart recovery, locked/unauthorized requests, tampered evidence, a database failure **after** native signing but before persistence, cross-request input claims and concurrent signing. The full Node suite passed 181 tests. No browser rerun was needed for these signer-only changes; this continuation changes no frontend or HTTP routes.

Evidence: [native verification tests](phase5-evidence/native-refund-tests.txt), [proof/extraction](phase5-evidence/native-refund-proof.txt), [full Node suite](phase5-evidence/native-refund-full-node.txt), [typecheck](phase5-evidence/native-refund-typecheck.txt), [dependency comparison](phase5-evidence/native-refund-dependencies.json).

The integration tests create exclusive, gitignored `.state/native-refund-tests/<random-id>` directories. The fixture generator writes a fresh isolated key directly to a new local file, never stdout; the harness creates and verifies its encrypted keystore and then removes **only that newly generated plaintext test key**. Existing wallet credentials are never read for signing or migrated. Disposable test passwords and destination keys are not retained for funded use. Do not fund synthetic fixture addresses or reuse their made-up chain history.

## Pins and source verification

The separate Cargo.lock resolves 186 packages. Every registry package version/checksum already occurs in the unchanged legacy Cargo.lock. Key pins: `pczt=0.10.0-pre.1`, `orchard=0.16.0`, `zcash_keys=0.17.0-pre.1`, `zcash_primitives=0.31.0-pre.1`, `zcash_protocol=0.11.0-pre.0`.

Implementation was checked against the exact installed crate sources: PCZT `roles/verifier`, `roles/signer`, `roles/creator`, `roles/io_finalizer` and `tests/end_to_end.rs`; Orchard `pczt/verify.rs` and `pczt/note_encryption.rs`; pinned consensus and ZIP-317 fee constants. The verifier role alone merely parses bundles: our policy performs semantic checks before the signer API. The output recovery helpers choose the note-encryption domain using the actual bundle version. [Maintained PCZT repository](https://github.com/zcash/librustzcash/tree/main/pczt), [maintained Orchard repository](https://github.com/zcash/orchard).

## Gates that remain closed

There is no live-enable flag or broadcast implementation. Both the backend refund service and native signer reject broadcasting. Approval certificates remain distinct from native signatures; a signed PCZT is not a confirmed refund.

The [watch-only continuation](PHASE5-WATCH-ONLY.md) supplies independently fetched real-chain evidence from a separate UFVK scanner and explicit local recovery registry. Its two new databases have a real, unfunded scan proof. The native signer refuses to sign from this `liveChain` reader pending separate-device validation. Funded-note validation, production deployment, PCZT export from actual wallet notes and separate-device validation remain necessary. Proving/extraction and exact transaction storage are now available through the synthetic portable workflow, not a funded transport. Broadcast outcome reconciliation, refund wallet-history matching and ten-confirmation finalization still need production integration and live validation; the separate simulated delivery journal tests those failure scenarios without sending funds.

A second process on this Windows account is not signer isolation. Keep existing merchant seeds out of this path. Separate-device validation must establish exclusive spending-key custody and verify the full request/evidence/PCZT exchange before any funded refund is enabled. No Phase 5 completion or live-refund claim is made.
