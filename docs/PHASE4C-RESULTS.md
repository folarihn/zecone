# Phase 4C results — real shielded payment and Seaport delivery verified

Completed 2026-10-13. A real shielded Zcash Testnet payment authorized one genuine Seaport 1.6 fulfillment on Base Sepolia. Token 1 was delivered directly from the seller to the user's locally controlled wallet. Independent payment, seller proceeds, ownership, replay and service-restart verification passed. No mainnet transaction or automatic refund was performed. Phase 4D/5 has not begun.

## Live payment, delivery and cost

| Evidence | Verified result |
| --- | --- |
| Zcash Testnet payment | `be203c56ae342ae368d13547b1a65f09f8912decd6bf2e7fd18aaf7071ff8bdf` |
| Shielded pool / mined height | Ironwood (pool 4) / 4,497,319 |
| Confirmations at transaction preparation | **13**, above the required ten |
| Payment / native fee / total user debit | 0.010125 / 0.0001 / **0.010225 TAZ** |
| Seaport fulfillment | [0x473e5fe8…ab511e4](https://sepolia.basescan.org/tx/0x473e5fe828041b87b7efb9a8099534840128f00dc7713e5662c79fb00ab511e4) |
| Destination block | 48,056,302; canonical receipt verified beyond the three-block policy |
| NFT | Collection `0xf7b5482a479c68b9d652cf8005234f82d27b2c3f`, token 1 |
| Verified owner | `0x1865Dd77bFcb632571d3c93144D5634F0D93c714` |
| Seller received | **0.0001 test ETH**, independently verified balance increase |
| Controlled fee | 0.0000025 test ETH paid back to the provider fee recipient |
| Gross consideration | 0.0001025 test ETH |
| Actual destination gas | **0.000001593678000632 test ETH**, including 632 wei beyond execution gas |
| Provider net purchase debit | **0.000101593678000632 test ETH**, after the returned controlled fee |
| Gross consideration plus gas | 0.000104093678000632 test ETH |
| User destination ETH | Unchanged at 0.009999873999999741 ETH |
| Destination broadcasts | **One**, same transaction retained across restart |
| Replay check | Read-only simulation reverted with `Replay`; no duplicate transaction sent |

The user already held Base ETH from previous phases, but spent none on this fulfillment. The user signed the bounded purchase intent locally; the provider's separate key signed and paid for the destination transaction. Seaport transferred directly from seller to user, without provider custody.

Request ID: `e5b3eb4b-5b4b-4782-9bc0-fd4f68e5d219`. User-signed intent digest: `0xe8cad3396e93b697e6cf294b60294df033a719cd64be3ace3dd10098e11e7d2a`.

[Independent live evidence](phase4c-evidence/base/live-verification.json) records the native wallet debit/fee, confirmed note and block, authoritative Seaport order hash/status, exact calldata/events, canonical receipt, historical and current ownership, seller proceeds and actual provider expenditure. Shielded payment amounts and attribution come from the local native wallet; a public transaction hash alone does not prove those shielded fields.

[Restart evidence](phase4c-evidence/base/restart-verification.json) shows the same payment, destination hash, owner, balances, provider nonce 21 and one broadcast after fresh reconciliation scans. There were no unresolved recovery records for this purchase. Setup fees were separately 0.000021252882009208 test ETH from the provider and 0.000000291468000094 from the seller; no new seller funding was needed.

Screenshots: [exact intent review](phase4c-evidence/base/quote-review.png), [native payment review](phase4c-evidence/base/payment-review.png), [completed desktop wallet](phase4c-evidence/base/wallet-completed.png), [completed mobile wallet](phase4c-evidence/base/wallet-completed-mobile.png). The expanded mobile navigation uses two contained rows; browser checks cover all navigation targets remaining inside the bar and viewport.

## Scope delivered

Added a dedicated Seaport adapter, immutable recipient-bound executor, read-only OpenSea discovery/fulfillment validation module, separate local user signing helper, shared durable Zcash/payment/liquidity lifecycle, and wallet Seaport purchase panel. Only Base Sepolia, single fixed-price ERC-721, native ETH, full-open/full-fill orders with direct seller approval and exact bounded consideration are supported. The NFT moves directly from seller to the user's controlled EOA through genuine Seaport.

This uses the existing public **Seaport 1.6**, not the previous custom marketplace. The source of the demo listing is explicitly `controlled-seaport`. OpenSea API testnet access is not established, and OpenSea website compatibility is not claimed. No mainnet funds or Phase 4D/5 work are included.

## Contracts and listing

All addresses are Base Sepolia, chain 84532.

| Role | Address |
| --- | --- |
| Public Seaport 1.6 | `0x0000000000000068F116a894984e2DB1123eB395` |
| Restricted ZecOne executor | `0xe669643e85e15edd84f61c0c8fafface5ec6fe16` |
| Controlled ERC-721 collection | `0xf7b5482a479c68b9d652cf8005234f82d27b2c3f` |
| User recipient | `0x1865Dd77bFcb632571d3c93144D5634F0D93c714` |
| Seller | `0x7D26bC3A7CE602cB1cf9F8Bb4e3a8eDCb052C4b0` |
| Provider and controlled fee recipient | `0xf9dE6070331A3B68233c3b2062BceB7105162Cd2` |

Token 1; Seaport order hash `0x35e3c4fccc83842c2b29898c2ce3149163ac6ca63f114f35dfa9e1793701bd3a`. Seller price 0.0001 test ETH plus a 0.0000025 test ETH controlled fee, total 0.0001025 test ETH. The controlled fee returns to the provider and is not an OpenSea fee. The quote charges 0.010125 TAZ at the explicitly simulated rate, including a fixed 0.0001 test ETH gas reserve. The native payment fee is separate.

Setup transactions:

- [Collection deployment](https://sepolia.basescan.org/tx/0x37a961e6bc071303dea40f633383b2c86b9ec7b61f5afba3344507f901e61e4c)
- [Executor deployment](https://sepolia.basescan.org/tx/0x7bbeea7e9e63643ac90860129ec130f39e0c19e996eb6ecb7a31b47655e8038b)
- [Seller token-specific approval](https://sepolia.basescan.org/tx/0xf475c0aacf70ea923945041d3b0c7c480c250269c0ff18be1459b5543f2734cc)

[Deployment evidence](phase4c-evidence/base/deployment.json) includes canonical receipts, runtime hashes and standard order components. Original deployment artifact hashes are preserved separately. Explorer source-code verification is not claimed.

## Validation

**168 tests passed**: 102 Node/Anvil, 52 Solidity, four unchanged Rust tests, ten browser tests. The complete original 138-test baseline was run before changes. The 29 new Node tests and one new browser test exercise the Seaport feature; the new wrapper is tested against the actual unmodified protocol on a local Anvil fork. Synthetic payment observations used in failure tests are never presented as live payments.

Coverage includes authoritative order hashes, seller signatures/onchain validation, real protocol fulfillment, wrong NFT/seller/recipient/domain/chain, unsupported structures, changed fees/consideration/calldata, cancellation/expiry/fill, revoked approval/transferred ownership, shared reservations, insufficient liquidity, nine-versus-ten confirmation gating, duplicate/replay attempts, failed fulfillment recovery, restart reconciliation and destination reorganization. Prior duplicate/underpaid/expired payment tests remain intact.

Both TypeScript checks and the production wallet build passed. [Node log](phase4c-evidence/node-tests.txt), [Solidity log](phase4c-evidence/contract-tests.txt), [Rust log](phase4c-evidence/baseline-rust.txt), [browser log](phase4c-evidence/browser-tests.txt), [build log](phase4c-evidence/wallet-build.txt). The final live-helper typecheck also passed after adding guarded reconciliation steps.

[Preservation verification](phase4c-evidence/preservation-verified.json) confirms all 135 prior evidence and Rust dependency files remain unchanged. Existing wallet keys, historical orders and contracts were reused/preserved; the private SQLite checkpoint and signed raw journals remain ignored. The parent checkpoint is `9f79d866e35eddd430854043ec1eb369e2b9a98c`, on branch `codex/phase4c-seaport`.

## API and website boundary

The documented API adapter implements chain gating, collection listing discovery, individual order lookup and read-only fulfillment generation, authorization/rate-limit handling and exact structured-transaction validation. It never signs, publishes a listing or executes raw API calldata. The production chains endpoint returned no Base Sepolia; the historical testnet host failed to connect. No API key was created and no authenticated live API listing purchase is claimed. Details and official sources are in [feasibility](PHASE4C-FEASIBILITY.md) and [access evidence](phase4c-evidence/opensea-access.json).

Direct OpenSea website connection is untested. ZecOne's cooperating-dApp popup SDK does not inject a provider into OpenSea and has no WalletConnect transport. A real extension EIP-1193/EIP-6963 or WalletConnect implementation, followed by site-specific origin/account/signing/chain/approval tests, is the next connection blocker.

## Operations and remaining trust

Initial quote/attachment requests failed closed with generic 503 responses. The quote failure created no row; the original start marker and balances were preserved. A single quote was then created. The approval signature was saved before attachment interruption; reconciliation reused that same signed intent and idempotent payment allocation. There was no replacement signature/payment. The exact initial RPC/lock cause was not established and is not presented as diagnosed. [Attempt notes](phase4c-evidence/live-attempt-notes.json) preserve this limitation.

The operator remains trusted and prefunded. Ten Zcash confirmations and destination receipt depth do not provide cross-chain atomicity. Seller changes during confirmation, outages, gas changes and reorgs can require manual recovery. Refund liabilities are auditable, but automatic refunds are not implemented. Local key files/helper separation are not hardware-wallet security. Shielded amount/recipient evidence depends on the native local wallet scan; public transaction hashes alone do not reveal those fields. The provider can correlate source payment with public NFT delivery.

See the [runbook](PHASE4C-RUNBOOK.md), [security model](PHASE4C-SECURITY.md) and [limitations/next blockers](PHASE4C-LIMITATIONS.md). Stop after Phase 4C.
