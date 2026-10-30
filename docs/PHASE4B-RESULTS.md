# Phase 4B results — real shielded payment and AMM swap verified

Completed 2026-10-13. A real shielded Zcash Testnet payment authorized one actual Base Sepolia Uniswap V2 AMM swap. The user's existing locally controlled EOA received **19.550169617820656117 ZTEST**. The separate prefunded provider supplied the input and paid destination fees. Independent receipt, reserve, token-balance, replay and service-restart checks passed. No mainnet transaction or automatic refund was performed. Phase 4C has not begun.

## Live payment and delivery

| Evidence | Verified value |
| --- | --- |
| Source network | Zcash Testnet, pinned NU7-compatible native wallet |
| Shielded payment | `92816a4d190bbfbcbe55cb1a09e1d7ee0785aa248ae1b7501f0edb2bc68e6e74` |
| Shielded pool / mined height | Ironwood (pool 4) / 4,497,075 |
| Confirmations at authorization | 13, exceeding the required 10 |
| Payment / native fee / total debit | 0.01 / 0.0001 / **0.0101 TAZ** |
| Destination | Base Sepolia, chain 84532 |
| Swap transaction | [0xf260da27…86097c77](https://sepolia.basescan.org/tx/0xf260da275e91d63d43e813ec26d335b33b58893746b4ca3b962df50786097c77) |
| Swap block | 48,053,847; canonical receipt verified beyond the three-block policy |
| User recipient | `0x1865Dd77bFcb632571d3c93144D5634F0D93c714` |
| Provider | `0xf9dE6070331A3B68233c3b2062BceB7105162Cd2` |
| Provider input | 0.0001 test ETH, wrapped through the router |
| Expected / actual output | 19.550169617820656117 ZTEST |
| Approved minimum output | 19.354667921642449555 ZTEST |
| Approved slippage | 100 basis points (1%) |
| Recipient token balance | 0 → 19.550169617820656117 ZTEST |
| Recipient native balance | Unchanged at 0.009999873999999741 ETH |

The user already held Base ETH from earlier phases, but this transaction spent none of it. Receiving the tokens requires neither user gas nor a user token allowance. The local user key signed the bounded purchase intent; the provider's separate key signed the destination transaction.

Request ID: `ed637b18-afda-4ba0-8e41-d4f271aafb28`. Signed order digest: `0x4bae79cef0cb128fb393b763abe60e28ee1ec04a098e10b064ac3a6a72f84b76`.

[Independent live evidence](phase4b-evidence/base/live-verification.json) includes the native wallet fee/debit, confirmation-at-authorization audit, exact receipt, block hashes, runtime hashes, balances and provider expenditure. Shielded amount attribution comes from the locally scanned wallet and durable journal; a public Zcash transaction reference alone does not reveal or prove the shielded recipient and amount.

## Contracts and real liquidity

All contracts below are on Base Sepolia. Official pinned Uniswap package artifacts supply WETH9, factory, pair and Router02. New contracts use Solidity 0.8.28 and OpenZeppelin 5.6.1. Dependency/source rationale is in [feasibility](PHASE4B-FEASIBILITY.md).

| Contract | Address |
| --- | --- |
| WETH9 | `0xf1ff9f71271f6090845839ebf536de743148e546` |
| ZTEST, fixed supply 10,000; 18 decimals | `0x485ec83255a8d4f480347c6b32f54b38ef3556d2` |
| V2 factory | `0x6235c7204558ace4c58df5e1f7e79451c55fe92b` |
| V2 Router02 | `0x21ebda77b340db6e93b6d40ed8561c234ff3066e` |
| WETH/ZTEST pair | `0x299bCB0734170Aa6C2dF81aE6444AffC475eC48E` |
| Restricted swap executor | `0x3cc004a9310815d2720e0d23bec349030271b780` |

| Pair reserve | Before swap | After swap |
| --- | --- | --- |
| WETH | 0.005 | 0.0051 |
| ZTEST | 1,000 | 980.449830382179343883 |

Actual pair Swap/Sync events, output-token Transfer, executor balance delta and receipt-block reserves were verified. The reserve change matches exact input and delivered output. This was a constant-product trade with the V2 fee. Seeded test liquidity has no claimed market value; the provider controls its remaining tokens and LP position.

The [deployment manifest](phase4b-evidence/base/deployment.json) records all seven setup transaction hashes, canonical receipts, initial reserves and runtime hashes. Temporary public-RPC `BlockNotFound` responses interrupted setup verification. The helper stopped without treating unknown outcomes as success, then reconciled the same persisted hashes. It now bounds read retries and requires two matching canonical observations beyond three confirmations. No replacement deployments or duplicate payments were sent. Original stop/resume logs remain in the evidence directory. Original deployment artifacts were preserved privately before formatting/rebuild; their hashes are in [artifact evidence](phase4b-evidence/deployment-artifact-hashes.json). Explorer source verification is not claimed.

## Actual expenditure

| Item | Actual test ETH |
| --- | --- |
| Setup native liquidity retained in pool | 0.005 |
| Seven setup transactions: total fees | 0.000080813412028230 |
| Setup total provider debit | 0.005080813412028230 |
| Swap input | 0.0001 |
| Swap execution fee | 0.000001605492 |
| Additional swap fee measured from balance delta | 0.000000000000000619 |
| **Swap total fee** | **0.000001605492000619** |
| **Swap total provider debit** | **0.000101605492000619** |
| Provider balance after swap | 0.093680716433875059 |

Swap gas used was 267,582 at 6,000,000 wei per gas. Total fees were derived from the provider balance decrease minus exact swap input; the difference from execution gas was 619 wei. The signed gas allowance was 0.0001 ETH, not the actual charge. The test ZEC conversion remains simulated at 1 TAZ = 0.02 test ETH and includes that fixed reserve. There is no automatic rebate or real exchange of ZEC for ETH.

## Implementation and protection

- A typed execution-intent union classifies preserved NFT signatures, versioned token-swap signatures and inert future-marketplace proposals. Existing signed NFT data is not rewritten. Future proposals expose no signing or execution endpoint.
- NFT and swap quotes share one durable SQLite reservation ledger and service lock. Aggregate per-chain reservations and unresolved transaction checks prevent double-booking funds and competing provider nonces.
- Quotes verify deployed bytecode, router/factory/pair configuration, token decimals, live reserves, constant-product output, price impact, gas estimate and canonical reference block. Input, output, route, recipient, minimum, slippage, deadline, provider and exact calldata are signature-bound.
- The immutable executor admits only its fixed Base router/pool/token route and bounded native spending. It enforces replay protection, expiry, recipient delivery, minimum output and an atomic token balance delta. No user token approval or arbitrary call path exists.
- Existing unique shielded payment attribution, ten-confirmation policy, reorg handling, persisted raw transactions and manual recovery records are reused. Exact simulation repeats before payment and before destination signing.
- The Tokens panel shows real balances, quote details, separate intent and native-payment approvals, confirmation progress, verified receipt and recovery state. Ethereum/Robinhood swaps are visibly unavailable.

## Replay, restart and tests

The existing signed call was replayed only through read-only simulation and reverted with `Replay`. The journal recorded one broadcast. Both local wallet and marketplace processes were stopped while native scanners were idle and restarted against the same databases. [Restart evidence](phase4b-evidence/base/restart-verification.json) shows scans increasing from 34 to 59 while order state, payment hash, destination hash, provider nonce 18 and all measured balances remained unchanged. There was no second execution and no recovery liability for this successful order.

**138 local tests passed**, compared with 120 before this phase:

| Suite | Passing | Evidence |
| --- | ---: | --- |
| Node/Anvil | 73 | [Node log](phase4b-evidence/node-tests.txt) |
| Solidity | 52 | [Contract log](phase4b-evidence/contract-tests.txt) |
| Rust, unchanged pinned code | 4 | [Offline Rust log](phase4b-evidence/baseline-rust.txt) |
| Browser | 9 | [Browser log](phase4b-evidence/browser-tests.txt) |

Both TypeScript checks and the production wallet build passed. New coverage includes actual local AMM deployment/trading, reserve math and impact, slippage/expiry, wrong chain/recipient/calldata, token decimals/tax/pause/router failures, callbacks/reentrancy, replay, shared concurrent reservations, unresolved NFT nonce gating, failed settlement/recovery, reorg/restart and browser permission/payment approvals. Existing underpayment, duplicate-payment and expired-order tests remain. Anvil uses disposable keys and synthetic payment observations; browser regression tests mock APIs. These are separate from the real testnet evidence above.

Phase 4A was checkpointed at `627f0a0` following Phase 3 `cee37b2`; work is on `codex/phase4b-swaps`. Prior live evidence, Cargo.lock and the Zcash manifest were checked against [preservation hashes](phase4b-evidence/preservation.json). Private SQLite backups, signing credentials and raw transactions remain gitignored and local.

## Screenshots and operation

- [Actual AMM quote review](phase4b-evidence/base/quote-review.png)
- [Native shielded fee review](phase4b-evidence/base/payment-review.png)
- [Final native payment approval](phase4b-evidence/base/payment-approval.png)
- [Completed wallet after restart, including actual token balance](phase4b-evidence/base/wallet-completed.png)

Use the [runbook](PHASE4B-RUNBOOK.md) for reproducible checks, read-only verification, local startup and manual recovery. Never clear existing payment/deployment markers to repeat the demonstration.

## Limits and stopping point

Base Sepolia token swaps passed. Ethereum Sepolia and Robinhood retain their independently proven Phase 4A NFT functionality; no swap deployments, pools or token deliveries are claimed for those networks. Their prior funding/connectivity do not establish swap support. This phase evaluated the extension boundary and leaves optional extra live swaps deferred; the fixed Base-only token and executor must not be reused by merely changing an RPC URL.

The system trusts the provider, native scanner, local host and RPCs. Ten Zcash confirmations and three Base L2 confirmations are operational policies, not cross-chain atomicity or parent-chain finality. Keys remain local development files; there is no independent security audit. Failed paid orders require auditable manual recovery, and no automatic refund is implemented. See [security](PHASE4B-SECURITY.md) and [limitations](PHASE4B-LIMITATIONS.md).

Phase 4B's required Base Sepolia proof is complete. Stop here; do not start Phase 4C, OpenSea/Seaport, Solana or mainnet work.
