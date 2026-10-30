# Phase 3 runbook

Use the pinned dependencies and existing funded test wallets. Do not regenerate or migrate previous wallets. Back up `.secrets` and consistent SQLite state privately. The existing `.secrets/phase3-checkpoint` is the preimplementation recovery snapshot; do not publish it.

## Build and test

```powershell
npm.cmd ci
forge build
npm.cmd run typecheck
npm.cmd run typecheck:web
npm.cmd test
forge test
cargo test --locked --offline
npm.cmd run wallet:build
npm.cmd run test:ui
```

Anvil must be on PATH for the disposable local EVM tests. Browser tests use installed Microsoft Edge. Synthetic scanner records and injected fee quotes are confined to tests. Rust dependency pins remain those verified for NU7 in the feasibility document.

## Testnet setup

Stop any active settlement worker before setup. Confirm all older transactions are reconciled and provider funds are not reserved. The setup script creates a separate seller key under `.secrets/marketplace-seller`, deploys the normal marketplace, three-token NFT collection, and immutable executor, funds seller gas with 0.001 test ETH, approves the marketplace and lists three tokens. It never reads the user's key. Each setup transaction is persisted before broadcast and requires a canonical successful receipt. A previous unknown submission stops for manual reconciliation.

```powershell
npm.cmd run phase3:setup
npm.cmd run wallet:start
# A second terminal:
npm.cmd run marketplace:dev
```

Open the existing local wallet launcher to pair and verify ownership. Visit `http://127.0.0.1:4322`, connect ZecOne, approve the exact origin, select an available NFT, and select **Pay with shielded ZEC**. Inspect the complete purchase quote in the wallet popup, approve it, review the native Zcash fee, then separately approve the payment. Keep the local wallet service running for native scanning and settlement. Ten Zcash confirmations and three Base confirmations are required. **Purchases** in the wallet shows progress, ownership and recovery.

The independent marketplace also supports ordinary injected-wallet ETH purchases. Switch the injected wallet to Base Sepolia. Always verify the receipt and NFT owner, not just the submitted hash.

## Recovery

- Preserve `.state/purchases.sqlite`, its WAL, native request journals, local approval files and exact signed transaction hashes. Never copy only an active SQLite main file; stop the service or use SQLite backup.
- An interrupted native send enters review. **Recheck saved purchase** consults the existing native request ID; it never creates another send. If the native request was not durably recorded, manual investigation is required.
- A receipt timeout or lost submission response keeps the exact Base hash and blocks competing provider work. Do not change nonce, gas, recipient or listing to force completion. Reconciliation can recognize the original successful receipt.
- Sold, cancelled, expired or changed listings, insufficient liquidity, reverts, reorgs and ownership mismatches produce durable recovery entries. Record the original payment, amount, agreed terms, saved refund destination and investigation before any separately authorized manual refund. The UI does not imply a refund was sent.
- Rejected or unpaid expired quotes release reservations. Confirmed failed settlements release EVM liquidity but retain Zcash refund liability. Never equate released provider ETH with refunded ZEC.
- A stale `.state/service.lock` requires checking the recorded PID and proving its worker exited before removing that single lock file. Do not remove an active lock or reset purchase databases.

## Read-only live evidence and browser helpers

```powershell
node --import tsx scripts/phase3-status.ts
node --import tsx scripts/verify-phase3-live.ts
node --import tsx scripts/capture-phase3.ts completed
```

The first command reads a sanitized local journal projection. The second independently checks canonical RPC receipts, local scanner evidence, actual native fee, seller and provider balances, ownership and a simulated `Replay()` rejection. It never broadcasts. The screenshot helper uses the gitignored paired browser session and reads the same purchase through the marketplace's public status method.

The one-time live demo used `scripts/pair-phase3-browser.ts`, `scripts/live-phase3-purchase.ts --allow-testnet-spend`, and then `scripts/resume-phase3-payment.ts --allow-testnet-spend` to recover its already-signed quote before any payment. These are deliberate spend helpers, not tests. The durable marker now refuses any further payment approval. Do not delete it. The restart proof used `scripts/phase3-restart-proof.ts before` and `after`; its existing before-record must also be preserved.

Before rebuilding the production UI, stop the local gateway only after native scanner operations finish. Windows may retain a lock after a forced process stop. Verify the exact recorded PID has exited before removing that one stale lock; never remove database or request journals. The source now serializes user-wallet operations and waits up to one minute for scan-lock contention during approved quote creation.

The setup helper now rejects placeholder or noncanonical RPC block hashes. If a previous setup step is ambiguous, preserve the exact transaction and reconcile its receipt; never redeploy blindly. The final live evidence rechecked all eight setup transactions against actual canonical blocks.

No Phase 4 work is included.
