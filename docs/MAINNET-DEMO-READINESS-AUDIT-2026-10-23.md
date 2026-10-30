# ZecOne mainnet demonstration readiness audit

**Audit date:** 2026-10-23

**Demonstration deadline:** 2026-10-28

**Repository checkpoint inspected:** `257e328` plus the current uncommitted Stage 4C worktree

**Decision:** **NO-GO today for mainnet execution. Conditional GO is possible for two tightly capped, operator-driven mainnet demonstrations if every P0 gate below is closed by 2026-10-26.**

## Intended demonstration

The achievable deadline scope is two controlled native-asset settlements:

1. A user-controlled shielded Zcash mainnet payment authorizes one exact Base mainnet ETH transfer.
2. A separate user-controlled shielded Zcash mainnet payment authorizes one exact Solana mainnet SOL transfer.

The repository does not currently provide a production-ready mainnet wallet UI, arbitrary dApp signing, ERC-20/SPL support, an exchange or bridge, or automated refunds. The demonstration should use the existing operator CLI and a separate offline signer. Calling the resulting experience a public launch or an autonomous real-time bridge would be inaccurate.

## Executive assessment

ZecOne has strong transaction-policy and replay-protection foundations. The complete TypeScript regression suite passes, the Rust scanner tests and clippy pass, both TypeScript typechecks pass, and historical settlements remain unchanged. The code includes authenticated Zcash block ingestion, Orchard note decryption, durable payment binding, signed-price verification, exact Base and Solana transaction preparation, offline signature verification, broadcast uncertainty handling, finality reconciliation, single-writer reservations, emergency pause, and duplicate-settlement rejection.

The missing work is primarily the production operating system around that code. The deployed VPS container is a health-only, read-only shell. It does not continuously export authenticated Zcash blocks, scan the watch-only wallet, ingest orders, obtain production prices, prepare destination transfers, reconcile finality, or run backups. All production profiles remain disabled and contain placeholder endpoints. There are no production accounts, price authorities, independently configured Base/Solana provider pairs, off-host backup target, alerting path, funded relayers, or completed mainnet settlement.

The October 23 hardening pass resolved the identified repository defects: Next.js and the Rust TLS/webpki dependencies are patched, the 20-confirmation Zcash policy and provider pair are bound to payment evidence, the online executor accepts only external signed bundles, and a disabled-by-default checkpointed watch-only worker is implemented. Mainnet remains disabled because the operator-owned production providers, pricing authorities, identities, separate signing device, funding, off-host backup and live acceptance runs do not yet exist.

## What is demonstrated and reusable

- **Payment ownership:** The Rust watch service performs native Orchard scanning and fresh transaction decryption. It does not grant authority from user-supplied JSON or mutable SQLite status alone.
- **Authenticated chain input:** The Stage 4C exporter can require byte-identical raw mainnet blocks from two configured HTTPS operators and validate header proof of work, transaction Merkle inclusion, segment continuity, and accumulated work.
- **Durable authorization:** Verified payments bind to one order, recipient, network, amount, fees, signer, and execution limits. Payment reuse, concurrent execution, and completed-order replay fail closed.
- **Destination execution:** Base and Solana native-transfer preparation, offline signature verification, one-time submission, uncertain-broadcast handling, and finality/effect verification exist and are covered by tests.
- **Financial controls:** The implementation contains emergency pause, per-transaction/daily limits, inventory reservations, a single-writer lease, provider disagreement handling, and immutable signed price-quote checks.
- **Credential tooling:** Disposable Base, Solana, and Zcash mainnet account provisioning, authenticated encryption, backup/recovery, role/network separation, and offline signing paths are implemented and tested.
- **Infrastructure:** The shared Contabo VPS has an isolated 50 GiB ZecOne filesystem and a dedicated Docker daemon. The existing deployed container is deliberately non-executing and leaves the other applications intact.

## P0 launch blockers

### 1. The deployed service does not run the product workflow — CODE RESOLVED, DEPLOYMENT BLOCKED

`deploy/Dockerfile` starts `scripts/vps-readonly-service.ts`. That process exposes health/readiness and persists fail-closed controls, but it is not a Zcash watcher or settlement worker. No supervisor currently runs block export, wallet scanning, quote intake, execution preparation, finality reconciliation, backup, or alerts.

**Implemented:** A fail-closed worker now advances authenticated raw blocks, scans the UFVK-only wallet, persists atomic checkpoints, detects provider disagreement/reorgs, reports bounded lag and resumes after restart. It ships disabled and has no signer, submitter, refund or mutation endpoint. Activation still requires the production UFVK/birthday, provider configuration, storage sizing, reviewed image and deployment approval.

### 2. Real-time Zcash observation is not wired — CODE RESOLVED, OPERATIONS BLOCKED

The scanner consumes pre-staged authenticated raw blocks from a directory. The exporter is a one-shot command requiring a fixed start height and count. No durable loop advances the exported range, verifies both sources, invokes scanning, records checkpoints, handles reorgs, or alerts on lag.

**Implemented:** The new worker has an exclusive lock, bounded exponential retry, atomic Linux persistence, authenticated-corpus promotion, scan freshness, lag monitoring and restart/reorg checks. The separate raw-evidence depth means a 20-confirmation payment can be observed later than 20 confirmations; this is a conservative latency limitation, not an early-settlement bypass.

### 3. Zcash confirmation policy is inconsistent — RESOLVED

The scanner handoff currently invokes the native scanner with a hard-coded 10-confirmation minimum, while the production profile validation and templates require at least 20. The execution path does not cryptographically bind the scanner's provider pair and confirmation policy to the trusted production profile.

**Implemented:** The scanner now requires the exact Zcash production provider pair and at least 20 confirmations. Provider identities and the threshold are included in the payment digest and revalidated against native output. Query/userinfo credentials are rejected in policy endpoints. Reorg, restart, replay and preservation tests pass.

### 4. Mainnet profiles are placeholders and disabled

Zcash, Base, and Solana profiles are disabled. Provider environment names, recipients, relayers, signer identities, price authorities, execution limits, and live controls are incomplete or null. This is correct fail-closed behavior, but it means no live execution can begin.

**Required:** Create a separate operator-owned production configuration outside Git, validate it with the existing configuration checker, and retain a sanitized fingerprint in evidence. Never put API secrets or private keys in the repository.

### 5. Independent provider corroboration is incomplete

Stage 4C demonstrated matching Zcash raw blocks, but provider independence and SLA remain unverified, and a second-day successful sample is still required. Base and Solana mainnet evidence is `PRIMARY_ONLY` in the latest readiness evidence.

**Required:** Configure two independently operated providers for each network, pin chain/genesis identity, validate agreement and disagreement paths, and record fresh read-only evidence. Do not count two endpoints operated by the same vendor as independent.

### 6. No genuine production pricing operation exists

The verifier correctly requires two signed Ed25519 feeds with pinned authorities, asset pair, network, timestamp, expiry, context, and digest binding. There are no provisioned production authority keys, two independent feed operators, or a live freshness/availability process.

**Required:** Operate two independently controlled signed price producers, define the ZEC/ETH and ZEC/SOL source methodology, enforce maximum age/deviation, rehearse stale/manipulated/replayed feed failures, and persist the exact accepted quote. Without this, source ZEC amounts cannot be safely calculated.

### 7. Production keys and accounts do not exist

No production Zcash receiver/UFVK and birthday, Base recipient and relayer, Solana recipient and relayer, execution authority, price authorities, or age backup recipient have been provisioned and verified. Existing testnet credentials cannot be reused.

**Required:** Provision fresh mainnet roles with the encrypted vault, produce public-address ownership proofs, back them up, and perform recovery on disposable copies. Keep recipient, relayer, pricing, and Zcash watch roles separate.

### 8. Signer isolation has not been demonstrated — ONLINE PATH RESOLVED, DEVICE VALIDATION BLOCKED

The CLI supports external signed bundles, but it also permits a local encrypted signer to be opened inside the same online process that calls providers and broadcasts. A `separateDeviceValidated` configuration claim does not establish physical isolation.

**Implemented:** The online operator now requires an externally signed bundle and contains no keystore/passphrase unlock path. A network-free CLI signs an exact reviewed digest, requires an enabled profile and durable signer ledger, and writes signed bytes only to an exclusive file. A separate physical computer and its attestation/restore drill remain mandatory before mainnet signing.

### 9. Mainnet wallets are unfunded

The Base and Solana relayers need enough native asset for the exact delivery plus fees/rent and a small bounded retry reserve. The user-controlled Zcash payer needs real mainnet ZEC. Zcash mainnet has no faucet.

**Required:** Fund only after configuration, backup, ownership proofs, provider corroboration, signed pricing, simulation, and emergency-stop rehearsal pass. Use the smallest practical pilot amounts and explicit per-transaction/daily caps.

### 10. Production backup and alerting are incomplete

Age encryption and restore mechanics pass disposable tests, but no production age recipient, off-host destination, uploader, retention policy, scheduled job, failure alert, or real restore drill exists.

**Required:** Configure an off-host encrypted destination, schedule backup and verification, alert on failure, and complete a timed restore drill. A local encrypted file on the VPS is not an off-host backup.

### 11. Dependency advisories must be patched — RESOLVED

- `next@16.4.0` is affected by two critical remote-code-execution advisories and one high denial-of-service advisory. The available non-major fix is `16.4.2`.
- `rustls@0.23.45`, `rustls-webpki@0.103.15`, and `webpki-roots@1.0.9` are flagged by current RustSec data. Patched versions are `rustls >=0.23.46`, `rustls-webpki >=0.103.16`, and `webpki-roots >=1.0.10`.

**Implemented:** Next.js is now 16.4.2; rustls is 0.23.46, rustls-webpki is 0.103.16, webpki-roots is 1.0.10 and ctutils is 0.4.4 across all lockfiles. `npm audit` reports zero vulnerabilities and all three Rust lockfiles pass the current RustSec database. The workstation Docker daemon is unavailable, so the final immutable container rebuild and digest remain an operator deployment step.

### 12. No real mainnet end-to-end settlement has been completed

The implementation has extensive fixture, local-chain, testnet, and read-only mainnet evidence. It has no live shielded ZEC mainnet payment followed by a finalized Base or Solana mainnet payout.

**Required:** Complete Base first under an explicit capped approval package, reconcile after restart, verify duplicate rejection, then repeat separately for Solana. Do not combine both chains into one source payment or approval.

### 13. The current release candidate is not clean or deployed

The inspected worktree has active uncommitted Stage 4C changes, modified historical browser evidence, an untracked deployment context/tarball, and new evidence files. The changes may be valid, but the exact release is not a clean immutable commit or deployed image digest.

**Required:** Separate current Stage 4C changes from unrelated historical artifact changes, remove or archive stale build context safely, review the diff, commit the intended release, tag it, build from that commit, record the image digest, and preserve a clean status.

## Important security and reliability risks

- **Partial Zcash consensus validation:** The local verifier checks proof of work, header/target validity, transaction Merkle inclusion, and short segment continuity/work. It does not recompute every ZIP-244 commitment or validate the full chain from a trusted checkpoint/genesis. A capped demonstration therefore still trusts the configured raw-block providers and checkpoint policy. Full-node validation is preferable, but the current VPS does not meet Zebra's recommended resources.
- **Shared-host trust:** The ZecOne container uses host networking on a VPS that also runs unrelated root-owned applications. Even with read-only mounts, host networking exposes other localhost services. Keep only watch-only material on this host and restrict the worker to exact outbound endpoints.
- **No production CI/release pipeline:** There is no tracked `.github` workflow, mandatory dependency scan, SBOM, image signature, reproducible-build record, or digest-pinned base image policy.
- **Pre-release Zcash crates:** The watch service pins pre-release Zcash Rust crates. Their maintained state and compatibility need explicit review before a public production claim.
- **Operator dependence:** Recovery, uncertain-broadcast reconciliation, export advancement, signing transfer, and price operation require trained operators. A live demo must have two operators and a rehearsed runbook.
- **Privacy limits:** Zcash payment details remain shielded on-chain, but the operator journal can correlate a payment with destination addresses. Base and Solana destination activity is public. RPC operators see queried public-chain addresses and timing. Do not claim end-to-end anonymity.

## Readiness by component

- **PASS — transaction policy and replay protection:** Demonstrated by regression tests, durable journals, single-writer claims, source-payment uniqueness, and finalized-effect checks.
- **PASS — Rust watch logic in tests:** Clippy passes and 16 Rust tests pass, including native ownership evidence and authenticated-block checks.
- **PASS — historical preservation:** All 537 historical and 91 Phase 7B protected files are unchanged; Phase 7B and Phase 7C settlements remain completed; refunds remain disabled; financial fingerprints are unchanged.
- **PARTIAL — Zcash live observation:** Native scanning, authenticated export, continuous orchestration and policy binding are implemented and locally tested. Production UFVK/birthday, deployment, second-day evidence and stronger consensus assurance remain missing.
- **PARTIAL — Base/Solana executors:** Construction, offline verification, one-shot submission, and finality logic exist; production providers, accounts, funding, live simulations, and completed mainnet settlements are missing.
- **PARTIAL — VPS:** Capacity and isolation are sufficient for the lightweight watch service; the deployed process is health-only, backup/alerting is absent, and the host cannot safely hold signing keys.
- **BLOCKED — production pricing:** Correct verifier, no live independent signed feeds.
- **BLOCKED — key isolation:** The online local-signer path has been removed; a separate physical signing device and production validation are still missing.
- **BLOCKED — public wallet experience:** The current wallet/extension supports testnet paths; the mainnet path is operator CLI only.
- **BLOCKED — mainnet execution:** Disabled configuration, no production identities, no funded relayers, no accepted quote, and no explicit per-transaction approval package.

## Five-day critical path

### October 23

- Freeze scope to the two native transfers and declare every other adapter out of demo scope.
- Patch Next.js and Rust TLS/webpki dependencies.
- Fix the 10-versus-20 confirmation mismatch and bind scanner policy to production configuration.
- Require external offline signing bundles for mainnet.
- Reconcile and commit the Stage 4C worktree; tag the release candidate.
- Re-run all tests, typechecks, lint, builds, dependency audits, preservation, and container build.

### October 24

- Provision fresh production recipients, relayers, Zcash watch profile, execution authority, price authorities, and backup recipient on controlled devices.
- Configure two independent providers per chain and two signed pricing operators.
- Implement or configure the checkpointed watch/export/reconcile runner and alerts.
- Complete encrypted off-host backup and restore drill.

### October 25

- Record a second-day Zcash provider comparison.
- Run Base and Solana read-only chain/genesis, fee, balance, finality, and provider-disagreement checks.
- Produce exact sanitized configuration fingerprints and approval packages.
- Rehearse emergency pause, signer revocation, uncertain broadcast, restart reconciliation, and duplicate rejection.
- Make the GO/NO-GO decision by **18:00 WAT**.

### October 26

- If every gate passes, fund the capped Zcash payer and Base relayer.
- With separate explicit financial approval, execute the Base mainnet demonstration transaction.
- Verify finality, recipient balance delta, actual fees, restart reconciliation, and duplicate rejection.

### October 27

- If Base evidence is clean, fund and separately authorize the Solana mainnet demonstration transaction.
- Verify finalized effects, recipient balance delta, relayer debit, restart reconciliation, and duplicate rejection.
- Freeze code and rehearse the exact demonstration script.

### October 28

- Demonstrate using the frozen image and previously tested operator runbook.
- Keep an emergency pause operator present. Make no same-day feature or dependency changes.

## Hard GO/NO-GO gates

All of the following must be true before mainnet funds move:

- Dependency audits contain no unresolved critical/high issue in an exposed path.
- The exact Git commit and container image digest are recorded and the worktree is clean.
- Two independent providers agree for Zcash, Base, and Solana; chain/genesis identities are pinned.
- Zcash confirmation policy is consistently enforced and the watch runner is current and restart-safe.
- Two genuine, pinned price authorities produce fresh agreeing quotes.
- Fresh production accounts exist, ownership is proved, backups are restored, and roles are separated.
- The signing device is physically separate and the online/VPS machines contain no spending key.
- Off-host encrypted backup, alerting, and emergency pause are rehearsed.
- Relayer balances and exact spending caps are sufficient and independently reviewed.
- The exact transaction simulates through both providers and every account/instruction is allowlisted.
- A named operator owns uncertain-broadcast reconciliation and a second operator witnesses approval.

Failure of any gate means **do not spend mainnet funds**. The fallback demonstration should use the already completed testnet/devnet settlements plus live read-only mainnet observation.

## Minimum operator inputs still required

- Access to a separate physical computer for Base and Solana offline signing.
- A user-controlled source of a small amount of real mainnet ZEC.
- Fresh ZecOne-managed Base and Solana recipient and relayer public addresses, generated after the security fixes.
- Credentials for two independently operated providers on each chain.
- Two independent pricing-authority operators and their pinned public keys.
- An age public recipient, off-host storage destination, retention policy, and alert channel.
- Explicit acceptance or rejection of the capped-demo trust model for Zcash raw-block verification without a full Zebra node.
- Separate, exact approvals for funding and each live mainnet payment/settlement.

## Validation evidence from this audit

- Full Node/TypeScript test suite after hardening: **541 passed, 0 failed**. The final rerun adds coverage for worker lock release after a corrupt checkpoint, contiguous authenticated manifest heights, and VPS health failing closed after the watch worker exits. One earlier run hit a transient Windows disposable-directory rename error; the exact test and final full rerun passed.
- TypeScript application typecheck: **PASS**.
- Web TypeScript typecheck: **PASS**.
- Repository lint/format check: **PASS**.
- Wallet production build: **PASS**.
- Browser extension build: **PASS**; output reported no credentials included.
- Rust Zcash watch clippy with warnings denied: **PASS**.
- Rust Zcash watch tests: **16 passed, 0 failed**.
- Git diff whitespace check: **PASS** with line-ending warnings only.
- Preservation: **537/537 historical files unchanged; 91/91 Phase 7B files unchanged; completed Phase 7B/7C financial rows unchanged; refunds disabled**.
- Dependency audit: **PASS**. Production npm audit reports zero vulnerabilities and all three Rust lockfiles pass the current RustSec advisory database.
- Current repository state: **DIRTY**; release candidate is not yet an immutable, deployed build.

## Final decision

ZecOne is not ready today for a public mainnet product demonstration. It can plausibly be made ready for two controlled, capped, operator-driven mainnet transfers by October 28, but only if the team treats the next three days as a release-hardening and operations sprint. The critical work is dependency patching, confirmation-policy binding, continuous watch orchestration, real provider and pricing configuration, physically separate signing, backups, funding, and two staged live rehearsals. Do not spend mainnet funds to compensate for a missed gate.
