# Phase 4B runbook

Preserve the Phase 4A checkpoint `627f0a0`, all older evidence, `.state` journals, `.secrets` credentials and Rust dependency pins. Prior-proof hashes are recorded in `phase4b-evidence/preservation.json`. A consistent private SQLite snapshot is under `.secrets/phase4b-checkpoint`. Never delete signed transactions, payment UUIDs, approvals or replay markers to repeat a demonstration.

## Local checks

Use Node 24.12.0, the lockfile, installed Foundry/Anvil and Microsoft Edge. No mainnet endpoint is permitted.

```powershell
npm.cmd ci --ignore-scripts
forge build
npm.cmd run typecheck
npm.cmd run typecheck:web
npm.cmd test
forge test
cargo test --locked --offline
npm.cmd run wallet:build
npm.cmd run test:ui
```

Node/Foundry AMM failures use disposable local Anvil or explicit hostile mocks, and synthetic Zcash observations. Browser tests intercept APIs. These do not prove a live swap.

## Controlled Base Sepolia setup

Stop local workers only after confirming native scanner processes are idle. A stale lock may be removed only after proving its recorded PID exited; preserve all journals. Check current provider balance and reconcile unresolved orders before setup. Existing user/provider keys are reused; no user key is loaded by deployment.

```powershell
node --import tsx scripts/phase4b-setup.ts --allow-testnet-broadcast
```

The helper permits chain 84532 only and persists raw bytes/hash before each broadcast. It deploys official pinned V2 WETH9/factory/router artifacts, a fixed-supply test token and bounded executor, approves exactly 1,000 test tokens, and seeds 0.005 test ETH plus 1,000 tokens. Allowance must be exhausted afterward. Its starting ceiling covers seven setup transactions capped at 0.001 ETH each, seed liquidity, and 0.0002 ETH reserved for one purchase: 0.0122 ETH. Each exact transaction is RPC-estimated again. This is a conservative spending ceiling, not a quoted actual cost.

Confirmed setup steps are reconciled by original hash; an unknown prior submission stops without a replacement. Three canonical confirmations are required. The manifest is `.state/swap-84532-confirmed.json`; public receipts/code hashes/reserves go to `phase4b-evidence/base/deployment.json`. A router address without verified pair reserves is insufficient.

## User approval and payment

Start the existing wallet with `npm.cmd run wallet:start` and open its local launcher. Verify EOA ownership, select **Tokens**, Base Sepolia and ZTEST, then enter a native test-ETH input (initial demonstration: 0.0001) and slippage in basis points (100 = 1%). **Get AMM quote** reads current reserves and simulates the route. Review recipient, router, token, decimals, route, minimum, impact, deadline, fee allowance and total test ZEC price. Approve the exact swap intent; this alone does not spend Zcash.

Next select **Review shielded payment**. The service re-simulates the signed executor call, obtains the actual native Zcash fee and requires a separate **Send shielded payment** approval. Keep the local worker running. Ten confirmed shielded blocks precede EVM authorization; three canonical Base blocks plus exact pair/token/executor receipt checks precede completion. Refresh token balance to read the actual user balance. A paid order must never be replaced with a fresh order to bypass failure.

## Recovery

The completed demonstration can be checked without signing or spending:

```powershell
node --import tsx scripts/phase4b-status.ts
node --import tsx scripts/verify-phase4b-live.ts verify
node --import tsx scripts/live-phase4b-swap.ts capture
```

The verifier reads the persisted native payment, confirmation audit, canonical Base receipt, actual pair events/reserves and balances, and simulates replay rejection. It writes `docs/phase4b-evidence/base/live-verification.json`. Its balance-delta assertions assume no unrelated later transfer through the demonstration accounts; inspect historical receipts if balances have since changed. A later transfer does not invalidate original delivery. `capture` requires a valid local paired session. If it expired, run `node --import tsx scripts/pair-wallet.ts` to issue a fresh private pairing token, then `node --import tsx scripts/pair-phase4b-browser.ts` locally to pair and approve the ownership signature. Never print or share pairing files.

Replay verification uses read-only simulation at the settlement block, where the intent had not expired and its replay key was already consumed. This keeps the specific `Replay` rejection reproducible after expiry; it does not broadcast a historical or new transaction. The RPC must retain historical state for this check.

The one-shot browser helper also has `quote`, `approve`, `payment-review` and `pay` modes, each requiring `--allow-testnet-spend`. These perform real operations. The existing `.state/phase4b-live.*` markers record the already completed purchase and intentionally block repetition. Do not rerun those steps for this order or delete their markers. Use a separately reviewed new wallet quote for any separately authorized future purchase.

For a new restart audit, snapshot with `verify-phase4b-live.ts before-restart` before restarting services; its exclusive marker prevents overwriting the completed proof. The current proof is already saved in `base/restart-verification.json`. Stop only the known Node worker PIDs after the shared service lock and both native scanner locks are absent and no `zecone-zcash` process is active. Start the wallet and marketplace with `node --import tsx services/wallet/server.ts` and `node --import tsx marketplace/server.ts`, respectively (hidden windows for background Windows processes). Wait for a fresh reconciliation, then run `verify-phase4b-live.ts after-restart`. Never replace journals or payment IDs as part of a restart.

- Unconfirmed/underpaid outputs never authorize a swap. Expired or late payments create durable recovery records; excess value remains a separate liability.
- Price movement, slippage, code/reserve mismatch, liquidity shortfall or simulation failure after payment blocks execution and retains the signed order and refund destination. Do not increase input, lower minimum or extend expiry without a separately reviewed resolution.
- An interrupted user payment is reconciled through its original native request ID. Do not generate another UUID or clear a started marker.
- A broadcast with unknown outcome retains the original raw bytes/hash and blocks conflicting nonces. Check the canonical receipt; do not sign a replacement blindly.
- Reverted swaps retain confirmed ZEC liability. A provider balance reservation release is not a refund. No automatic retry/refund is implemented.
- Reorg or token receipt mismatch requires manual review of original notes, receipt, Swap/Sync/Transfer events, runtime hashes and transaction-local balance delta.
- Refund only after separately reviewed reconciliation and authorization, recording an actual confirmed shielded refund transaction. A recovery label is not proof of a refund.

Stop after Phase 4B. Do not activate future-marketplace adapters or begin Phase 4C.
