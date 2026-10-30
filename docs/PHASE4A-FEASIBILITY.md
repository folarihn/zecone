# Phase 4A feasibility

Audit date: 2026-10-13. Phase 3 checkpoint `cee37b2` remains intact. Work is on `codex/phase4a-multichain`; at audit entry the working tree already contained uncommitted Phase 4A changes, which were inspected and continued. Phase 0–3 results, security documents, limitations and runbooks were reviewed. Existing transaction references and local credentials were preserved. No wallet was generated or migrated.

## Network verification

Read-only checks on 2026-10-13 verified each configured endpoint by `eth_chainId`, current block and canonical hash. Funding was later confirmed at 0.2 ETH on Sepolia and 0.01 ETH on Robinhood before the authorized live deployment. The latest public balance snapshot is [network-preflight.json](phase4a-evidence/network-preflight.json); actual deployment and purchase evidence is recorded separately in [results](PHASE4A-RESULTS.md).

| Network | Chain ID | RPC | Explorer | Native asset | Status at check |
| --- | ---: | --- | --- | --- | --- |
| Base Sepolia | 84532 | `https://sepolia.base.org` | `https://sepolia.basescan.org` | ETH | RPC healthy; provider 0.098863135337903908 ETH |
| Ethereum Sepolia | 11155111 | `https://ethereum-sepolia-rpc.publicnode.com` | `https://sepolia.etherscan.io` | ETH | RPC healthy; funded and deployed |
| Robinhood Chain Testnet | 46630 | `https://rpc.testnet.chain.robinhood.com` | `https://explorer.testnet.chain.robinhood.com` | ETH | RPC healthy; funded and deployed |

Ethereum.org recommends Sepolia for application and contract testing; the maintained [eth-clients/sepolia network repository](https://github.com/eth-clients/sepolia) records chain ID 11155111. The RPC in this project is PublicNode, a third-party provider, not an Ethereum Foundation endpoint. Ethereum uses EIP-1559 type-2 fee fields (`maxFeePerGas` and `maxPriorityFeePerGas`) as described in the [EIP-1559 specification](https://eips.ethereum.org/EIPS/eip-1559). Test ETH faucet options are listed by [Ethereum.org](https://ethereum.org/developers/docs/networks/#sepolia). Alchemy currently advertises 0.1 Sepolia ETH per 24 hours, with address eligibility conditions on its [faucet page](https://www.alchemy.com/faucets/ethereum-sepolia); this is an option, not a guaranteed grant.

Robinhood's official [wallet network settings](https://docs.robinhood.com/chain/add-network-to-wallet/) and [connection documentation](https://docs.robinhood.com/chain/connecting/) distinguish testnet chain ID 46630 from mainnet 4663, specify ETH as gas currency, and list the public testnet RPC and explorer. Its [developer overview](https://docs.robinhood.com/chain/) identifies the chain as Arbitrum-based and EVM compatible and lists Foundry, Hardhat, viem and Wagmi support. The [deployment guide](https://docs.robinhood.com/chain/deploy-smart-contracts/) gives Foundry/Hardhat deployment instructions and explicit testnet parameters. Official support confirms the [testnet faucet](https://robinhood.com/us/en/support/articles/robinhood-chain-testnet/) is available and links `https://faucet.testnet.chain.robinhood.com`.

Robinhood Chain uses Arbitrum Nitro. Official [Arbitrum Nitro fee documentation](https://docs.arbitrum.io/how-arbitrum-works/inside-arbitrum-nitro) describes fees for L2 execution and L1 data; the fee is denominated in ETH. Do not reuse Base-specific L1 reserve assumptions. This prototype uses a destination-specific gas policy and the network RPC's gas estimate; actual receipt fees and provider balance deltas are now recorded for the funded live transactions. Robinhood's public RPC terms/docs warn of rate limits and no production uptime guarantee; use a contracted provider before production.

Robinhood's official docs confirm compatible EVM wallets and standard JSON-RPC. No Robinhood-specific wallet SDK, bundler, paymaster or special API is needed for this prototype's prefunded EOA settlement. Robinhood lists Alchemy's RPC, indexed Data API and gasless infrastructure as available services, but ZecOne does not currently depend on them. Sepolia also needs no chain-specific SDK. The project uses pinned `viem` 2.57.4 custom-chain definitions, Foundry with Solidity 0.8.28 and OpenZeppelin 5.6.1 already in the lockfile; NU7-related Rust pins and `Cargo.lock` were not changed.

## Fee and confirmation policy

The code uses 3 Base, 12 Ethereum Sepolia and 20 Robinhood L2 block confirmations. These are app risk thresholds, not chain finality guarantees. Robinhood/Arbitrum's transaction lifecycle distinguishes sequencer soft confirmation from posting to and finality on the parent chain ([Arbitrum chain info](https://docs.arbitrum.io/chain-info)); current ZecOne completion tracking rechecks the destination L2 receipt and canonical block but does not prove parent-chain finality. This remains a limitation for Phase 4A and blocks a production finality claim.

The registry caps gas, fee price, and sponsored gas budget separately per chain. Base preserves its previous data reserve. Ethereum has no rollup data reserve. Robinhood has no extra Base reserve; its estimate is checked against a conservative test budget. Actual receipt gas and effective price must be recorded in each live run. Static fee ceilings can fail under congestion and are not an execution guarantee.

## Wallet funds and required credentials

The initial read-only audit found missing funds, but the user subsequently funded the provider and authorized both live tests. Before setup the provider held 0.2 Sepolia ETH and 0.01 Robinhood ETH, and the local Zcash wallet held 8,450,000 spendable zatoshis. RPC gas estimates, a seller-funding allowance and a purchase reserve established that both destination balances were sufficient. No additional faucet grant was required. Actual spending and remaining balances are recorded with the live evidence.

Use RPC estimates rather than the previous arbitrary 0.05 ETH buffer. The setup script estimates each transaction before signing, checks current balance and retains a purchase reserve. It sends 0.001 test ETH to the separate seller for approval/listing gas. The existing user EOA receives the NFT and needs no destination gas for a sponsored purchase. Reused EVM addresses are publicly linkable across chains; Zcash shielding does not hide EVM activity.

The checked public RPCs require no API keys. A provider API key is optional, not configured; adding a private RPC requires a reviewed allowlist update. Wallet keys remain in existing gitignored `.secrets` files. No seed phrase, private spending key or EVM key is sent to a provider. Ethereum faucet eligibility may require a signed-in account or existing mainnet activity. Robinhood faucet availability is documented by Robinhood, but this task did not claim tokens. Funding and deployment blockers were resolved by the authorized live tests.

## Baseline and outcome

Before Phase 4A edits, captured baseline logs record 62 Node tests, 35 Solidity tests, four offline Rust tests and seven browser tests passing, together with typechecks/build. Baseline logs are under `phase4a-evidence/`. Existing Rust dependency pins were preserved.

Both added chains are available and EVM compatible, and both now have confirmed testnet contract deployments. Funded live purchase and restart verification is tracked in [Phase 4A results](PHASE4A-RESULTS.md). Synthetic tests and RPC simulations are never presented as real payments. The prior Base Sepolia purchase remains documented in [Phase 3 results](PHASE3-RESULTS.md).
