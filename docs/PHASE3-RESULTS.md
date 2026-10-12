# Phase 3 results — live testnet purchase verified

Completed on 2026-10-12. An independent marketplace requested NFT #1. ZecOne obtained a signed purchase quote and a separate native payment approval, then a real shielded Zcash Testnet payment authorized a prefunded Base Sepolia purchase. The marketplace transferred the NFT directly from a separate seller to the user's wallet. No Phase 4 work was started.

## Verified live evidence

| Item                    | Verified result                                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Marketplace             | `http://127.0.0.1:4322`, separate from wallet origin `http://127.0.0.1:3210`                                                                                               |
| Zcash payment           | `09c49d32499e1fd2680a88308fbc154febbfb579ac765412795e9f445bd547b8`                                                                                                         |
| Shielded output         | Ironwood pool 4, index 0; **1,000,000 zatoshis / 0.01 TAZ**                                                                                                                |
| Zcash block             | **4,492,959**; `00000c2418776281bb99d7f7dadf6f87e16c95b5352dc3e69f32aa200d75b3fa`                                                                                          |
| Authorization threshold | **Exactly 10 confirmations** at preparation; fully scanned tip 4,492,968                                                                                                   |
| Native Zcash fee        | **10,000 zatoshis / 0.0001 TAZ**; total user debit **0.0101 TAZ**                                                                                                          |
| Base purchase           | [`0x1a8dfe23529ba4ff29971d5633494de2b5ce7d36f15b787cd4efa0ac8f04a9f8`](https://sepolia.basescan.org/tx/0x1a8dfe23529ba4ff29971d5633494de2b5ce7d36f15b787cd4efa0ac8f04a9f8) |
| Base receipt            | Success in block **48,029,979**; canonical hash and at least three confirmations verified                                                                                  |
| NFT                     | Collection `0xad890bdbb04ea701b15dabd5677aa083456b4124`, token **#1**                                                                                                      |
| Verified owner          | `0x1865Dd77bFcb632571d3c93144D5634F0D93c714` — user's wallet, distinct from provider and seller                                                                            |
| Seller payment          | **0.0001 test ETH**                                                                                                                                                        |
| Replay                  | One settlement broadcast; the same signed call returns contract `Replay()` during read-only simulation                                                                     |
| Restart                 | Same settled order and hashes; scans increased **38 to 41**; provider nonce stayed **10**, balance unchanged                                                               |

[Canonical evidence](phase3-evidence/live-verification.json) contains all setup transaction references, marketplace and ERC-721 transfer events, authorizing confirmation count, native fee, current ownership and balances. [Restart evidence](phase3-evidence/restart-verification.json) records the before/after comparison. Shielded value and attribution are established by local wallet scanning; a public explorer alone cannot reveal them. No viewing or spending key was exported.

## Contracts and roles

| Role                  | Base Sepolia address                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary marketplace  | [`0xad7dddee1eddbfc917efaeaffebd298d3fd4be39`](https://sepolia.basescan.org/address/0xad7dddee1eddbfc917efaeaffebd298d3fd4be39) |
| ERC-721 collection    | [`0xad890bdbb04ea701b15dabd5677aa083456b4124`](https://sepolia.basescan.org/address/0xad890bdbb04ea701b15dabd5677aa083456b4124) |
| Bounded executor      | [`0x473db5dbb706e0b06d9403d150a923c48afa1f4d`](https://sepolia.basescan.org/address/0x473db5dbb706e0b06d9403d150a923c48afa1f4d) |
| Provider              | `0xf9dE6070331A3B68233c3b2062BceB7105162Cd2`                                                                                    |
| Separate local seller | `0x7D26bC3A7CE602cB1cf9F8Bb4e3a8eDCb052C4b0`                                                                                    |
| User / NFT recipient  | `0x1865Dd77bFcb632571d3c93144D5634F0D93c714`                                                                                    |

Contracts use Solidity 0.8.28 and pinned OpenZeppelin 5.6.1. Deployments and all three listing transactions were independently re-fetched and matched to canonical blocks. The RPC initially returned placeholder block hashes in the setup wait helper; final verification does not rely on them, and the helper now requires an explicit canonical recheck. Explorer source verification was not performed; deployment transaction and state verification was.

## Liquidity accounting

These balances bracket the purchase after setup, excluding setup funding and deployment fees.

| Account  |    Before (test ETH) |     After (test ETH) |
| -------- | -------------------: | -------------------: |
| Provider | 0.098964388276703496 | 0.098863135337903908 |
| Seller   | 0.000996897609158483 | 0.001096897609158483 |
| User     | 0.009999873999999741 | 0.009999873999999741 |

Provider spent **0.000101252938799588 test ETH**: 0.0001 seller price plus **0.000001252938799588 test ETH** total transaction fees, measured from the balance difference and including Base L1 fees. User ETH did not change. The fixed quoted gas reserve was 0.0001 test ETH, priced at the explicitly simulated rate **1 TAZ = 0.02 test ETH**. Unused reserve is a disclosed fixed demo charge. No real exchange or refund occurred.

Setup separately funded the seller with 0.001 test ETH and paid contract/listing gas. All eight setup transaction hashes and receipt fields are in the canonical evidence file.

## Validation

- **62 Node tests passed**: retained Phase 0–2 coverage; genuine local Anvil execution; TypeScript/Solidity quote digest matching; unfunded-recipient delivery; duplicate/under/over/late payments; insufficient liquidity; two-worker concurrency; scan-lock waiting; failed and unknown transactions; reorg/restart; origins and privacy. [Log](phase3-evidence/node-tests.txt)
- **35 Solidity tests passed**: ordinary purchases; exact payment; seller approval; tampered terms; expired/cancelled/sold listings; reentrancy; chain/contract replay. [Log](phase3-evidence/contract-tests.txt)
- **4 locked offline Rust tests passed**; NU7 pins and Cargo.lock unchanged. [Log](phase3-evidence/rust-tests.txt)
- **7 browser tests passed**, including exact quote approval, separate native fee approval, mobile layout and preserved wallet views. [Log](phase3-evidence/browser-tests.txt)
- Service and web typechecks and production build passed. [Build log](phase3-evidence/build.txt)

Synthetic scanner fixtures and disposable Anvil keys are test evidence only. The live JSON, native observations and canonical receipts above are separate real-testnet evidence.

## Recovery exercised during the demonstration

The first unsigned quote was rejected after a popup-label mismatch, with no payment or receiving order created. The next signed quote encountered a background scan lock; its existing signature was preserved and reused through **Recheck saved purchase**. A stale native lock was removed only after verifying its recorded process had exited. Neither condition caused a replacement signature, duplicate payment or extra purchase.

The native fee and payment were then approved locally from that saved purchase. The independent marketplace displayed the same completed purchase through its public status method. These findings produced regression tests, bounded scan-lock waiting, shared user-wallet serialization, accurate pending status and popup/mobile-layout corrections.

Purchase identity: `325a8e82-edae-4498-9712-0ee4aff3536f`. The rejected unsigned draft remains auditable and has no funds attached.

## Screenshots and reproduction

- [Independent marketplace](phase3-evidence/marketplace-before.png)
- [Exact quote approval](phase3-evidence/quote-approval.png)
- [Separate native payment approval](phase3-evidence/payment-approval.png)
- [Real pending confirmations](phase3-evidence/wallet-pending.png)
- [Completed marketplace](phase3-evidence/marketplace-completed.png)
- [Wallet after restart](phase3-evidence/wallet-restarted.png)
- [Mobile wallet after restart](phase3-evidence/wallet-restarted-mobile.png)

Follow [PHASE3-RUNBOOK.md](PHASE3-RUNBOOK.md). Never rerun a marked live-send helper to force another payment. Listing #1 is consumed. Credentials, native journals, raw signed transactions and sessions remain in gitignored local storage. Source checkpoints are `334c638` (preserved Phase 0–2), `ce40f94` (tested marketplace implementation), and the final evidence/fixes checkpoint.

## Trust and limits

This is a trusted prefunded testnet payment processor with simulated pricing, not an anonymous or trustless bridge. The provider can correlate shielded payment with public ownership and must handle recovery/refunds manually. RPC/light-client chain views and the local Windows account are trusted. Only the configured marketplace, collection and bounded purchase method are supported. No production exchange, arbitrary OpenSea integration, ERC-4337 deployment, mainnet transaction or automatic refund was attempted. See [security](PHASE3-SECURITY.md) and [limitations](PHASE3-LIMITATIONS.md). Phase 3 is complete; stop before Phase 4.
