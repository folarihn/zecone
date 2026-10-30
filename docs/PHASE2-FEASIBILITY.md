# Phase 2 feasibility and integration decisions

Reviewed 2026-10-12 against the preserved Phase 1 checkpoint `3dfae1d`. The current branch is `codex/phase2-connectivity`; Phase 2 changes were already present as uncommitted work at the start of this review, so the implementation has been audited and extended in place. Phase 0/1 source, Rust pins, state, keys and evidence remain preserved.

## Existing system

The project uses Node `>=24.12.0 <25`; exact web dependencies are locked in `package-lock.json`: Next.js 16.4.0, React/React DOM 19.3.0, TypeScript 7.0.2, viem 2.57.4, and OpenZeppelin 5.6.1. Solidity is pinned to 0.8.28. The Rust wallet manifest and `Cargo.lock` retain the Phase 0 NU7-compatible prerelease dependencies. Phase 1's user-controlled Base Sepolia account is a locally signed EOA, separate from the prefunded relayer. The merchant/scanner, payment journal, ten-confirmation Zcash verifier and Base receipt recovery are existing local services. No ERC-4337 smart account or EIP-1271 validation is present.

Zcash remains Testnet, chain identity `zcash-testnet`; shielded scanning and sending run through the preserved local Rust wallet plus the configured TLS lightwalletd. EVM scope remains Base Sepolia, chain ID 84532 (`0x14a34`), through the public Base RPC URL `https://sepolia.base.org`. The repository already has all necessary private credentials for the Phase 1 test wallets. Phase 2 introduces no new credential or remote wallet service. Do not print, copy into project files, or upload secret files.

## Transport choice and actual coverage

Implement a small public EIP-1193 provider SDK at `public/zecone-provider.js`. A compatible external dApp includes the SDK, discovers it using EIP-6963 announcement/request events, and opens ZecOne's local `/connect` popup from a user gesture. This is a separate-origin, explicit popup transport. It uses `postMessage` only with a random channel, exact target origin, checked `event.origin`, checked `event.source`, request IDs and a locally authenticated session. The approval page binds the first eligible opener origin and refuses later origin changes. Only this document has a narrowly scoped `Cross-Origin-Opener-Policy: unsafe-none` response header so the browser preserves the popup opener. All wallet JSON APIs retain loopback host, Origin, session and CSRF checks.

It does not inject `window.ethereum` into arbitrary existing websites. Compatibility requires the dApp to integrate the connector SDK. The separately served fixture at `test-dapp/` demonstrates a genuinely different origin/port. EIP-6963 discovery describes wallets already made available to a page; it is not itself an injection mechanism. The dApp fixture imports the public provider source as an SDK artifact. Browser restrictions on access from a publicly hosted dApp to a loopback wallet may differ across browser versions and require real-browser verification before wider distribution.

WalletConnect v2 / Reown WalletKit is deferred. The official setup uses a registered Project ID and WalletConnect relay; project origin allowlisting is an operational requirement. This repository has neither a Project ID nor relay policy/credential, and Phase 2 does not claim WalletConnect support or add speculative SDK APIs. A browser extension is a future alternative if broad compatibility with sites expecting injected providers becomes necessary.

Implemented provider methods: `eth_requestAccounts`, `eth_accounts`, `eth_chainId`, same-chain `wallet_switchEthereumChain`, `eth_sendTransaction`, `personal_sign`, and `eth_signTypedData_v4`. Explicitly unsupported RPCs fail with provider error codes. Network support is Base Sepolia only; the user account and accepted transaction chain ID are checked before signing. Account access and every message/signature/transaction requiring authority show the exact website origin and require visible approval. Public chain reads return only the public EVM chain/account data. No Zcash fields or cross-chain mapping enter the provider payload.

## Signing, review and limits

EVM signatures and transactions go through the existing separate local user signer. DApp requests cannot supply nonce, gas or fee fields; the gateway selects these after simulation and displays them. The signer reloads the authenticated approval file, checks the configured user address, chain, current pending nonce, exact recipient/data/value, gas and fee cap, re-simulates, signs locally and persists the signed transaction bytes before broadcast. The gateway stores the returned transaction hash before broadcast and reconciles the same raw transaction/receipt after interruption. It will not silently sign a replacement transaction. User signatures and private keys are not returned to dApps except a specifically approved message signature; transaction raw bytes and private keys never cross the provider.

For transactions, UI review includes origin, account, Base Sepolia, recipient, value, calldata, estimated gas, nonce, fee ceilings, decoded known selectors, token-approval warnings, unknown-call warnings and simulation status. Simulation is only a state snapshot/preflight and cannot establish contract safety. Phase 2 enforces a 0.001 test ETH value ceiling and a 0.005 test ETH execution gas ceiling per request; Base L1 data fees are explicitly additional.

The ZEC-funded extension is deliberately narrow: user signs a typed intent for a single fixed `recordFor(user, NOTE)` call to the configured Base Sepolia action contract. The immutable intent includes a unique order/digest, chain, user EOA, target, calldata, zero max value, gas budget, fixed 1,000,000 zatoshi price and expiry. The existing payment service still requires ten canonical Zcash confirmations before the prefunded relayer can execute. The Solidity contract rechecks the EOA signature, fixed target/call/value/budget/price/expiry and unique order. This is prefunded testnet sponsorship, not a ZEC-to-ETH swap, bridge or market quote. Execution has an auditable recovery record; automatic refunds are not claimed.

## ERC-4337 / EIP-1271 assessment

ERC-4337 introduces smart-account ownership/validation, EntryPoint selection, UserOperation construction, a separate mempool/bundler, simulations, account deployment/factory, nonce handling and optional paymaster deposits, policy, limits and recovery. It does not simply sponsor the current EOA transaction. Coinbase documents a Base Sepolia CDP Paymaster & Bundler endpoint requiring a developer API key; no such external credential is configured here. A contract account would also need EIP-1271 `isValidSignature` verification for dApp protocols that support contract signatures. Current wallet logic, NFT ownership and approval helpers are EOA-based; ordinary contract-signature interoperability has not been tested.

Conclusion: an ERC-4337 experiment is not low-risk within the Phase 2 vertical slice. Keep the EOA. A future experiment should select and pin an audited account implementation and EntryPoint version, deploy a separate account owned by the existing EOA, test UserOperation simulation/submission/replacement/recovery and EIP-1271 against protocols that support it, add a configured paymaster policy with strict target/method/budget limits, and only then offer an explicit user-authorized asset migration. Do not move keys or assets automatically.

## Official primary references

- [EIP-1193 provider interface and error codes](https://eips.ethereum.org/EIPS/eip-1193)
- [EIP-6963 multi-provider discovery](https://eips.ethereum.org/EIPS/eip-6963)
- [EIP-2255 wallet permissions](https://eips.ethereum.org/EIPS/eip-2255)
- [EIP-3326 chain switching](https://eips.ethereum.org/EIPS/eip-3326)
- [EIP-712 typed structured data](https://eips.ethereum.org/EIPS/eip-712)
- [ERC-1271 contract signature validation](https://eips.ethereum.org/EIPS/eip-1271)
- [ERC-4337 account abstraction](https://eips.ethereum.org/EIPS/eip-4337)
- [Base `eth_chainId` reference](https://docs.base.org/base-chain/api-reference/ethereum-json-rpc-api/eth_chainId)
- [Coinbase CDP Paymaster/Bundler viem guide](https://docs.cdp.coinbase.com/paymaster/guides/wagmi-viem-integration)
- [Reown WalletKit overview](https://docs.reown.com/walletkit/overview) and [relay Project ID/origin allowlist requirements](https://docs.reown.com/walletkit/ios/cloud/relay)
- [Browser `postMessage` security guidance](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)

The EIP texts define the stable protocol surface; provider error behavior and chain ID were checked against those primary sources. SDK versions and transport claims above reflect this repository's lockfiles/configuration and official provider documentation, not inferred methods from an uninstalled wallet SDK.
