# Mainnet demonstration hardening validation

**Date:** 23 October 2026

**Starting checkpoint:** `257e328` plus the reviewed Stage 4C worktree

**Scope:** non-spending code, tests and deployment packaging only

**Decision:** code hardening passes; live mainnet remains disabled pending operator setup and controlled acceptance.

## Implemented controls

- Zcash payment evidence is bound to the exact configured mainnet provider pair and a minimum 20-confirmation policy. A changed provider, operator, threshold or native snapshot fails closed.
- Provider URLs used by the authorization policy reject embedded credentials, query strings, fragments and test hosts.
- The online executor requires an external signed bundle. It cannot open a relayer keystore or read a signer passphrase.
- The offline signer is network-free, requires an enabled profile and exact prepared digest, enforces a durable signer ledger and writes signed bytes only to an exclusive output file.
- The watch-only worker uses one exclusive process lock, bounded retries, provider agreement, raw-block manifest/digest validation, reorg checks, atomic Linux checkpoints and restart-safe catch-up. The lock is released even when checkpoint parsing fails, and authenticated manifests must contain exactly one contiguous block per height with unique hashes.
- Watch health reports only aggregate heights, lag, age and finite error codes. It exposes no address, payment, memo, viewing key, order or destination correlation.
- The VPS worker is disabled unless both the protected configuration and `ZECONE_WATCH_WORKER=1` enable it. The read-only service requires the dedicated filesystem UUID and retains permanent false signing/broadcast/refund flags. If the worker process exits, health becomes not-ready instead of retaining stale readiness.
- Local encrypted backup status never claims production readiness; off-host copy and an independent restore drill remain required.
- Next.js and Rust TLS/webpki dependencies were upgraded to versions with no current high/critical audit finding.

## Validation results

- Focused payment-policy, offline-signer and worker suite: **26/26 passed**.
- Combined mainnet/export/executor/operator/worker/VPS suite: all functional tests passed; the localhost VPS cases require execution outside the restricted sandbox.
- Full Node suite: **541/541 passed**. The final rerun includes worker lock release after a corrupt checkpoint and rejection of non-contiguous authenticated manifest heights. An earlier run hit one transient Windows `EPERM` while renaming a disposable restored directory; the exact test passed immediately in isolation and the final full rerun passed cleanly.
- Application TypeScript check: **PASS**.
- Web TypeScript check: **PASS**.
- Repository lint/format check: **PASS**.
- Wallet production build on Next.js 16.4.2: **PASS**.
- Browser-extension build: **PASS**, with no credentials included.
- Zcash watch Clippy with warnings denied: **PASS**.
- Zcash watch Rust tests: **16/16 passed**.
- Historical Zcash service tests: **10/10 passed**.
- Native refund signer tests: **4 passed, 1 deliberately ignored expensive proof test**.
- `npm audit --omit=dev --audit-level=high`: **0 vulnerabilities**.
- RustSec audit of the root, watch and refund lockfiles: **PASS** against 1,350 advisories.
- Compose schema: **PASS**.
- Container image build: **BLOCKED on this workstation because the Docker Linux daemon is not running**. No VPS change was authorized or made in this sprint.
- Preservation: **537/537 historical files unchanged and 91/91 Phase 7B files unchanged**. Phase 7B and 7C remain completed, each retains one signing/broadcast operation, financial rows are unchanged and refunds remain disabled.

The root Zcash and refund crates pass their tests. Warning-denied Clippy for those two historical crates still reports pre-existing style warnings in protected legacy source. Those files were deliberately not changed because preservation is a stronger release requirement; the new mainnet watch crate passes strict Clippy.

## Operational limits

The raw-block corpus currently advances only through blocks meeting the separate evidence-depth threshold (10 by default). Because a confirmed payment also requires a complete 20-block proof segment, operational recognition can occur later than the nominal 20 confirmations. It never occurs earlier. Reducing that latency requires a separately reviewed evidence policy change.

The worker validates a bounded proof-of-work segment, block hashes, transaction Merkle inclusion and provider agreement. It is not a full Zcash consensus node and does not recompute every ZIP-244 commitment. A capped pilot continues to trust the configured independent providers and checkpoint policy.

## Remaining external gates

1. Provision a fresh mainnet UFVK/watch address and exact birthday; estimate corpus storage before activation.
2. Configure and contract two independent production providers for Zcash, Base and Solana, then capture second-day agreement evidence.
3. Operate two pinned, independently controlled signed ZEC/ETH and ZEC/SOL price authorities.
4. Provision separate recipient and relayer accounts, execution authority, backup recipient and a physically separate signing computer. Do not reuse development credentials.
5. Complete an encrypted off-host backup, retention setup, alert routing and restore drill.
6. Build the reviewed immutable image, record its digest, deploy the watch-only worker and prove catch-up/restart health with mainnet execution still paused.
7. Fund only the capped pilot accounts after every prior gate passes.
8. Prepare and separately approve one Base package and one Solana package. Reconcile each finalized result and duplicate rejection before proceeding to the next.

No mainnet payment, key unlock, signature, broadcast, refund or production deployment occurred during this validation.
