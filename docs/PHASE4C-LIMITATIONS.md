# Phase 4C limitations and next blockers

- Base Sepolia only for Seaport. Existing custom NFT purchases on Ethereum Sepolia/Robinhood Testnet and the Phase 4B Base swap remain separate adapters. No mainnet purchase or real-money exchange is enabled.
- Genuine public Seaport 1.6 is used, with a newly deployed restrictive ZecOne wrapper. The wrapper is not an official OpenSea contract and this project has no claimed OpenSea partnership.
- The live listing is created and signed by a controlled local seller. It is not discovered through OpenSea or advertised as an OpenSea API listing. The production chains endpoint did not advertise Base Sepolia; the historical testnet API host was unreachable in this environment. API parsing/rate-limit/authentication behavior is covered by fixtures, not a live authenticated testnet purchase.
- Only one allowlisted collection, seller and fee-recipient policy, single fixed-price ERC-721, native ETH, full-open/full-fill, direct approvals and zero conduits. Arbitrary public listings, criteria, bundles, partial fills, restricted zones, ERC-20 consideration, dynamic prices, contract sellers and attribution suffixes are rejected.
- The read-only discovery adapter can request documented collection/order/fulfillment endpoints when the supported-chain gate passes. It is not wired to a production listing browser while testnet discovery is unavailable.
- Pricing is simulated: 1 TAZ = 0.02 test ETH, with a fixed gas reserve charged in the ZEC quote. It is not an exchange rate, liquidity guarantee or automatic gas refund. A separate controlled test fee returns to the provider in this demonstration and is disclosed distinctly from seller proceeds and actual gas.
- The provider is trusted and prefunded. It sees payment/purchase correlation, can decline settlement, and remains responsible for manual recovery. No automatic refund or cross-chain atomicity is claimed. A seller can cancel, revoke approval, transfer the NFT or sell elsewhere while the shielded payment confirms.
- Ten Zcash confirmations and three canonical Base confirmations reduce risk but cannot eliminate deep reorgs. Public RPC/lightwalletd outages, rate limits and local process contention can delay quotes or reconciliation. Recovery requires retained journals, wallet databases and keys.
- Local keys are stored in ignored files with separate user/provider helpers. This is not hardware-wallet isolation, encrypted production key custody or a sandbox against a hostile OS.

## OpenSea website assessment

Direct OpenSea website compatibility has **not** been demonstrated. The current ZecOne popup SDK only connects cooperating dApps; it is not injected into arbitrary pages. EIP-1193 method support and EIP-6963 discovery events in a cooperating page do not make the wallet discoverable on OpenSea. There is no WalletConnect transport today.

The next transport work would require either an actual browser-extension provider injected on the approved website, implementing EIP-1193 with EIP-6963 announcement, or a compatible WalletConnect session implementation. Then independently test origin/account permissions, personal/EIP-712 signing, supported chains and switching, user transaction approvals, disconnect/reconnect and the actual OpenSea login/purchase flow. The current restricted adapter must still reject unsupported transaction requests; connecting a wallet does not authorize arbitrary execution. No authentication bypass is proposed.

Phase 4D/5, transport implementation, broader listing support, production pricing/liquidity and automated refunds are outside this phase.
