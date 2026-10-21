# Mainnet acceptance continuation — 21 October 2026

**Decision: mainnet execution remains disabled.** The two controlled transfers are now blocked by operator infrastructure and live acceptance evidence rather than by the two code defects identified in the earlier audit. This change did not provision production credentials, unlock a key, send ZEC, sign, broadcast, or enable refunds.

## What changed

- **Zcash owned-note verification — implementation PASS; live acceptance BLOCKED.** `observe-mainnet` still uses the maintained Zcash SDK wallet sync, then independently fetches the candidate's full transaction bytes from both configured lightwalletd providers. Both providers must agree on bytes, mined height, and the block hash returned at that height. The scanner parses the transaction using the mainnet consensus branch and trial-decrypts it with the imported UFVK through `zcash_client_backend::decrypt_transaction`. The exact account, pool, output index, incoming transfer type, value, and receiver must match. Memo and the ownership-evidence digest come from the freshly decrypted output. SQLite is only a candidate index.
- **Payment-to-execution binding — fixture PASS; live acceptance BLOCKED.** TypeScript accepts ownership only from the native scanner object produced in the current process. JSON copies, caller-created objects, and edited SQLite `confirmed` fields cannot create an execution grant. A rescan or journal close invalidates the previous grant, a reorg marks the evidence invalid with `MAINNET_CHAIN_REORGANIZATION`, and authorization rejects observations older than 120 seconds. After restart, the service must run a fresh native observation. The one-use payment digest, exact order, and source zatoshis are checked at the execution boundary, including a final check immediately before journal preparation.
- **Base/Solana submission — fixture PASS; live acceptance BLOCKED.** The new library-only one-shot executor verifies an offline signed bundle, a separately pinned Ed25519 operator authorization, exact terms/prepared/signed digests, expiry, spending cap, and current two-provider state. Signed bytes are persisted before the single submission attempt. Base uses `eth_sendRawTransaction`; Solana uses `sendTransaction` with signature verification and no RPC retries. A lost or malformed response becomes `uncertain` and cannot produce a replacement submission. Existing exact transaction IDs are reconciled before any send. Finality continues through the existing canonical two-provider receipt readers. No operator CLI invokes the executor, and production signer/broadcast credentials are still absent.
- **Legacy facade — intentionally closed.** `submitMainnetTransfer()` still throws. This prevents older metadata-only callers from gaining a sender. The authenticated library path is `executeMainnetTransfer()` and requires a fresh cryptographic payment observation; it is not wired into an operator command.

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
- **Single-writer deployment: BLOCKED.** The atomic SQLite design passes restart/concurrency tests, but the intended deployment topology and shared durable volume have not been demonstrated.

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

- `npm test`: **497 passed, 0 failed**. The suite includes disposable local Anvil transactions; the sandboxed attempt failed because loopback sockets were prohibited, and the approved unrestricted rerun passed.
- Rust Zcash watch: **9 passed, 0 failed**. `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and the `zecone-zcash-watch` build passed.
- Focused watch/executor tests: **19 passed**, including **7 executor tests** covering one-shot Base and Solana submission, copied-payment rejection, rescan invalidation, and concurrent single-grant consumption.
- `npm run typecheck`, `npm run typecheck:web`, `npm run lint`, `npm run wallet:build`, and `npm run extension:build`: passed.
- Preservation: **537 + 91 protected files unchanged**; both historical settlements remain complete with one signing and one broadcast claim, refunds disabled, and financial rows unchanged.
- Read-only historical receipt recheck passed against both finalized receipts on consistent SQLite copies; saved settlement records were not rewritten and replay/refund-veto checks reached neither signer nor broadcaster.

The earlier `docs/MAINNET-ACCEPTANCE.md` remains the historical record of the defects found at commit `8906258`. This continuation supersedes its scanner and missing-sender conclusions; it does not upgrade fixture evidence to production acceptance.
