# Phase 4A results — complete

On 2026-10-13, two fresh real shielded Zcash Testnet payments authorized successful NFT purchases on Ethereum Sepolia and Robinhood Chain Testnet. Both sellers received 0.0001 test ETH, and NFT #1 on each destination belongs to the existing user-controlled EOA `0x1865Dd77bFcb632571d3c93144D5634F0D93c714`. This user account held zero native ETH on both destinations throughout the purchases. The separate prefunded provider paid execution gas.

The user explicitly authorized both live tests using measured costs. Initial provider balances of 0.2 Sepolia ETH and 0.01 Robinhood ETH were sufficient, including setup, seller gas funding and purchase reserves. The earlier 0.05 ETH suggestion was an operating buffer, not a required minimum. Phase 4A is complete within the controlled testnet scope below; Phase 4B has not begun.

The preserved Phase 3 Base Sepolia purchase is Zcash transaction `09c49d32499e1fd2680a88308fbc154febbfb579ac765412795e9f445bd547b8` authorizing Base transaction [`0x1a8dfe23529ba4ff29971d5633494de2b5ce7d36f15b787cd4efa0ac8f04a9f8`](https://sepolia.basescan.org/tx/0x1a8dfe23529ba4ff29971d5633494de2b5ce7d36f15b787cd4efa0ac8f04a9f8). Its 10-confirmation shielded payment, seller payment and user ownership evidence remains unchanged.

## Implemented in the worktree

- Allowlisted Base Sepolia, Ethereum Sepolia and Robinhood Chain Testnet registry with separate RPC, explorer, confirmation, gas, fee and deployment policies. Unknown chain IDs and custom add-chain RPCs fail closed.
- Per-origin EIP-1193 network selection. Switch/add requests require local approval and recheck the selected network before signing. Pending calls are invalidated on a switch.
- Shared viem EVM adapter and real native EVM balance views. NFT reads cover known ZecOne collections only. Arbitrary NFT/token indexers are not configured.
- Phase 3 purchase quotes can bind chain ID, Zcash source network, provider and adapter. Provider reservations are grouped by destination chain. The original Base v1 quote/contract path remains unchanged.
- Testnet-only multichain NFT executor and seller inventory fixture for Ethereum Sepolia and Robinhood. It binds chain/provider/marketplace/adapter, recipient, listing/calldata, amount, fee budget, expiry and order ID, pays the seller atomically, and rejects replay.
- Read-only preflight command and evidence at [network-preflight.json](phase4a-evidence/network-preflight.json).

## Validation

The baseline before new implementation is preserved in [baseline logs](phase4a-evidence/). The Phase 4A verification rerun includes:

- TypeScript service and browser typechecks passed.
- 67 Node tests passed, including chain registry, chain-bound purchase typed data, strict add-chain validation, approval-gated switching and EVM receipt reorg handling.
- 41 Foundry tests passed, including recipient binding, seller payment, cancellation/expiry, replay, wrong chain/adapter, Robinhood-specific fee policy and mainnet constructor rejection.
- Four pinned offline Rust tests passed (unchanged Zcash NU7 dependencies).
- Production wallet build and all eight Playwright tests passed. The earlier six wallet-page failures were caused by the new network panel accepting a missing network list from old fixtures, then crashing. Response validation now reports malformed data without crashing, fixtures include the endpoint, and a new regression verifies the error state.

Logs are stored in `docs/phase4a-evidence/`. Passing local or synthetic tests do not prove a testnet deployment or payment.

## Live transactions, contracts and ownership

| Destination | Network result | Deployment | ZEC-funded purchase | NFT owner evidence |
| --- | --- | --- | --- | --- |
| Base Sepolia | Existing Phase 3 proof preserved | Existing Phase 3 addresses in [Phase 3 results](PHASE3-RESULTS.md) | Existing Phase 3 proof only | Existing Phase 3 user-owned NFT #1 |
| Ethereum Sepolia | Chain 11155111 verified | Eight canonical setup receipts verified | Real payment, 12 Zcash confirmations at authorization | NFT #1 owned by user EOA |
| Robinhood Chain Testnet | Chain 46630 verified | Eight canonical setup receipts verified | Real payment, 18 Zcash confirmations at authorization | NFT #1 owned by user EOA |

### Ethereum Sepolia

- Zcash Testnet payment: `44938c5d28d61143bf703cc5557cabf732c897dee1ffdb883a3a89d49bb43848`, mined at height 4496626, shielded pool 4 (NU7 Ironwood).
- Destination purchase: [`0x80a756ad54cbd5df1d5c698bef15d1dec7f55b9d8b2b3c06ebf0d0309787aaea`](https://sepolia.etherscan.io/tx/0x80a756ad54cbd5df1d5c698bef15d1dec7f55b9d8b2b3c06ebf0d0309787aaea), block 11904101; policy requires 12 canonical destination confirmations.
- Unique purchase: `0de883a6-95d8-47bb-ab11-ed493438ab03`.
- [Independent payment, receipt, seller, owner and gas evidence](phase4a-evidence/11155111/live-verification.json), [deployment receipts](phase4a-evidence/11155111/deployment.json), [restart verification](phase4a-evidence/11155111/restart-verification.json).

### Robinhood Chain Testnet

- Zcash Testnet payment: `8e301d20e3e660e9259ebcf9738910cf7be1311e979925d2c54e0bbb455911a8`, mined at height 4496573, shielded pool 4 (NU7 Ironwood).
- Destination purchase: [`0xd971607153447865f305fd07e0dafff217edc6f6136c03ab646554a63403499f`](https://explorer.testnet.chain.robinhood.com/tx/0xd971607153447865f305fd07e0dafff217edc6f6136c03ab646554a63403499f); policy requires 20 canonical destination L2 confirmations. This does not establish parent Ethereum finality.
- Unique purchase: `cc62d7ee-85a3-4ae8-9892-37492d0f6741`.
- [Independent payment, receipt, seller, owner and gas evidence](phase4a-evidence/46630/live-verification.json), [deployment receipts](phase4a-evidence/46630/deployment.json), [restart verification](phase4a-evidence/46630/restart-verification.json).

### Contracts and account separation

| Contract | Address on each new destination |
| --- | --- |
| Marketplace | `0x3a3f3b03349b5a9060d35c8252678f59dabf2a52` |
| NFT collection | `0xd74d45e0888dfd6d7df09e36808f0465bb0d0b01` |
| Restricted executor | `0xed299fc7f232e923da52ac3012ef8a1d538dcc0f` |

The addresses match because deployment used the same provider account and nonces on separate networks. They are separate deployments with chain-bound execution, signatures and immutable chain IDs. Always pair an address with its chain ID. The provider is `0xf9dE6070331A3B68233c3b2062BceB7105162Cd2`; the separate seller is `0x7D26bC3A7CE602cB1cf9F8Bb4e3a8eDCb052C4b0`. Neither owns the delivered NFTs. The user signer stays local and is separate from settlement signing.

### Restart and replay

Read-only verification required a confirmed scanned shielded payment, at least ten confirmations before preparation, a successful canonical receipt at destination depth, the exact marketplace event, seller balance increase, recipient ownership, and exactly one broadcast. Native wallet debit and fee records match each payment. Both orders remain settled with no outstanding review-required recovery for either.

After the wallet restart, scans increased while both transaction hashes, user owners, provider nonces, balances and single-broadcast counts stayed unchanged. Both local services were restored again after a tool-session interruption, and the same verifier was rerun. Process records are [restart-process.json](phase4a-evidence/restart-process.json) and [resumed-processes.json](phase4a-evidence/resumed-processes.json).

RPC simulations of each already-executed quote rejected with `Replay`; simulations of the same signed quote on the other new chain rejected with `InvalidQuote`. These are read-only simulations, not additional live reverted transactions. No duplicate payment or settlement was sent. Contract tests also cover wrong-chain signatures; the original Base proof was preserved rather than repeated.

### Screenshots

| Evidence | Ethereum Sepolia | Robinhood |
| --- | --- | --- |
| Quote approval | [Screenshot](phase4a-evidence/11155111/quote-approval.png) | [Original screenshot](phase4a-evidence/46630/quote-approval.png) |
| Shielded payment approval | [Screenshot](phase4a-evidence/11155111/payment-approval.png) | [Screenshot](phase4a-evidence/46630/payment-approval.png) |
| Pending payment | [Screenshot](phase4a-evidence/11155111/wallet-pending.png) | [Screenshot](phase4a-evidence/46630/wallet-pending.png) |
| Completed after restart | [Screenshot](phase4a-evidence/11155111/wallet-restarted.png) | [Screenshot](phase4a-evidence/46630/wallet-restarted.png) |

These capture the actual local application and its chain-derived state. Confirmation counts differ between snapshots as scanning advances. The original Robinhood quote screenshot retains a discovered label bug: “Base” appeared next to correct chain ID 46630. Its signed domain and separate payment approval were correct. The review now carries the actual network name, the misleading fallback was removed, and a Robinhood regression passes. The historical screenshot was not altered.

## Actual costs and liquidity

| Actual amount | Ethereum Sepolia | Robinhood Testnet |
| --- | ---: | ---: |
| Shielded payment (TAZ) | 0.03 | 0.015 |
| Native Zcash fee (TAZ) | 0.0001 | 0.0001 |
| Total user debit (TAZ) | 0.0301 | 0.0151 |
| Eight setup transaction fees (ETH) | 0.000024579465799994 | 0.00003858805 |
| Purchase gas fee (ETH) | 0.000000591066639008 | 0.00000210877 |
| Seller received for NFT (ETH) | 0.0001 | 0.0001 |
| Provider balance after purchase (ETH) | 0.198876753563194096 | 0.00886447598 |
| Seller balance after purchase (ETH) | 0.001098075904366902 | 0.0010948272 |
| User destination native balance (ETH) | 0 | 0 |

Total user Zcash debit for the two new purchases was **0.0452 TAZ**, including both native fees. Setup fee totals include provider and seller transactions; each separate 0.001 ETH seller-gas funding transfer is an internal transfer, not a fee. Purchase fees equal receipt gas used times effective gas price and independently match provider balance deltas after deducting the 0.0001 ETH NFT price. Exact wei values and all setup transaction references are preserved in the per-chain JSON.

The [Sepolia](phase4a-evidence/costs-11155111.json) and [Robinhood](phase4a-evidence/costs-46630.json) preflight estimates document why the funds sufficed. Each setup transaction was re-estimated before signing. The exact signed executor call was also simulated and estimated before ZEC approval: [Sepolia](phase4a-evidence/11155111/prepayment-gas.json), [Robinhood](phase4a-evidence/46630/prepayment-gas.json). Fixed test pricing includes a quoted gas reserve; it does not automatically rebate unused reserve or represent a market exchange rate.

## Reproduction and boundaries

Use [the runbook](PHASE4A-RUNBOOK.md) for pinned toolchain checks, network configuration, deployment, live approval and recovery commands. Existing completed orders must only be verified; the live helper intentionally refuses another attempt for its existing durable marker. Do not delete markers, payments or signed transaction journals to repeat a demonstration.

There is no remaining funding or RPC blocker for these completed proofs. The [limitations](PHASE4A-LIMITATIONS.md) and [security model](PHASE4A-SECURITY.md) still apply: trusted prefunded provider, simulated pricing, manual refunds, trusted scanning/RPCs, publicly linkable EVM addresses, known-collection-only NFT reads and an empty ERC-20 allowlist. Successful controlled marketplace purchases do not imply arbitrary dApp compatibility, a production bridge, atomic cross-chain exchange or production finality. No mainnet transaction, swap, Solana work or Phase 4B was performed.
