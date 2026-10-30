# Phase 4B feasibility — controlled AMM swap

Audited 2026-10-13. Phase 4A source and public live evidence were checkpointed at `627f0a0`, following Phase 3 `cee37b2`. Work proceeds on `codex/phase4b-swaps`. Existing NU7 Rust dependencies and historical signed orders must remain unchanged.

## Baseline and funds

Fresh baseline: 67 Node tests (including local Anvil), 41 Solidity tests, four pinned offline Rust tests and eight browser tests passed. Service and web typechecks passed. Logs are in `phase4b-evidence/baseline-*.txt`. These are local regression tests, not swap evidence.

Read-only RPC checks found provider balances of 0.098863135337903908 Base Sepolia ETH, 0.198876753563194096 Ethereum Sepolia ETH and 0.00886447598 Robinhood ETH, with zero active NFT reservations. See [timestamped balance evidence](phase4b-evidence/balances.json). These funds are independent by chain. Exact deployment, seed-liquidity and swap costs must be estimated before spending. No mainnet liquidity is used.

## DEX choice and verified sources

Uniswap's official [V2 architecture](https://developers.uniswap.org/docs/protocols/v2/concepts/architecture) separates factory/pair core from the router and wraps native ETH into WETH. This supports a small, inspectable reserve-based demonstration. Use the official published contract artifacts, not a token transfer masquerading as a swap.

Pin `@uniswap/v2-core` **1.0.1** and `@uniswap/v2-periphery` **1.1.0-beta.0**, matching their official [core package](https://github.com/Uniswap/v2-core/blob/master/package.json) and [periphery package](https://github.com/Uniswap/v2-periphery/blob/master/package.json). Periphery depends on core 1.0.0 and `@uniswap/lib` 4.0.1-alpha; retain exact transitive versions/integrities in the lockfile. The classic contracts use Solidity 0.5.16/0.6.6; modern ZecOne contracts continue using Solidity 0.8.28 and OpenZeppelin 5.6.1. Published artifacts avoid silently recompiling a different pair init-code hash. A local real-EVM test must verify the factory/router/pair bytecode combination before public deployment. These are established legacy contracts, not a claim that V2 is the newest protocol.

Official [V3 Base deployment documentation](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments) lists Base Sepolia factory, quoter and router addresses, while warning against assuming cross-chain address equality. V3 requires fee-tier/tick-range liquidity and a different quote path. A deployed router alone establishes neither a usable pool nor adequate reserves. No public token/pool liquidity is assumed verified here. V4/Universal Router expands command and callback surface beyond this bounded demonstration.

Decision: deploy a controlled V2 factory/router and WETH/test-token pool on Base Sepolia after local tests. Verify deployed runtime code, router factory/WETH, factory pair mapping, token metadata and actual funded reserves. Direct the router output to the user's existing EOA. Seeded test-token liquidity is demonstration liquidity with no market-value claim. The [historical V2 audit](https://dapp.org.uk/reports/uniswapv2.html) is relevant to upstream code, but does not audit ZecOne's new wrapper or guarantee arbitrary token behavior.

## Required architecture changes

The native scanner, ten-confirmation verifier, stable payment IDs and durable raw-transaction journal are reusable. NFT-specific intent validation and ownership checks are not swap verification. A swap adapter must bind exact input, output token/decimals, route, minimum output, slippage, router, deadline, target calldata hash and user recipient with a new versioned EIP-712 domain.

NFT and swap reservations must share one atomic SQLite journal and the existing provider service lock. A separate swap database whose worker checks only its own reservations would double-book provider ETH and miss unresolved NFT nonces. Legacy mint/action workers must continue seeing all reservations. Historical NFT intents remain byte-for-byte unchanged; adapter selection is explicit and unsupported future-marketplace intents fail closed.

Completion requires canonical receipt depth, exact executor and pair Swap events, actual recipient token delivery and reserve accounting. A later user transfer must not erase historical proof of delivery. Token delta must be tied to execution evidence rather than an unrelated current balance alone. Confirmed ZEC plus failed/expired/slipped execution remains an auditable manual recovery liability. No automatic refund or guaranteed future AMM output is promised.

## Scope and credentials

Start with Base Sepolia chain 84532, configured TLS RPC, existing locally controlled recipient and separate provider key. No new wallet keys or external API credentials are required. The source remains Zcash Testnet through the pinned NU7 scanner; spending keys stay local. An allowlisted standard test ERC-20 and one WETH-to-token route are sufficient. Fee-on-transfer, rebasing, arbitrary routers/tokens, callbacks and external marketplace execution are excluded.

Ethereum Sepolia and Robinhood are evaluated only after Base succeeds. Their prior NFT proofs establish EVM connectivity, not swap support. Neither may be labeled swap-supported until its contracts, reserves, fees, token delivery and real swap are independently verified. Phase 4C and OpenSea/Seaport execution are outside this phase.

## Post-proof multichain evaluation

Base Sepolia passed the real swap and restart proof on 2026-10-13; see [results](PHASE4B-RESULTS.md). Optional extra live swaps are deferred, not claimed blocked by lack of funds.

| Network | Verified foundation | Swap-specific result |
| --- | --- | --- |
| Base Sepolia, 84532 | Native ETH RPC, provider funding, official V2 artifacts, code hashes, token metadata, seeded reserves and actual gas | Real swap and recipient delivery independently passed |
| Ethereum Sepolia, 11155111 | Phase 4A native ETH execution, RPC adapter and funded provider | No swap router/pool/allowlist deployed or verified in this phase; disabled |
| Robinhood Testnet, 46630 | Phase 4A EVM/native ETH execution, RPC adapter and funded provider | No swap router/pool/allowlist deployed or verified in this phase; disabled |

The current test token and executor intentionally reject chains other than 84532, and the quote/signing adapter pins Base-specific fee assumptions. Expansion requires a separately reviewed chain-bound configuration/contract, independent artifact/runtime checks, funded reserves, fresh native/data-fee estimates, simulation and token-delivery/restart proof. Prior NFT gas costs or Base addresses cannot substitute for these checks. Public pool availability and liquidity on the additional chains remain unverified.
