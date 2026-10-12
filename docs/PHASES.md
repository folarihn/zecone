# Delivery phases

## Phase 0 only

1. Inspect environment; research official APIs and create feasibility, architecture, risks and phases documents.
2. Compile Rust testnet wallet generation, address allocation, sync, payment observation and local shielded sending.
3. Implement durable order verification, fixed NFT contract, user-signed intent, prefunded relayer, deterministic retries and auditable recovery.
4. Run offline unit/integration/contract tests. Generate local test wallets without disclosing secrets. Publish only addresses and funding instructions.
5. Funding checkpoint: local wallets were funded and the user explicitly resumed the live test on 2026-10-12.
6. After resumption, deploy on Base Sepolia, sign an intent, allocate a unique shielded payment destination, send actual test ZEC, wait for the threshold, execute one mint, and record real transaction references and recipient ownership. Exercise live reconciliation without claiming mocks as chain success.

Step 6 passed on 2026-10-12: real shielded payment, confirmed Base Sepolia mint, verified user ownership and live idempotency check. See [RESULTS.md](RESULTS.md). Phase 0 is complete; no frontend work begins automatically.

## Later phases (not authorized here)

Evaluate user-owned smart accounts and ERC-4337 paymaster sponsorship, stronger viewing-key separation, node verification, production custody/audits, liquidity and exchange design. Frontend work requires a separate decision after Phase 0 results. A production multichain wallet is not established by a custodial testnet relayer demo.
