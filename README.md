# ZecOne — local testnet wallet

Next.js wallet application over a native Rust Zcash wallet, durable TypeScript/SQLite order service, and prefunded Base Sepolia settlement. Supports fixed NFT minting, origin-bound dApp requests, and shielded-ZEC-funded purchases from an independent fixed-price NFT marketplace. **Testnets only. No bridge or real asset exchange.**

**Open the wallet:** double-click `Launch-ZecOne.cmd`. It starts the local gateway and securely opens your browser at `http://127.0.0.1:3210`. The existing funded wallets and deployed contract are reused. See the [Phase 1 runbook](docs/PHASE1-RUNBOOK.md), [implementation results](docs/PHASE1-RESULTS.md), and [browser security review](docs/PHASE1-SECURITY.md).

**Phase 0 remains preserved.** Its real 0.01 TAZ shielded payment, ten-confirmation authorization, Base NFT receipt, ownership and idempotency evidence are recorded in [Phase 0 results](docs/RESULTS.md). Checkpoint `482fc57` precedes all Phase 1 changes. NU7 requires the pinned official prerelease Rust libraries; this remains a trusted testnet relayer prototype.

**Phase 3:** start the independent marketplace with `npm.cmd run marketplace:dev` and open `http://127.0.0.1:4322`. Connect the local wallet, review an NFT quote, and separately approve the shielded payment. See [results and live evidence](docs/PHASE3-RESULTS.md), [runbook](docs/PHASE3-RUNBOOK.md), [security model](docs/PHASE3-SECURITY.md), and [limitations](docs/PHASE3-LIMITATIONS.md). Phase 2 connectivity and its evidence are preserved in [Phase 2 results](docs/PHASE2-RESULTS.md). No Phase 4 is included.

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
