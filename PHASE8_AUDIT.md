# Phase 8 audit — review gate

Audit date: 17 October 2026. Starting checkpoint: `da18524`, initially clean. User deadline: **28 October 2026**, Africa/Lagos; exact demo time is unspecified. This is an audit of a testnet demonstration, not a production security certification. **Phase 8A has not started.** No application code, wallet credential, refund gate or execution policy was changed during this audit.

## Decision

Keep the existing architecture and completed settlements. Implement 8A privacy projection and retention boundaries first, 8B new-wallet locking second, 8C explicit provider confidence third, and 8D targeted usability corrections last. Preserve financial journals and evidence; do not attempt a wallet migration, new bridge, new live settlement, or broad UI rewrite before the demo.

The strongest existing controls are durable payment ownership, recipient/economic binding, atomic execution claims, signed evidence before submission, and reconciliation instead of automatic replacement after uncertain submission. The principal gaps are inconsistent browser data minimization, legacy plaintext credentials, inconsistent lock semantics, and single-provider finality evidence.

## Architecture and demonstrated capability

- **Zcash Rust:** `services/zcash` constructs bounded testnet shielded payments; `services/zcash-watch` scans isolated watch-only wallets without spending authority. Watch snapshots supply confirmed payment evidence to TypeScript settlement. Viewing authority remains sensitive even though it cannot spend. Legacy wallet paths and the unresolved original transfer are quarantined by the isolated payment paths.
- **Durable orchestration:** `services/execution/store.ts` owns SQLite orders, unique payments, audit and recovery records. `services/solana/settlement.ts` adds immutable Solana intent, confirmed-payment authorization, preparation/signing claims, signed bytes, signature and receipt. `paid-recovery.ts` distinguishes preparation recovery, exact approval and explicitly bounded one-order authority. Constructors can migrate tables/recover interrupted states, so the audit opened original journals read-only and ran lifecycle probes on consistent backups.
- **EVM:** `services/execution`, `services/evm`, marketplace, swap and Seaport adapters implement restricted testnet actions, NFT mint/delivery and prefunded settlement. Allowed destinations include Base Sepolia (84532), Ethereum Sepolia (11155111), and Robinhood Chain Testnet (46630). Arbitrary mainnet execution is not an available settlement feature. These are distinct adapters, not one universal production bridge.
- **Solana:** devnet genesis pinning, bounded SOL/SPL transaction policy, one allowlisted Raydium CPMM route, pool/program validation, simulation, fee/rent limits and finalized effect verification. Phase 7B SOL delivery and Phase 7C SPL swap are real completed demonstrations. New Solana encrypted accounts coexist with the historical plaintext relayer deliberately selected for the completed swap.
- **Browser/application:** Next.js/React wallet, loopback paired APIs, unified checkout views, EIP-1193/EIP-6963 extension discovery and Solana Wallet Standard discovery. Solana website signing remains rejection-only; operator settlement is a separate path. Local installed-extension fixtures do not prove arbitrary real-dApp compatibility. Earlier OpenSea evidence does not establish current universal marketplace support.
- **Refunds:** native verification/signing and independent approval architecture exist, with simulated local isolation. Separate-device validation is still unavailable. Live refunds remain disabled; no audit activity changes that.

This is a trusted, prefunded inventory model with demonstration pricing. Shielded ZEC receipt authorizes a separate destination-chain action; it does not cryptographically bridge or exchange the received ZEC on-chain.

## Completed settlement preservation

Both original journals independently report one general order `settled`, one Solana settlement `COMPLETED`, an execution claim, persisted signed wire, signature and receipt, and an active confirmed payment. Each contains exactly one signing claim and one broadcast claim. No new order or payment was created.

Read-only devnet receipt queries matched both saved finalized receipts. Rechecking the Phase 7C receipt's policy effects returned **76.043880 output tokens**, **0.003981880 SOL total relayer debit**, including **0.002976880 SOL rent**. These are historical transaction effects, not a new transaction or a claim about today's total wallet balance. The audit does not republish payment IDs, order-to-recipient joins or full transaction bytes.

Consistent SQLite backups were reopened through the existing service to simulate restart. Both completed orders rejected preparation and execution before signer access and vetoed refunds. The audit network send method and signer were poisoned: zero calls/accesses. This complements existing synthetic concurrency/replay tests; it is not a new live execution test. Evidence: [completed-order audit](docs/phase8-evidence/completed-order-audit.json).

The exact protected-path inventories are `.state/phase6/preserved.json` (537) and `.state/phase7c/phase7b-preserved.json` (91), with 628 distinct entries. Paths include Windows backslashes and must be normalized before categorization. Their exact audit copy is private at `.state/phase8/protected-inventory.private.json`.

- Historical 537: 367 credential-area files, 126 private-state files, 44 historical evidence files.
- Phase 7B 91: 8 credential-area files, 38 private-state files, 45 historical evidence files.
- No application source files are in these two inventories. Source changes proposed below do not require editing protected evidence or credentials.

Do not publish those inventories: they contain sensitive wallet paths and credential fingerprints. The public [preservation result](docs/phase8-evidence/preservation.json) contains counts and state assertions only. Financial-row fingerprints are private and compared before/after validation; browser session ownership/audit metadata can change during existing UI tests without changing completed financial records.

## Prioritized findings

Severity here reflects this local demo's threat model. No claim is made that all vulnerabilities have been found or that a passing test suite proves security.

### High — legacy browser routes expose unnecessary cross-chain joins

`services/solana/settlement-api.ts:12` spreads the full service view and removes only `paymentAddress`; its authenticated status endpoint lists all orders in the profile. `services/wallet/checkouts.ts:74` projects payment reference, recipient and destination reference into the same browser object. `app/checkout/tracker.tsx:39` persists the selected checkout key in localStorage across sessions. These are local authenticated disclosures, not evidence of unauthenticated remote theft, but a shared browser/profile, compromised same-origin script or exported capture can retain correlations unnecessarily.

Phase 7C already uses a safer positive projection, opaque session-scoped handles and explicit payment-address inspection. Apply that pattern consistently. Strip payment IDs and internal identifiers from routine list/status responses, use per-session opaque selection, and make private inspection a deliberate action with an explicit trust notice. Do not remove backend payment identity or weaken payment uniqueness.

### High — mixed plaintext/encrypted keys and long-lived signer authority

`services/solana/accounts.ts:38` loads plaintext seed arrays; `list()` reads those files even for public metadata. `services/execution/io.ts` loads plaintext EVM private-key JSON, and `services/execution/base.ts:19` loads the relayer account in its constructor. Legacy Zcash uses a local plaintext seed file. These are historical development credentials, not protected by a universal password vault. Same-user filesystem compromise can reach multiple roles.

New encrypted Solana accounts and the refund approval vault improve individual paths but do not retroactively secure the historical relayer. Keep credentials untouched. Add opt-in new-account encryption and bounded signer access; explicitly label historical paths as legacy. Do not silently import or migrate old keys, reuse the quarantined wallet, or claim physical user/backend isolation under the same OS account.

### High — missing Solana inactivity lock and asynchronous unlock cancellation

`services/solana/encrypted-accounts.ts:63` decrypts asynchronously and later populates an unlocked signer map; `lock()` at line 91 clears only that map. Neither this manager nor `accounts.ts` implements an inactivity timer, failed-attempt throttling or a generation token to prevent a pending unlock completing after a lock request. This is a source-observed race possibility, not a demonstrated live compromise.

Reuse the cancellation/TTL concepts in `ApprovalVault`, with per-role leases, explicit lock state, delayed-unlock cancellation and bounded failed-attempt handling. A browser session expiry must not be presented as locking signing keys. JavaScript strings, parsed JSON and CryptoKey internals cannot be reliably erased; minimize lifetime without claiming complete memory erasure.

### High for settlement confidence — failover is not independent finality verification

`services/solana/network.ts:135` can compare two configured pool snapshots and rejects actual contradictions. An unavailable peer is classified as degraded, and the first result can still be accepted. Distinct endpoints are not checked for independent operators. `SolanaSettlementNetwork.receipt()` obtains finalized effects from one selected provider. The status corroboration helper is not an integrated, live independent finality quorum.

EVM adapters pin chain ID and check canonical receipts/depth against one configured provider per chain; they do not independently corroborate finality. Zcash's refund evidence has a separate operator/checkpoint-agreement mechanism, but this is not equivalent to running independent full consensus nodes, nor does it cover every destination read.

Require an explicit confidence mode and fail closed when an operation configured to require corroboration lacks it. Compare material receipt/block/account fields at compatible contexts. A changed live pool at different finalized slots can cause conservative disagreement today; do not resolve this by choosing a preferred price or weakening economic bounds.

### Medium — legacy startup combines presentation and signing-capable workers

`services/wallet/server.ts:78` describes launcher pairing as “unlock” and then starts engine refresh and marketplace/swap/Seaport workers. `Base` eagerly holds signing authority. The legacy server also writes the historical pairing file. This is not a safe generic audit/demo entry point. Existing isolated Phase 7C and read-only snapshot entry points avoid this coupling.

Keep audit and demo startup on explicit isolated/read-only entry points. Later separate display/pairing, key unlock, operator authorization and worker activation. Verify that UI read paths cannot start a signing-capable worker. No legacy server was launched during this audit.

### Medium — retention and log safety are uneven

Phase 7C diagnostics use bounded categories and exclude endpoint URLs, arguments, raw errors and shielded payment joins. Its diagnostic retention is bounded. SQLite financial audit trails, private evidence, historical screenshots and checkout browser selection have no unified documented retention/export policy. Gitignore prevents accidental tracking; it does not encrypt files or restrict local access.

Define separate retention classes: ephemeral diagnostics/session data; private operator evidence; immutable financial/replay evidence. Never delete payment uniqueness, signatures or claims to satisfy retention. Redact before logging, use safe exports, and keep screenshots private. Historical protected files cannot be sanitized in place; stop republishing them and constrain new exports.

### Medium — discovery and address reuse remain linkable

`extension/manifest.json` injects discovery on top-level HTTPS sites. Sites can fingerprint ZecOne availability; account permissions do not hide installed-wallet presence. Reusing an EVM account across networks or a Solana recipient links public activity. Phase 7C's hashed recipient reuse marker is not anonymity: public addresses can be guessed and hashed.

Fresh opt-in recipient accounts can reduce direct address reuse, but destination ownership, funding, timing, RPC metadata and relayer records remain correlatable. Do not change the recipient of an existing order. Broad discovery is a compatibility/privacy tradeoff; consider an opt-in per-site mode only after testing real connection behavior.

### Medium — misleading or missing UX states

`app/solana/swap.tsx:34` swallows initial configuration/status failures and returns no panel until configuration exists. Users can see a blank or stale view without an actionable error. Token figures are shown in base units, and generic state labels do not consistently explain pending/recovery actions. Copy still describes separate exact approvals even though explicitly bounded authority is supported for the completed order. The adjacent generic Solana panel can say swaps are unsupported while the restricted swap panel exists.

`app/wallet.tsx:749` labels its Zcash card shielded while presenting a total/spendable aggregate rather than explicit per-pool shielded/transparent values. Do not invent a transparent balance of zero or derive it from total minus spendable; pending/locked funds are not a privacy pool. Expose verified pool data or say “not available.” Navigation, mobile layout and existing accessibility coverage are a useful base; fix errors, units, freshness and provenance first.

## Key storage and signing model

- **Historical EVM:** separate user/relayer JSON files; viem signing locally. The backend normally loads relayer credentials, while user intent tools use the user path. Separation is by role/path/process, not a separate device or hardened OS boundary.
- **Historical Zcash:** plaintext local seed, native Rust signing, durable construction/broadcast guards. Isolated newer payment tools pass seed bytes locally and restrict namespaces. The backend watch-only scanner does not receive a spending key, but local operator tools still have access to plaintext development seed material.
- **Historical Solana:** plaintext seed arrays, explicit unlock boolean and in-memory WebCrypto signer map. The funded historical relayer used for Phase 7C remains in this category.
- **New Solana:** `age-encryption` **0.3.1**, passphrase recipient using scrypt (installed default logN=18, r=8, p=1) and the age authenticated format. Seed buffers are wiped in finally blocks and public address identity is checked after decrypt. No unlock TTL/backoff currently. Windows DPAPI CurrentUser seals a local unlock secret; any process with equivalent user access may unseal it. A DPAPI-stored passphrase alongside same-user-accessible ciphertext is convenience, not an independent password or hardware boundary.
- **Refund approval vault:** versioned scrypt N=131072/r=8/p=1 and AES-256-GCM envelope with purpose-bound authenticated data. `ApprovalVault` has explicit consent, bounded TTL, timer and generation cancellation. This is a scoped isolated signer facility, not the common wallet vault. Native refund signing is not activated for live use.
- **Files/memory:** exclusive creation and mode 0600 are useful intentions, but Windows effective ACLs must be checked explicitly. No audit read secret contents or verified real credential ACLs. JS passphrase strings and retained signer objects prevent strong memory-zeroization claims. No hardware-backed guarantee exists.

The installed package pins are the audited baseline, not a claim they are the latest releases: Node 24.x requirement, TypeScript 7.0.2, Next 16.4.0, React 19.3.0, viem 2.57.4, Solana Kit 8.5.0, age-encryption 0.3.1. Rust dependency resolution is captured by the existing lockfiles. Dependency vulnerability assessment and cryptographic implementation review remain separate work; do not introduce an upgrade sweep into this deadline.

## RPC independence status and privacy surface

Solana primary defaults to `https://api.devnet.solana.com`; `ZECONE_SOLANA_RPC_PRIMARY` and optional `ZECONE_SOLANA_RPC_SECONDARY` support explicit HTTPS configuration. Genesis is pinned to devnet. Requests have deadlines, bounded attempts/backoff and redacted classifications; pool account reads use finalized snapshots and monotonic context. Broadcast is deliberately single-attempt with durable prior evidence, not read-retry failover.

No independent secondary was configured/validated in the checkpoint evidence. This audit's fresh finalized reads used the default primary. Synthetic failover tests are not independent live-provider validation. Do not claim redundancy from two URLs without independently operated providers and an actual successful comparison. No paid provider was purchased or endpoint credential requested.

The ordinary EVM registry has one endpoint per test chain. The Zcash watch default is testnet.zec.rocks, with explicit allowlisted alternative operators for applicable evidence checks. This audit did not rescan historical wallets or repeat live Zcash consensus checks.

Visibility boundaries:

- The trusted operator can correlate the shielded receiving request, amount, timing and destination order, and has prefunded destination inventory. Watch/viewing authority can reveal wallet receipts.
- Zcash lightwallet infrastructure sees client IP/timing and query patterns. Shielding does not conceal metadata from every service.
- Solana/EVM RPC providers see client IP, timing, public addresses, queried programs and simulated/submitted destination bytes. A second provider expands metadata exposure; fan out only the required public route/effect evidence, not full wallet histories.
- Destination blockchains expose transaction, relayer, recipient, amounts, token ownership and public account relations. A shielded source does not make these anonymous.
- Connected dApps see approved public account/origin interaction and can fingerprint wallet discovery. Browser extensions and local authenticated pages are separate trust surfaces.
- No analytics SDK was identified in the inspected application/extension sources. That is not a guarantee that RPCs, dApps, browsers or hosting infrastructure collect no telemetry. Build telemetry settings are separate from runtime network privacy.

Solana requests must continue to contain only destination data; never append a Zcash transaction ID to RPC/DEX parameters, explorer URLs or analytics. Sensitive joins belong only in restricted local financial records.

## Proposed implementation boundaries and exact files

These are proposals for later authorization, **not changes made by this audit**. All listed existing source/test files are outside the 628 protected-file inventory. Preserve historical documents/evidence directories and every credential/state file in the inventories. New documentation/evidence must use Phase 8-specific paths. Do not change completed intent, wire, signature, receipt, payment ownership, deadline or authorization history.

**8A — privacy projection and retention (about 1.5–2.5 engineer-days):** modify `services/solana/settlement-api.ts`, `services/solana/privacy.ts`, `services/solana/swap-api.ts`, `services/wallet/checkouts.ts`, `services/wallet/snapshot-api.ts`, `app/checkout/tracker.tsx`; add `services/wallet/privacy.ts`, `tests/phase8-privacy.test.ts`, and `docs/PHASE8A-PRIVACY.md`. Positive response allowlists, opaque session selection, explicit private inspection, safe export and diagnostic-only retention. Test network request bodies, errors, browser storage and export contents. No financial-record deletion or historical export edits.

**8B — new credentials and signer leases (about 2–3 engineer-days):** modify `services/solana/encrypted-accounts.ts`, `services/solana/windows-unlock.ts`, `services/signer/keystore.ts`, `scripts/phase7c-recipient.ts`; add `services/signer/lease.ts`, `services/signer/wallet-vault.ts`, `scripts/phase8-wallet.ts`, `tests/phase8-keys.test.ts`, and `docs/PHASE8B-KEYS.md`. New opt-in credential creation/import only; no reading/copying old keys as an automatic startup operation. Test lock/unlock races, inactivity, failed attempts, role separation and plaintext leakage using disposable secrets. Historical `accounts.ts`, EVM key files, Zcash seeds and the completed relayer stay untouched. Any later encrypted EVM/Zcash active-path integration requires a separately reviewed plan and isolated tools; do not advertise it as done merely because a generic vault exists.

**8C — evidence confidence (about 2–3 engineer-days, plus provider availability):** modify `services/solana/network.ts`, `services/solana/rpc-reliability.ts`, `services/solana/confirmation.ts`, `services/solana/settlement.ts`, `services/evm/adapter.ts`, `services/evm/networks.ts`; add `services/execution/rpc-confidence.ts`, `tests/phase8-rpc.test.ts`, and `docs/PHASE8C-RPC.md`. Define primary-only/degraded/corroborated policies, independent operator configuration, compatible-context comparison and uncertainty handling. Never fan out broadcasts, modify signed evidence, reset completed claims or re-run settlement. Existing source-level replay and crash tests must remain green. Independent live read validation needs two actual providers; no silent paid upgrades.

**8D — focused wallet clarity (about 1.5–2.5 engineer-days):** modify `app/wallet.tsx`, `app/solana/swap.tsx`, `app/solana/panel.tsx`, `app/solana/delivery.tsx`, `app/checkout/tracker.tsx`, `app/networks/panel.tsx`, `app/globals.css`, `services/wallet/view.ts`; add `app/checkout/status.ts`, `tests/ui/phase8.spec.ts`, and `docs/PHASE8D-UX.md`. Render decimal units, explicit loading/error/stale states, privacy notices, separate trusted-relayer and wallet states, accessible recovery instructions and verified per-pool balance availability. No frontend-created approvals or payment retries. If native APIs do not expose a required verified balance, add a separately reviewed read-only adapter rather than inventing fields.

**Shared validation/documentation:** update `scripts/phase6-lint.mjs` to include new source files, `PROGRESS.md` per completed subphase, and create `scripts/phase8-preserve.mjs` plus `docs/phase8-evidence/` outputs. Existing lint is scoped formatting/extension syntax validation, not a comprehensive security linter. Existing screenshot-producing QA must redirect captures to a private Phase 8 directory. New preservation tooling must write a new report instead of overwriting protected historical reports.

Do not modify `services/solana/paid-recovery.ts`, transaction instruction policy or historical credential loaders merely for UI convenience. If later work truly requires an execution invariant change, isolate it into a reviewed commit with regression tests before activation.

## Deadline and delivery recommendation

October 28 is approximately eleven calendar days away. Estimates assume one engineer familiar with the repository, existing toolchains, no new live spending, no physical signer procurement and timely provider configuration. The complete proposal is about **7–11 implementation days plus 1–2 days for integration/regression and demo rehearsal**; it is tight and should not be promised wholesale.

Target a smaller 6–8 day demo scope: consistent browser projections, explicit privacy limitations, locking for newly encrypted accounts, visible RPC confidence with synthetic disagreement tests, and fixes for blank/error/unit/state UX. Reserve October 26–27 for regression, privacy review, packaging and an offline/read-only rehearsal; confirm the exact October 28 demo time before scheduling the final freeze. Keep the existing completed testnet proof available without executing it again.

Main risks: provider rate limits/availability and independent credentials; asynchronous unlock/KDF memory costs on Windows; stale views and same-profile history ownership after restart; native/browser regression duration; and scope creep into key migration or universal dApp signing. Hardware isolation, production mainnet readiness, full consensus infrastructure, recipient anonymity and transparent live refund activation are outside this demo commitment. A missed control should be honestly disclosed and the associated capability disabled, not patched around an execution veto.

## Validation baseline

Existing suites were run without adding application tests or changing source. Node tests include isolated synthetic native signing/proof fixtures; they are not live wallet signing. Browser captures stayed under gitignored `.state/phase8/browser`. Fresh chain checks were public read-only calls. Original journal financial rows were checked before and after QA.

Baseline evidence is in `docs/phase8-evidence/`: `baseline-node.txt`, `typecheck.txt`, `typecheck-web.txt`, `lint.txt`, `build.txt`, `contracts.txt`, `rust-wallet.txt`, `rust-watch.txt`, `rust-signer.txt`, `ui.txt`, `extension.txt`, `historical-ui.txt`, `isolated-api.txt`, `finalized-ui.txt`, `completed-order-audit.json`, and `preservation.json`.

**Final result: 431 passing tests, zero failures.** This is 306 Node, 25 wallet UI, 17 installed extension, 6 historical read-only UI, 3 isolated-backend API/UI, 3 completed Phase 7C API/UI, 52 Solidity, 10 Rust wallet, 5 Rust watch and 4 native signer tests. One pre-existing standalone expensive signer proof remains ignored; the Node integration suite exercises native proof/signing using isolated fixtures. Both TypeScript checks, scoped lint and production build pass. Read-only receipt/copy-replay audit probes are additional checks and are not counted as test cases.

Reproduction commands (PowerShell, in the repository; these test fixtures do not authorize live execution):

```powershell
npm test
npm run typecheck
npm run typecheck:web
npm run lint
npm run wallet:build
New-Item -ItemType Directory -Force '.state/phase8/browser' | Out-Null
$env:ZECONE_QA_EVIDENCE_DIR='.state/phase8/browser'
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
```

Run browser suites sequentially to avoid shared-port conflicts; they require the existing private profiles, snapshot fixtures, Edge and devnet read access. Their pairing/history attachment updates session metadata, not financial settlement authority. The audit-specific read-only inventory checker and consistent-copy replay probe are retained locally at `.state/phase8/audit-state.mjs` and `.state/phase8/replay-audit.ts`; do not run older preservation commands that overwrite historical evidence. No signer keys were unlocked for the live profiles. No live payment, signing, broadcast, refund or credential migration occurred.

All **537 + 91 protected files remain unchanged**, and the before/after fingerprints of both original journals' orders, payments, settlement rows and payment authorizations match. Application source and dependency manifests remain unchanged from `da18524`. Only this audit, a progress entry and new sanitized Phase 8 evidence are intended for the audit commit. No Phase 8A code is authorized by this audit. **Stop for user review.**

## Reference boundaries

Repository source is the evidence for implemented behavior. External guidance supports the proposed controls, not claims that they already exist:

- [OWASP logging guidance](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html): minimize sensitive logs and sanitize before recording.
- [OWASP cryptographic storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html): minimize secrets and distinguish encryption from key separation.
- [age format specification](https://c2sp.org/age@v1.1.0): passphrase/file encryption format; installed source determines this application's actual work factor.
- [Microsoft DPAPI example and protection context](https://learn.microsoft.com/en-us/windows/win32/seccrypto/example-c-program-using-cryptprotectdata): same-user/machine protection is not a separate physical signer.
- [Solana multi-account RPC contexts](https://solana.com/docs/rpc/http/getmultipleaccounts): commitment and minContextSlot do not establish independent-provider consensus.
