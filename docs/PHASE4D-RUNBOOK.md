# Phase 4D runbook

Use the existing checkout, Node 24.12.x, pinned lockfiles and preserved testnet wallets. No new funds are required for this phase. Never fund a mainnet address to run the preview.

## Credential and read-only CLI

The issued OpenSea key is in ignored `.secrets/opensea-development-key.json`, expires `2026-10-20T10:27:38.767069775Z`, and currently has 600 reads/hour and five fulfillment preparations/minute. Alternatively set a locally managed `OPENSEA_API_KEY`; the API enforces its expiry even when the environment supplies no expiry metadata. Never paste keys in browser JavaScript, logs, issues or source. For renewal use the [official issuance documentation](https://docs.opensea.io/reference/create_instant_api_key); do not repeatedly create credentials to evade quotas. Authorization failures require reviewing/replacing the credential, not retry loops.

```powershell
node --import tsx scripts/phase4d-inspect.ts pudgypenguins
# Or supply a public order hash as the second argument.
```

This reads the public user/provider addresses from `docs/PUBLIC_WALLETS.json`, official API metadata, and `https://ethereum-rpc.publicnode.com`. It never loads a private key, signs, allocates a Zcash address or reserves liquidity. It writes sanitized `api-catalog.json` and `live-preview.json` under `docs/phase4d-evidence`; copy existing evidence first if retaining multiple runs. Errors write `inspection-failure.json`. A historical failed attempt file does not override the later successful preview.

The optional second argument selects a public order hash. Collection/contract/token and chain are independently checked. Unsupported or sold listings fail closed. The first listing is not guaranteed to remain available or supported; choose another from the catalog if appropriate. Do not weaken validation to force success. The adapter spaces fulfillment requests by at least 12 seconds and obeys server retry/reset headers. Preview requests are single-flight.

## Wallet UI

Build with `npm.cmd run wallet:build`, then open `Launch-ZecOne.cmd` as in the prior runbook. Use the loopback gateway at `http://127.0.0.1:3210`; do not use `next start`, a public server or tunnel. Pair locally and approve the ordinary local ownership challenge if needed. Select **Seaport**, enter a collection slug, select **Discover official listings**, then **Validate & preview**. This contacts OpenSea and Ethereum RPC and displays a read-only mainnet snapshot.

Review image, NFT, seller, order, recipient, fees, liquidity, illustrative TAZ amount, expiry and trust/privacy notes. There is no mainnet payment/approval control or receiving address. The separate **Seaport test listings** section retains the earlier controlled Base Sepolia workflow. Do not confuse its testnet controls with the OpenSea preview.

The Phase 4D server PID is recorded in ignored `.state/phase4d-processes.json`. When restarting a server, verify process identity and native activity; never kill an active prover or clear an uncertain journal. The existing completed order remains completed. Image fetches allow only exact OpenSea raster CDN hosts and may show an unavailable placeholder.

## Optional manual extension test — not yet proven

Read [extension instructions](../extension/README.md). The package is source only and has **not** been installed into your browser. For testing, create a separate Chrome/Edge profile, load the `extension` directory through the browser's normal developer extension interface, and inspect its exact OpenSea-only host access. This is a deliberate user installation, not a launcher side effect.

Start and pair the local wallet first. Visit the real OpenSea site and open its wallet picker. If ZecOne appears, select it, inspect the actual `https://opensea.io` origin in the local popup and explicitly approve access. OpenSea presents terms at connection; automated acceptance requires action-time confirmation. Record exact methods/errors. Reject mainnet transaction/listing/offer/approval requests. Testnet domain signing remains restricted; switching to chain 1 must fail. Close the popup or revoke the exact site in Apps to disconnect. If browser popup/COOP/security policy blocks the connection, preserve the error and stop; do not disable protections.

## Tests and evidence

```powershell
npm.cmd run typecheck
npm.cmd run typecheck:web
npm.cmd test
forge test
cargo test --locked --offline
npm.cmd run wallet:build
npm.cmd run test:ui
```

Node protocol regression uses local Anvil/read-only public forks. UI tests are synthetic and use Edge against an isolated local app. They never spend real assets. All prior public transaction evidence is preserved. No new live controlled payment is necessary to verify these read-only changes. Re-run current listing inspection separately from deterministic tests; a stale report is not evidence of current availability.
