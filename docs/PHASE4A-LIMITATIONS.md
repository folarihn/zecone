# Phase 4A limitations

Phase 4A remains a trusted testnet prototype. Both new destination chains have confirmed deployments; live purchase, fee, ownership and restart evidence is recorded in [results](PHASE4A-RESULTS.md) and its per-chain evidence files. The existing Base Sepolia Phase 3 proof is preserved and remains separate. Successful controlled purchases do not establish production readiness or support for arbitrary dApps.

- Per-chain balances are real RPC reads. No ERC-20 contracts are configured, so no ERC-20 balances are shown. NFT views query known ZecOne collections only; there is no complete cross-network NFT indexer.
- The public Robinhood RPC is rate-limited. Production requires a reliable provider or independently operated node and validation against another data source.
- Robinhood's Nitro fees contain L2 execution and L1 data components. Recorded receipt fees and provider balance deltas measure the actual test transactions. The fee cap/estimate may not cover changing network conditions.
- Settlement counts canonical destination L2 blocks (20 on Robinhood); it does not wait for parent Ethereum posting/finality. This threshold is a reorg mitigation, not a hard-finality claim.
- The dApp interface supports EIP-1193 requests through a restricted local EOA wallet. The user must approve each chain change and each signing action. Unsupported RPC methods, custom RPCs, unknown chain IDs and arbitrary ZEC-funded calldata are rejected.
- The user EOA address is reused across chains, publicly linking the same account. Shielded Zcash does not hide public EVM transactions or ownership.
- The exchange rate and gas reserve are simulated test values. The provider is a trusted testnet payment processor; there is no production bridge, swap, market pricing or atomicity between Zcash and EVM settlement.
- A confirmed ZEC payment followed by unavailable liquidity, RPC failure, revert or reorg remains a manual recovery liability. No automatic refund is implemented. A separate shielded refund requires operator review and its own confirmed transaction.
- Zcash scanning, local RPCs, the Windows account and provider are trusted. This is not a full-node verified Zcash-to-Ethereum proof, hardware isolation, audited custody, or production security review.
- Local Foundry/Anvil tests and replay simulations are explicitly separate from real payment and purchase receipts. The initial Robinhood quote screenshot retains a discovered display bug (Base label beside the correct chain ID 46630); the signed domain and separate payment review were correct, and the label was fixed with a regression test before Sepolia approval.
- Force-stopping the Windows service can leave scanner lock files. Recovery requires proving the recorded process has exited before removing that specific lock. Payment and signed-transaction journals must never be removed to force retries.
