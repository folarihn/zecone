# Delivery phases

## Phase 0 — complete and preserved

1. Inspect environment; research official APIs and create feasibility, architecture, risks and phases documents.
2. Compile Rust testnet wallet generation, address allocation, sync, payment observation and local shielded sending.
3. Implement durable order verification, fixed NFT contract, user-signed intent, prefunded relayer, deterministic retries and auditable recovery.
4. Run offline unit/integration/contract tests. Generate local test wallets without disclosing secrets. Publish only addresses and funding instructions.
5. Funding checkpoint: local wallets were funded and the user explicitly resumed the live test on 2026-10-12.
6. After resumption, deploy on Base Sepolia, sign an intent, allocate a unique shielded payment destination, send actual test ZEC, wait for the threshold, execute one mint, and record real transaction references and recipient ownership. Exercise live reconciliation without claiming mocks as chain success.

Step 6 passed on 2026-10-12: real shielded payment, confirmed Base Sepolia mint, verified user ownership and live idempotency check. See [RESULTS.md](RESULTS.md). Phase 0 is complete; no frontend work begins automatically.

## Phase 1 — explicitly authorized local wallet application

1. Preserve Phase 0 source, credentials, databases, deployment and evidence. Git checkpoint `482fc57`; private runtime backup under `.secrets/phase1-checkpoint`.
2. Document the browser threat boundary before implementation. Reuse native wallet construction, verifier, contract and relayer.
3. Add actual native balance and unsigned fee quote APIs with an enforced fee ceiling; authenticate a loopback-only browser gateway and verify local user ownership.
4. Build the Next.js/TypeScript/Tailwind dashboard, activity, private/public explanations, approval dialogs, checkout progress and recovery views.
5. Checkpoint tested implementation (`ee64350`), preserve original tests, add auth/replay/privacy/approval tests and responsive accessibility checks.
6. Exercise one real browser-approved shielded payment through ten confirmations and a verified Base mint. Record independent receipts, ownership, screenshots and limitations in [PHASE1-RESULTS.md](PHASE1-RESULTS.md).
7. Stop and report Phase 1. Do not begin Phase 2 automatically.

## Phase 2 and beyond — not authorized

Potential future work includes user-owned smart accounts and ERC-4337 paymaster sponsorship, stronger viewing-key separation, verifying nodes, isolated/hardware signing, production custody/audits, liquidity and exchange design. Solana, arbitrary dApps, third-party Zcash wallet connections and production deployment remain out of scope. A production multichain wallet is not established by a custodial testnet relayer demo.
