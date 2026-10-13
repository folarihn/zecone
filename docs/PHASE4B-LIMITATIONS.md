# Phase 4B limitations

- Base Sepolia only for token swaps. Ethereum Sepolia and Robinhood retain Phase 4A NFT support; neither is advertised as swap-supported without a separate live swap proof.
- One controlled test token, one WETH-to-token V2 path, exact native input, and seeded demonstration reserves. No arbitrary tokens, production liquidity, market token prices, fee-on-transfer/rebasing tokens, token-to-token routes or universal-router commands.
- Test pricing remains simulated: 1 TAZ = 0.02 test ETH. A fixed 0.0001 ETH gas reserve is included even if unused. No automatic rebate, cross-chain atomicity, bridge or market-rate ZEC exchange exists.
- Reserves can move during the required ten Zcash confirmations. The signed minimum is enforced; output and execution are not guaranteed. A failed settlement leaves a manual recovery liability. No automatic refund is claimed.
- Receipt evidence uses transaction-local executor balance deltas and actual pair/token events, supported by receipt-block RPC state. The RPC and native scanner are trusted. Three Base L2 confirmations are not a claim of parent-chain finality.
- Gas estimates and conservative Base L1 reserves can become stale. The provider bears cost risk within its execution policy; the user's ZEC amount and slippage are never silently increased.
- Allowlisting, bytecode/metadata checks and simulation do not guarantee token safety. Only the known fixed-supply test token is admitted. Local mocks test hostile behavior separately from the actual AMM integration.
- Provider seed liquidity and LP tokens remain controlled by the test provider. Tokens have no claimed economic value. The same user EOA across networks publicly links activity; shielded Zcash does not hide EVM swaps.
- Local keys are plaintext development credentials under existing OS permissions. There is no enclave, hardware signer, ERC-4337 account or production security audit.
- Future-marketplace types are inert interfaces only. OpenSea APIs, Seaport execution, Solana, mainnet and Phase 4C are not implemented.
