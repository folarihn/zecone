# Mainnet acceptance continuation — 21 October 2026

**Decision: mainnet execution remains disabled.** The two controlled transfers are now blocked by operator infrastructure and live acceptance evidence rather than by the two code defects identified in the earlier audit. This change did not provision production credentials, unlock a key, send ZEC, sign, broadcast, or enable refunds.

## What changed

- **Zcash owned-note verification — implementation PASS; live acceptance BLOCKED.** `observe-mainnet` still uses the maintained Zcash SDK wallet sync, then independently fetches the candidate's full transaction bytes from both configured lightwalletd providers. Both providers must agree on bytes, mined height, and the block hash returned at that height. The scanner parses the transaction using the mainnet consensus branch and trial-decrypts it with the imported UFVK through `zcash_client_backend::decrypt_transaction`. The exact account, pool, output index, incoming transfer type, value, and receiver must match. Memo and the ownership-evidence digest come from the freshly decrypted output. SQLite is only a candidate index.
- **Payment-to-execution binding — fixture PASS; live acceptance BLOCKED.** TypeScript accepts ownership only from the native scanner object produced in the current process. JSON copies, caller-created objects, and edited SQLite `confirmed` fields cannot create an execution grant. A rescan or journal close invalidates the previous grant, a reorg marks the evidence invalid with `MAINNET_CHAIN_REORGANIZATION`, and authorization rejects observations older than 120 seconds. After restart, the service must run a fresh native observation. The one-use payment digest, exact order, and source zatoshis are checked at the execution boundary, including a final check immediately before journal preparation.
- **Base/Solana submission — fixture PASS; live acceptance BLOCKED.** The one-shot executor verifies an offline signed bundle, a separately pinned Ed25519 operator authorization, exact terms/prepared/signed digests, expiry, spending cap, and current two-provider state. Signed bytes are persisted before the single submission attempt. Base uses `eth_sendRawTransaction`; Solana uses `sendTransaction` with signature verification and no RPC retries. A lost or malformed response becomes `uncertain` and cannot produce a replacement submission. Existing exact transaction IDs are reconciled before any send. Finality continues through the existing canonical two-provider receipt readers. `scripts/mainnet-operator.ts` now exposes `status`, `prepare`, `simulate`, `execute`, `reconcile`, `pause` and `revoke-signer`; execution requires the exact order digest plus explicit arm/resume strings. Production signer/broadcast credentials and providers are still absent.
- **Operator signer and single-writer — fixture PASS; live deployment BLOCKED.** The isolated signer opens a purpose-bound encrypted keystore only on explicit request, requires an exact prepared-digest approval, enforces its own durable per-transaction/daily ledger, and signs only the prepared Base/Solana transfer. A durable fenced lease guards journal preparation, claim and submission; lost leases and emergency pauses fail closed, and expired leases require explicit recovery. `docs/MAINNET-OPERATOR.md` records the exact gates. The intended production host/volume topology and physical signer separation remain unvalidated.
- **Legacy facade — intentionally closed.** `submitMainnetTransfer()` still throws. This prevents older metadata-only callers from gaining a sender. The authenticated library path is `executeMainnetTransfer()` and requires a fresh cryptographic payment observation; the new operator command invokes that path only behind all exact-order and lease gates.

## Security boundary and limitations

Owned-note evidence is cryptographically grounded in UFVK trial decryption of provider-corroborated full transaction bytes. The scanner also corroborates the transaction height's block hash with both providers. It does not operate a local Zcash consensus node or independently verify a transaction Merkle path and proof-of-work chain; two genuinely independent provider operators remain mandatory. The local Rust executable, its configuration, the service process, and the imported UFVK are trusted computing-base components. A process with code-execution rights can bypass in-process provenance checks.

No authenticated historical or controlled mainnet owned-note fixture and no configured mainnet UFVK/provider pair were available, so the scanner is not production-demonstrated. The locked Zcash crates remain pre-release versions and require dependency review before production custody decisions.

The executor deliberately contains no transaction private-key loader. Production signing must happen on a separate device and return only an exact signed bundle. The operator execution-authorization key must also be independently provisioned and separately validated. Local password encryption does not prove device isolation.

## Current launch decisions

- **Zcash scanner implementation: PASS.** Full-transaction UFVK decryption replaces metadata/nullifier ownership claims.
- **Zcash live mainnet scanner: BLOCKED.** Missing two configured independent providers, a production watch profile/UFVK, and an authenticated owned-note acceptance run.
- **Production pricing: BLOCKED.** The verifier requires two pinned signed feeds, but no genuine feed operators or keys are configured.
- **Base execution implementation: PASS in disposable fixtures.** Exact construction, offline signature verification, current-state revalidation, one-shot submission, uncertain-state handling, and canonical finality paths exist.
- **Solana execution implementation: PASS in disposable fixtures.** The same controls exist for native SOL, including blockhash validity, exact signed simulation, genesis validation, and finalized receipt effects.
- **Base live acceptance: BLOCKED.** Missing independent production RPCs, fresh recipient/relayer accounts, relayer funding, isolated signer and execution authority, live fee-policy validation, and an unsigned production rehearsal.
- **Solana live acceptance: BLOCKED.** Missing the same operator provisioning and a two-provider mainnet rehearsal.
- **Single-writer lease implementation: PASS in disposable tests.** The fenced lease, stale-process rejection, explicit expired recovery and emergency pause are implemented and tested. **Production deployment: BLOCKED.** The intended host/durable-volume topology, operator on-call runbook and process-isolation properties have not been demonstrated.

There is no current implementation FAIL known on the narrow native-transfer path. Any provider disagreement, missing pricing authority, unavailable signer isolation, insufficient liquidity, unsupported Base fee rule, or uncertain submission keeps execution disabled.

## Required operator setup for the first controlled transfers

1. Configure two independently operated Zcash mainnet lightwalletd endpoints, two Base mainnet RPCs, and two Solana mainnet RPCs. Record operator independence and verify network identities.
2. Create a watch-only Zcash mainnet profile with a UFVK and birthday through the offline workflow. Complete a controlled authenticated scan and record the decrypted owned-note evidence. Do not place a spending key on the observer.
3. Provision fresh Base and Solana recipient and relayer credentials on the designated signing device. Provision a separate Ed25519 execution-authority key. Record public identities and separate-device attestations.
4. Configure two genuine signed production price feeds with pinned authorized keys and freshness/disagreement limits.
5. Fund only the destination relayers. Confirm exact inventory, fee/rent caps, emergency pause, recipient ownership, per-transaction/daily limits, and the single-writer deployment lock.
6. Perform unsigned Base and Solana mainnet rehearsals with both providers. For Base, validate the active L1 fee formula/fork; a nonzero unsupported scalar remains fail-closed.
7. Prepare separate exact approval packages. Each must bind the source payment commitment, recipient, amount, maximum destination debit, offline signed transaction digest, transaction ID, expiry, and one-use nonce.
8. Obtain explicit operator approval only after all preceding evidence passes. Reconcile an uncertain signature before considering any replacement. Keep refunds disabled until their separate-device workflow is independently accepted.

## Validation evidence

- `npm test`: **504 passed, 0 failed**. The suite includes disposable local Anvil transactions.
- Rust Zcash watch: **9 passed, 0 failed**. `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and the `zecone-zcash-watch` build passed.
- Focused watch/executor/operator/submitter tests: **29 passed**, including **9 executor tests** and **3 operator tests** covering the fenced lease, durable signer ledger, exact Base/Solana signing, revocation, crash-left claim reconciliation and uncertain handling.
- `npm run typecheck`, `npm run typecheck:web`, `npm run lint`, `npm run wallet:build`, and `npm run extension:build`: passed.
- Preservation: **537 + 91 protected files unchanged**; both historical settlements remain complete with one signing and one broadcast claim, refunds disabled, and financial rows unchanged.
- The prior read-only historical receipt recheck remains valid because the preservation run found **0 changed files** in the protected settlement inventories. Saved records were not rewritten; every new operator test uses disposable journals.

The earlier `docs/MAINNET-ACCEPTANCE.md` remains the historical record of the defects found at commit `8906258`. This continuation supersedes its scanner and missing-sender conclusions; it does not upgrade fixture evidence to production acceptance.
