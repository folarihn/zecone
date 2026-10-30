# Phase 4A security model

Testnets only: Base Sepolia 84532, Ethereum Sepolia 11155111 and Robinhood Chain Testnet 46630. Mainnet IDs, Solana, token swaps and arbitrary ZEC-funded calls are outside the allowlist. The ordinary marketplace contract and multichain executor enforce the testnet chain ID at construction and execution. The new contracts are deployed on both destination testnets, with independent canonical receipt and immutable-policy verification recorded under `phase4a-evidence`.

## Keys and privacy

- Existing local user, provider and seller EVM keys remain in separate `.secrets` files. The user key is opened only by the local signer after exact origin/session approval. The settlement provider has no user signing authority. The dApp does not receive any EVM private key or Zcash viewing/spending key.
- The user EVM account is reused across chains. Its address, balance, transactions, contract calls and NFT ownership are public and linkable. Zcash shielding does not make EVM activity private.
- Public RPC operators see network metadata and public addresses. The configured RPC is an allowlisted service endpoint, never supplied by a dApp. Chain-ID health checks detect obvious misconfiguration but cannot establish RPC honesty.
- The local operator and same Windows account remain trusted. Local process separation is not hardware isolation. No independent security audit has been performed.

## dApp approvals and replay protection

Permissions are scoped to an exact validated origin. Account access is opt-in. `wallet_switchEthereumChain` and `wallet_addEthereumChain` are pending approval actions; switching invalidates outstanding approvals for that origin. Add-chain requests must exactly match the predefined chain ID, RPC, explorer and currency. Signing rechecks the approval digest, session, account, chain, nonce and fee bounds.

New marketplace signatures bind source Zcash network, destination chain ID, provider, adapter, executor, marketplace, listing, NFT, seller, user recipient, exact price, simulated ZEC amount/rate, gas budget, calldata hash, refund destination hash, origin and expiry. The contract recomputes the quote on its own chain, checks listing/approval/ownership, consumes the order, atomically pays the seller and transfers the NFT to the user. Chain ID and verifying-contract domain separate signatures across Base, Ethereum and Robinhood. Durable unique order/payment IDs and the purchase journal prevent duplicate settlement across retries/restarts.

The existing Base v1 contract and typed quote remain unchanged. New networks use version 2 quotes and the immutable chain-specific executor. Changing recipient, provider, target contract, listing, calldata, price, fees, expiry or chain invalidates the authorization.

## Zcash authorization and recovery

Only local Zcash wallet observations authorize settlement. The service requires a complete verified scan and ten confirmations; unconfirmed or partial observations never settle. Each order gets a unique shielded receiving destination and the exact output identity is counted once. Payment is not considered a swap: the user pays test ZEC to a trusted provider and the provider spends separately funded test ETH on a destination network.

Liquidity reservations are scoped per destination chain and checked again before settlement. RPC/receipt uncertainty, failed execution, reorg, insufficient liquidity and timeout preserve the saved order, signed transaction and manual recovery state. No automatic refund or blind replacement transaction is allowed. The operator must record an independently confirmed shielded refund before calling recovery resolved.

## Chain finality limits

Ethereum and Base settlement require configured canonical block depths and a second block-hash check. Robinhood uses 20 canonical L2 blocks in this prototype. It is an Arbitrum Nitro chain; sequencer confirmation and parent Ethereum finality are distinct. Parent-chain data posting/finality is not currently checked by the settlement worker. This limitation must be resolved before any production use or strong finality claim.
