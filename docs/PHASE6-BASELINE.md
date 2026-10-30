# Phase 6 baseline

Checkpoint inspected: `9af83ee`, 15 October 2026. Working tree was clean. Phase 5.2 remains partially complete: a real payment was confirmed and a real-note unsigned refund reviewed; no live refund, physical signer isolation or mainnet readiness.

The Next 16 / React 19 app uses a loopback-only custom Node server, cookie sessions, CSRF checks and local signing subprocesses. Existing panels cover mint, fixed action, marketplace, bounded Base Sepolia AMM, Seaport and non-executing OpenSea inspection. Preserve these adapters and their durable SQLite journals rather than building another executor.

Working: authenticated wallet summary, known-contract ownership queries, origin permissions, native payment fee review, explicit payment authorization, durable recovery and replay guards. Configured EVM execution networks: Base Sepolia (84532), Ethereum Sepolia (11155111), Robinhood testnet (46630). The latter two do not have enabled swap adapters.

Incomplete: fragmented navigation and progress views; light-first styling; the installed extension only injected on OpenSea; no unified cross-adapter checkout list; no general token/NFT indexer; one configured EVM account rather than arbitrary account import; no general-purpose Zcash send API. Existing arbitrary dApp transactions use the user's account and a separate review, never the ZEC relayer.

Simulated: testnet ZEC conversion pricing, controlled AMM inventory and automated browser fixture data. Real-chain evidence from previous phases is historical, not a new Phase 6 transaction. Unsupported: mainnet settlement, live refunds, arbitrary sponsored calldata, Solana settlement and EVM private execution.

Baseline logs are in `phase6-evidence/`. The initial watch rebuild failed for disk exhaustion; only disposable compiler incremental cache was cleared. The initial Node test runner hit sandbox subprocess EPERM and was rerun with approved subprocess permissions. Exact final results are recorded in PHASE6-IMPLEMENTATION.md. No historical server is started during development: its startup opens old databases and runs workers. Tests use disposable databases/profiles. A hash inventory protects credentials, historical database files and Phase 5.2 state/evidence.
