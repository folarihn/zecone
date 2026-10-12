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

## Phase 2 — complete; stop here

1. Research current dApp provider, signature, permissions, chain-switching and Base Sepolia sponsorship boundaries using official specifications and repositories.
2. Implement an opt-in separate-origin EIP-1193 popup connector and EIP-6963-compatible discovery SDK, with exact-origin approval, user-visible signing, transaction review, local EOA signing and revocation.
3. Implement a separate-origin test dApp and exercise real account access, message and typed-data signatures, and a Base Sepolia self-transfer.
4. Add a fixed, immutable Base Sepolia action and durable Zcash-confirmation-gated sponsorship flow. Require ten Zcash confirmations and three Base confirmations before completion; prevent replay and duplicate settlement.
5. Run the real shielded payment and one action for the user-controlled Base Sepolia wallet; independently verify the Zcash observation, exact Base event, recipient, replay state, and single broadcast. See [Phase 2 results](PHASE2-RESULTS.md).
6. Stop after Phase 2. Do not begin the wallet frontend expansion, ERC-4337, arbitrary dApp support, production integration, or mainnet work automatically.

## Phase 3 and later — not started

Potential later work includes user-owned smart accounts and ERC-4337 paymaster sponsorship, stronger viewing-key separation, verifying nodes, isolated/hardware signing, production custody/audits, liquidity and exchange design. Arbitrary dApps, third-party Zcash wallet connections and production deployment remain out of scope. The testnet relayer action is not a production bridge or asset exchange.
