# Phase 0 feasibility

Research dates: 2026-10-11 and 2026-10-12. No frontend. The user resumed live testing after funding. The real shielded payment-to-Base-Sepolia-mint test passed, including user ownership and duplicate-processing checks. The live test exposed a NU7 library incompatibility, resolved with pinned official prereleases. See [RESULTS.md](RESULTS.md) for transaction references and evidence.

## Decision

Implement native Rust shielded wallet operations using registry-published NU7 prereleases of librustzcash, a durable SQLite order journal, and an ETH-prefunded Base Sepolia relayer calling a fixed ERC-721 mint. This is a trusted testnet payment processor. It does not move ZEC to Base, perform an exchange, or prove Zcash consensus to an EVM contract.

**Live-test correction, 2026-10-12:** choosing stable releases was insufficient for the current public testnet. The server reported consensus branch `77190ad9`, and rejected the original transaction's older branch. The official [protocol changelog](https://github.com/zcash/librustzcash/blob/main/components/zcash_protocol/CHANGELOG.md) establishes NU7 activation at Testnet height 4,465,026 and that branch ID in `0.11.0-pre.0`. The [backend changelog](https://github.com/zcash/librustzcash/blob/main/zcash_client_backend/CHANGELOG.md) documents the compatible prerelease family and changed RNG/clock APIs. We upgraded the entire family, backed up existing wallet state locally, and added a tested server/library consensus check before wallet operations. This is an explicit prerelease dependency risk. Empty-wallet scanning had not revealed the sending incompatibility.

## Verified environment and versions

The repository initially contained only `.git`. Windows PowerShell; rustc 1.97.1, Cargo 1.97.1, Node 24.12.0, npm 11.6.2, Foundry 1.7.1. No existing Zcash node, lightwalletd, funding, or service credentials were found. Public registry access needs the execution environment's network permission.

Registry-published dependencies selected from official source (including the explicitly named prereleases; exact transitive resolution belongs in lockfiles):

| Component | Version | Purpose |
| --- | --- | --- |
| zcash_client_backend | 0.25.0-pre.1 | NU7 wallet traits, scan/sync, proposals, local construction |
| zcash_client_sqlite | 0.23.0-pre.1 | Maintained wallet database implementation |
| zcash_keys | 0.17.0-pre.1 | ZIP 32 keys and shielded addresses |
| zcash_protocol | 0.11.0-pre.0 | NU7 TestNetwork consensus and integer zatoshis |
| zcash_primitives / zcash_proofs | 0.31.0-pre.1 / 0.31.0-pre.1 | Transactions and local Sapling prover |
| zcash_address / zip321 | 0.14.0-pre.1 / 0.10.0-pre.1 | Address and payment-request encoding |
| viem | 2.57.4 | Local EVM keys, signatures, Base RPC and transactions |
| OpenZeppelin contracts | 5.6.1 | ERC-721 implementation |
| permissionless | 0.4.1 researched, not required by slice | Optional ERC-4337 adapter |
| rusqlite | 0.37.0, bundled SQLite | Native wallet database |
| rustls / tonic | 0.23.45 / 0.14.6 locked | TLS/gRPC; explicitly select ring provider |
| TypeScript / tsx / @types/node | 7.0.2 / 4.23.15 / 24.10.1 | Execution service tools |
| Solidity / Foundry | 0.8.28 / 1.7.1 | Contract compilation and local tests |

The complete lockfile is built with Rust 1.97.1. The official [zcash-devtool](https://github.com/zcash/zcash-devtool) was originally inspected at commit `5a26ee854e634a4e88d1d79dab13f8fbb1eac6b8`; its stable crate family was a useful API reference but did not support the live server's NU7 branch. Its CLI is explicitly unstable and non-production. Our service calls crate APIs directly, rather than parsing human CLI output. Exact resolution is recorded in Cargo.lock; the former lockfile is preserved locally in `.state/Cargo.pre-nu7.lock`. The prereleases are not represented as stable audited components.

## Zcash

Network: the standard public **Zcash Testnet**, `zcash_protocol::consensus::Network::TestNetwork`; not mainnet, regtest, or Crosslink's separate test network. Unified addresses start `utest`, Sapling addresses `ztestsapling`. Only shielded recipients are accepted. Amounts are integer zatoshis (100,000,000 per test ZEC/TAZ).

[librustzcash](https://github.com/zcash/librustzcash) supplies maintained primitives and wallet components. [Versioned backend documentation](https://docs.rs/zcash_client_backend/0.25.0-pre.1/zcash_client_backend/) and [SQLite documentation](https://docs.rs/zcash_client_sqlite/0.23.0-pre.1/zcash_client_sqlite/) are the API authority. The SQLite wallet permits read-only application queries, but writes must use its APIs. Its schema is version-sensitive.

Use `https://testnet.zec.rocks:443`, a public TLS lightwalletd endpoint listed by the official developer tool's [remote configuration](https://github.com/zcash/zcash-devtool/blob/5a26ee854e634a4e88d1d79dab13f8fbb1eac6b8/src/remote.rs). No API key is specified for this endpoint. Check `GetLightdInfo.chainName == test` before use. The service fetches compact blocks and tree state, trial-decrypts locally, and stores notes locally. It never sends seed/spending keys to lightwalletd. The server is trusted for honest chain data; a light client is not an independent consensus node.

The backend's `sync` feature exposes `sync::run`. Its source explicitly lacks transaction enhancement, parallel download/scan, and graceful interruption. Our payment observations use scanned notes and mined block data, not mempool events or balances. Sending uses `propose_transfer`, ZIP-317 fees, `create_proposed_transactions`, and `SendTransaction`; Sapling proving parameters are supplied by the bundled local prover. Orchard/Ironwood proving is local. The prerelease construction API additionally requires a clock and cryptographic RNG. Observation accepts shielded pool codes 2, 3 and 4, including Ironwood; NU7-compatible routing can deliver an Orchard-receiver payment into the Ironwood pool. Compilation and funded sync pass. See the live evidence for actual send/mint results rather than inferring success from compilation.

Alternative infrastructure: self-host [lightwalletd](https://github.com/zcash/lightwalletd) against [Zebra](https://github.com/ZcashFoundation/zebra) on Testnet. Zebra is a consensus node, not a shielded wallet RPC. Do not invent `z_sendmany` on Zebra or treat Ethereum-style JSON-RPC as lightwalletd's gRPC. [Zallet](https://github.com/zcash/zallet) is a Rust RPC wallet in beta, explicitly not a supported Rust-library interface, and its README warns that some inherited wallet RPCs remain unimplemented. [Zingolib](https://github.com/zingolabs/zingolib) is another maintained Rust wallet API to evaluate; neither alternative was compiled or assumed compatible in this slice. No self-hosted daemon version is claimed as tested.

## Base Sepolia and sponsorship

Chain ID **84532**, RPC `https://sepolia.base.org`, explorer `https://sepolia.basescan.org`, native gas ETH, per [Base network documentation](https://docs.base.org/get-started/connect-to-base). Verify RPC chain ID before signing. Public RPCs are suitable for prototyping, without a service-level guarantee.

[Pimlico's official tutorial](https://docs.pimlico.io/guides/tutorials/tutorial-1) documents permissionless + viem, Safe 1.4.1, EntryPoint 0.7, bundler submission and verifying paymaster sponsorship. [Pimlico getting started](https://docs.pimlico.io/guides/getting-started) distinguishes verifying paymasters from ERC-20 paymasters. A paymaster does not accept shielded ZEC directly: our processor must authorize sponsorship after payment verification. An API key, supported chain/EntryPoint check, enabled sponsorship policy and provider balance/limits are prerequisites. No key or policy was supplied; provider-specific Base Sepolia sponsorship has not been exercised.

The smallest reliable gas-sponsored mint uses an ETH-prefunded relayer: recipient pays no Base gas, and receives the NFT directly. This is **not an ERC-4337 UserOperation**. It satisfies the Phase 0 payment-to-mint proof with fewer external dependencies. ERC-4337 remains a documented follow-on experiment, not a capability claimed by this implementation. The user's NFT wallet is a separate local EOA whose key is never loaded by the settlement worker; a local signing utility demonstrates control.

For a Base-native AA route, Coinbase's [CDP Paymaster integration guide](https://docs.cdp.coinbase.com/paymaster/guides/wagmi-viem-integration) explicitly documents Base Sepolia, a combined Paymaster & Bundler endpoint, contract allowlisting and a Base Account connector. It requires a CDP account with Paymaster enabled and a private endpoint/API key; its example endpoint is `https://api.developer.coinbase.com/rpc/v1/base-sepolia/<API_KEY>`. This is verified documentation support, not an exercised credential or sponsorship policy. That frontend-oriented connector is out of scope here. A later adapter must preserve user account ownership, restrict sponsored calldata, check supported EntryPoints, persist the UserOperation hash before submission, and reconcile both UserOperation success and the underlying transaction. Neither a bundler accepting an operation nor a paymaster approving gas proves that a mint succeeded.

## Credentials and funding

Local gitignored Zcash seed files, separate Base user and relayer key files, and SQLite state are required. No private key in configuration examples. Testnet faucet funding is required before broadcasting. User wallet proof is a domain-bound signed order intent; it does not require ETH. Fund the relayer for contract deployment and mint gas, and a separate Zcash payer wallet for the shielded payment. See [FUNDING.md](FUNDING.md).

Real shielded receipt/confirmation and Base mint/ownership evidence is now saved in [live-test.json](evidence/live-test.json). Offline failure-injection tests remain separate from this on-chain evidence.
