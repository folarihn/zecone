# ZecOne — wallet and shielded-payment demo

Customers pay with shielded Zcash; merchants receive ETH on Base.

## How to test (judges): 5 minutes, nothing to install

Live site: **https://zecone.xyz** · API: **https://api.zecone.xyz**

No wallet, funds, faucet or account is needed for steps 1–3.

1. **Try a checkout (simulated, no real money).** Open
   [zecone.xyz/checkout](https://zecone.xyz/checkout) and buy an item, or pick an
   amount in the homepage widget and choose **Continue to demo checkout**. You
   see the exact ZEC amount, the 5-minute quote window and a **Simulated** badge.
   Without any action from you, the server replays recorded mainnet
   transactions and the checkout walks through each step to **Payment
   complete** with a Basescan link. A simulated checkout never shows a payable
   address.
2. **See real mainnet evidence.** Open
   [zecone.xyz/explorer](https://zecone.xyz/explorer) and follow the links to
   the Zcash and Base block explorers.
3. **Check the live service** from a terminal:

   ```bash
   curl https://api.zecone.xyz/api/v1/health
   curl "https://api.zecone.xyz/api/v1/quote/preview?amountUsd=5"
   ```

   Health reports `mode: monitor`, `realPayments: restricted-pilot`, and
   `livePayoutEnabled: false` / `zcashBroadcastEnabled: false` (nothing moves
   funds automatically). The quote preview is labeled as a fixed demo rate.

4. **Developer integration.** Read the create-payment snippet in
   [zecone.xyz/docs](https://zecone.xyz/docs). In
   [zecone.xyz/dashboard](https://zecone.xyz/dashboard) you can sign in with any
   Base wallet (a signature, no transaction), get an API key, and send a test
   webhook. During the restricted pilot, creating a payment with your own key
   returns `403 real_payments_restricted`; use step 1 to see the checkout flow.
5. **Privacy model.** [zecone.xyz/security](https://zecone.xyz/security)
   explains what is private (the shielded Zcash leg) and what is public (the
   Base payout).

### Real mainnet payment (restricted pilot)

Real payments are limited to one approved pilot merchant and run by the
operator, so judges cannot trigger one. Verified on 1 November 2026: order
`pay_d9aae1aea3104f6995e6c04746` was paid with 810 zatoshis in Zcash transaction
[`cad53524…032163`](https://mainnet.zcashexplorer.app/transactions/cad535249a27d4503f54ab23811fa9ea3ea4f40a1eb916231e5d267f9a032163)
(block 3,538,167). The watcher confirmed it after 20 confirmations, checking two
independent providers and the raw blocks (proof of work, Merkle inclusion,
continuity). The order reached `ZEC_CONFIRMED`, then completed the separately
approved Base payout on 4 November 2026. The finalized payout sent
`4,424,465,524,565` wei in transaction
[`0x8ab550cd…f321289`](https://basescan.org/tx/0x8ab550cd3419009fc4086260104d5e0a2ea8f2008b03d35cb087c5210f321289).
This is evidence of the restricted operator-controlled path, not unrestricted
public settlement.

To build and run everything locally, see [Install and verify](#install-and-verify).

## Project history

**Launch status (28 October 2026):** the paired local browser wallet can
switch explicitly between Testnet and a read-only projection of the existing
verified Mainnet wallet. Mainnet receive, balance, history and sync freshness are
visible locally; the public website cannot pair with that wallet or request a
signature. A separate operator-reviewed workflow executed and finalized a real
Zcash mainnet transfer (`0f0e9442…1def47`) with exact SIGN and BROADCAST gates.
The public merchant experience remains a demo-only replay with no payable
address or live cross-chain settlement. See [wallet audit](docs/WALLET-MAINNET-AUDIT.md),
[mainnet evidence](submission/EVIDENCE.md), [demo deployment](docs/DEMO-DEPLOYMENT.md),
and [submission package](submission/README.md).

The historical prototype is a Next.js wallet over a native Rust Zcash wallet,
durable TypeScript/SQLite order service, and prefunded Base Sepolia settlement.
Its minting, dApp requests, and marketplace purchase features remain **testnet
only**; mainnet is limited to the read-only wallet projection and separately
documented operator-controlled pilot evidence. There is no bridge or public
real-asset exchange.

**Latest: Phase 4E.** Actual OpenSea discovered the installed extension, connected the local test account, accepted an explicitly approved Base Sepolia login signature, and revoked access on logout. The public test profile is `zecone-test-c714`. No asset transaction occurred. See [results](docs/PHASE4E-RESULTS.md), [installation/runbook](docs/PHASE4E-RUNBOOK.md), [security](docs/PHASE4E-SECURITY.md), and [limitations](docs/PHASE4E-LIMITATIONS.md). The [Phase 4D read-only API preview](docs/PHASE4D-RESULTS.md) and earlier testnet functionality are preserved. Phase 5 has not begun.

**Open the wallet:** double-click `Launch-ZecOne.cmd`. It starts the local gateway and securely opens your browser at `http://127.0.0.1:3210`. The existing funded wallets and deployed contract are reused. See the [Phase 1 runbook](docs/PHASE1-RUNBOOK.md), [implementation results](docs/PHASE1-RESULTS.md), and [browser security review](docs/PHASE1-SECURITY.md).

**Phase 0 remains preserved.** Its real 0.01 TAZ shielded payment, ten-confirmation authorization, Base NFT receipt, ownership and idempotency evidence are recorded in [Phase 0 results](docs/RESULTS.md). Checkpoint `482fc57` precedes all Phase 1 changes. NU7 requires the pinned official prerelease Rust libraries; this remains a trusted testnet relayer prototype.

**Phase 3:** start the independent marketplace with `npm.cmd run marketplace:dev` and open `http://127.0.0.1:4322`. Connect the local wallet, review an NFT quote, and separately approve the shielded payment. See [results and live evidence](docs/PHASE3-RESULTS.md), [runbook](docs/PHASE3-RUNBOOK.md), [security model](docs/PHASE3-SECURITY.md), and [limitations](docs/PHASE3-LIMITATIONS.md). Phase 2 connectivity and its evidence are preserved in [Phase 2 results](docs/PHASE2-RESULTS.md).

- [Feasibility and verified dependencies](docs/FEASIBILITY.md)
- [Architecture](docs/ARCHITECTURE.md), [risks](docs/RISKS.md), [phases](docs/PHASES.md)
- [Funding](docs/FUNDING.md), [public addresses](docs/PUBLIC_WALLETS.json)
- [Reproducible runbook](docs/RUNBOOK.md), [results and evidence](docs/RESULTS.md)

## Install and verify

Use Rust 1.97.1, Node 24.12.0, npm 11.6.2, Foundry/Anvil 1.7.1, and Solidity 0.8.28 for the tested environment. Windows needs the MSVC C/C++ build tools. First install/build needs public registry access; subsequent offline Rust checks use the downloaded cache.

```powershell
npm.cmd ci --ignore-scripts
cargo build --locked
forge build
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-phase1.ps1
```

The Phase 1 verifier writes to a separate evidence directory, preserving Phase 0 logs. Build the frontend with `npm run wallet:build`, then use the launcher. The [Phase 1 runbook](docs/PHASE1-RUNBOOK.md) lists exact frontend dependencies and isolated browser tests.

The Anvil integration test starts a loopback-only process, creates disposable random local keys, and injects synthetic payment observations only inside the test. It is not evidence of a real Zcash or Base Sepolia transaction. Some sandboxes require permission to launch/connect to this loopback process.

## Local keys

Run `scripts/private-dirs.ps1` before generating credentials on Windows. It restricts `.secrets` to the current user and SYSTEM. On Unix use a private directory with mode 700; created key files use mode 600. Keys are plaintext local development credentials, not a hardened keystore.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/private-dirs.ps1
npm.cmd run wallets
.\target\debug\zecone-zcash.exe --wallet .secrets/user/zcash init
.\target\debug\zecone-zcash.exe --wallet .secrets/merchant/zcash init
```

The wallets for this checkout already exist; **do not overwrite or reinitialize them**. `npm run wallets` is idempotent. `init` refuses an existing Zcash seed. Back up `.secrets` and `.state` privately; never commit or upload them. The user-side signing utility is separate from the settlement process. The worker reads only `.secrets/relayer/base-sepolia.json`; Zcash merchant operations use only `.secrets/merchant/zcash`.
