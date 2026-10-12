# ZecOne — Phase 0

Testnet payment-to-NFT feasibility prototype. Native Rust Zcash wallet, durable TypeScript/SQLite order service, prefunded Base Sepolia relayer, and fixed ERC-721 mint. **No frontend. No bridge or real asset exchange.**

**Phase 0 live test passed on 2026-10-12.** A real 0.01 TAZ shielded Testnet payment reached ten confirmations and authorized one successful Base Sepolia NFT mint to the user's separate wallet. Receipt, ownership and duplicate-processing checks passed. See [results and transaction references](docs/RESULTS.md). Work stops before the frontend. NU7 requires the pinned official prerelease Rust libraries; this is a trusted testnet relayer prototype, not a production bridge.

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
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1
```

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
