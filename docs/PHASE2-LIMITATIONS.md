# Phase 2 limitations

- The transport is an opt-in popup connector for dApps that include ZecOne's public provider SDK. It does not inject into arbitrary sites and will not automatically work with dApps that only detect installed extensions.
- WalletConnect v2/Reown WalletKit is not implemented. No Project ID, relay configuration or compatible test was available. The Reown relay requires a Project ID and an origin allowlist policy.
- Browser access from remote Internet origins to loopback services is subject to changing browser local-network protections. The included dApp fixture is on a separate loopback origin/port; this does not prove universal public-site reachability.
- Only Base Sepolia chain ID 84532 and one locally controlled EOA are supported. There is no ERC-4337 account, bundler, paymaster, EIP-1271 support, hardware signer, arbitrary chain, `eth_sign`, raw-transaction submission, batch call or general-purpose RPC proxy.
- The external transaction path enforces a 0.001 test ETH native-value ceiling and 0.005 test ETH execution-fee ceiling. Base L1 data fees are not included in that execution cap. Contracts can still be malicious; selectors, metadata and simulation are not guarantees.
- The EIP-712 signing method validates a valid Base Sepolia domain/verifying contract and asks for exact user approval. It cannot determine protocol-specific meaning or replay safety. The external protocol defines those semantics.
- The sponsorship contract permits only one test action to record a fixed note for the user EOA. It is not an NFT, bridge, swap or production ZEC conversion. The prefunded relayer pays Base gas. The ZEC price is fixed testnet units with no market-price claim.
- Settlement operator knows the receiving note and can correlate payment with the public Base transaction. Public address, call, timing and transaction value are public. The provider does not expose private Zcash wallet fields.
- Existing local key custody is plaintext OS-protected file storage under one user account. Same-user malware or gateway compromise can access both signer and runtime data. No formal audit, secure enclave, independent verifier or production service-level guarantee exists.
- Refunds are not automatic. A failed or uncertain settlement remains a durable recovery case requiring manual review; no failed or synthetic transaction is described as successful.
