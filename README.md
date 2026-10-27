# ZecOne — wallet and shielded-payment demo

**Current launch status (26 October 2026):** the paired local browser wallet can
switch explicitly between Testnet and a read-only projection of the existing
verified Mainnet wallet. Mainnet receive, balance, history and sync freshness are
visible; browser mainnet signing and broadcasting remain disabled. The public
merchant experience is a demo-only replay with no payable address and no live
settlement. See [wallet audit](docs/WALLET-MAINNET-AUDIT.md), [demo deployment](docs/DEMO-DEPLOYMENT.md), and [submission package](submission/README.md).

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
