# Phase 4C runbook

Use the existing preserved development wallet installation. All commands below run from the repository root. Node 24.12.x, the pinned npm lockfile, Foundry/Anvil, the built NU7-compatible Rust binary and local wallet databases are required. Do not migrate keys, update Rust pins, remove journals or repeat a completed payment to reproduce screenshots.

## Configuration

Seaport runs only on Base Sepolia, chain 84532, RPC `https://sepolia.base.org`. Canonical protocol address: `0x0000000000000068F116a894984e2DB1123eB395`, version 1.6. Runtime identity is pinned in `services/seaport/protocol.ts`. The existing native Zcash configuration uses standard Zcash Testnet through TLS lightwalletd `https://testnet.zec.rocks:443`, with network/consensus checks. Follow the previous phase wallet runbook for syncing/funding testnet TAZ. No mainnet funds are needed or accepted.

Existing ignored local user/provider/seller keys are reused. `scripts/local-seaport-sign.ts` reads `.secrets/user/base-sepolia.json`; the backend settlement adapter uses its separate provider key. `.state/seaport-84532-confirmed.json` holds verified contract configuration; `.state/seaport-controlled-listing.json` holds the seller-signed listing. Never expose their signatures/raw transaction journals as general debug output. Public addresses and receipts are in `phase4c-evidence/base/deployment.json`.

An OpenSea API key is optional, from `OPENSEA_API_KEY` or ignored `.secrets/opensea-api-key.txt`. The chain gate must advertise the testnet before discovery is usable. Do not replace the gate with a mainnet chain to make a test pass. See feasibility for current access evidence. Controlled Seaport orders are the demonstrated fallback.

## Validate before spending

```powershell
npm ci --ignore-scripts
npm run typecheck
npm run typecheck:web
npm test
forge test
cargo test -p zecone-zcash
npm run test:ui
npm run wallet:build
```

The Seaport Node integration suite launches local Anvil and forks the verified public deployment at the recorded preflight block. It requires read-only Base RPC connectivity; funded random local test accounts never spend public-chain funds. Keep these fixture results separate from public-chain live evidence. Browser tests use local test services/fixtures. Shut down the real local servers before a production rebuild; never interrupt active native sends or remove active locks.

## Controlled setup and wallet flow

`node --import tsx scripts/phase4c-setup.ts --allow-testnet-broadcast` deploys the controlled collection/wrapper and approves token 1, with bounded testnet spending and durable signed-before-broadcast step files. It reuses confirmed setup rather than redeploying. Read its manifest first on an existing installation. Never delete `.state/phase4c-setup` to force replacement after an uncertain broadcast. The test seller signs a genuine Seaport order locally; this does not publish a listing to OpenSea.

Start `npm run wallet:start` and the existing marketplace service if needed. Open the wallet through its local pairing launcher; do not paste pairing tokens into logs. Verify wallet ownership. Choose **Seaport**, review the controlled listing and exact recipient/price/fee/expiry/protocol, then approve the exact intent. Review the native Zcash fee separately and approve the shielded payment. Keep the wallet service running through ten Zcash confirmations and destination reconciliation.

The existing user NFT/swap/dApp flows are separate navigation entries. The Seaport panel labels controlled orders and simulated pricing explicitly. A changed listing, failed simulation or insufficient liquidity blocks progress. A recovery label is not permission to pay again.

## Recorded live demonstration helpers

The helpers operate the actual local browser and preserve exclusive attempt markers. They are deliberately not a repeatable payment loop:

```powershell
node --import tsx scripts/pair-phase4c-browser.ts
node --import tsx scripts/live-phase4c-seaport.ts quote --allow-testnet-spend
node --import tsx scripts/live-phase4c-seaport.ts approve --allow-testnet-spend
node --import tsx scripts/live-phase4c-seaport.ts payment-review --allow-testnet-spend
node --import tsx scripts/live-phase4c-seaport.ts pay --allow-testnet-spend
node --import tsx scripts/phase4c-status.ts
node --import tsx scripts/verify-phase4c-live.ts verify
node --import tsx scripts/live-phase4c-seaport.ts capture
```

Pairing requires a fresh local browser pairing file. The helper stores the authenticated session only in `.secrets/phase4c-browser-session.json`. `quote` refuses an existing attempt. `resume-quote` is permitted only when the original start marker exists, no quote marker exists, and a read-only database check proves there is no Seaport purchase row. It preserves original balances. After any persisted order, use its existing reconciliation path instead.

`reconcile` clicks **Recheck saved Seaport purchase**, reusing the saved signed intent/payment request. If approval was interrupted but the signature exists, it attaches that same intent and idempotently allocated address. If a send was interrupted, native request reconciliation checks the original UUID/transaction. Never reset stages or create another payment as a shortcut.

## Independent proof and restart

`verify-phase4c-live.ts` is read-only: it checks native shielded note attribution and fee, confirmation depth before preparation, genuine Seaport receipt/order state, exact seller proceeds, direct NFT delivery and current owner, provider/user balance changes, a single broadcast, and a reverting replay simulation. It writes only sanitized public evidence.

Run `before-restart`, wait until service/native locks are absent, and stop only the recorded wallet/marketplace processes. Restart the same services against the same databases and keys; allow a fresh reconciliation scan, then run `after-restart`. The proof compares unchanged original transaction/hash/nonces/balances with an increased scan count. Do not replace an uncertain transaction or clear recovery rows to satisfy verification.

Public logs/screenshots live under `docs/phase4c-evidence`. Private attempt markers, native journals, credentials and signed raw transactions remain ignored. A public Zcash explorer reference proves transaction inclusion, not its shielded amount/recipient; those rely on the local native-wallet evidence.
