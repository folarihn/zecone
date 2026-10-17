# Phase 7C.2 — live paid-order recovery, unsigned only

Starting checkpoint: `a7a41c0`. The operator's Phase 7C.2 request explicitly authorizes preparation of the original paid order, not signing, broadcast, another payment or refund execution. Full order/payment/recipient associations remain restricted to the local journal and private operator captures.

## Live recovery and evidence

The initial read-only journal inspection and independent devnet signer/recipient-ATA queries confirmed `RECOVERY_REQUIRED`, one active confirmed 100000-zatoshi payment, no signing/broadcast claim, no signed wire, no signature, no submission history since the order and no recipient token delivery. No contradictory evidence was found. See [initial reconciliation](phase7c-evidence/live2-initial-audit.txt).

The configured primary returned the exact devnet genesis and all nine fixed route accounts. The SDK verified the Raydium pool, program/owners, pinned program-data hash, token layouts, mints and liquidity. There is no configured secondary endpoint, so this phase makes no claim of independent multi-provider verification. Primary-only preparation is permitted by the existing explicit policy; disagreement protections remain intact. See [RPC validation](phase7c-evidence/live2-rpc-diagnosis.json).

Used `scripts/phase7c1.ts terms --review-unsigned-rpc` on the **live** journal. The existing attempt-specific preparation grant was still valid. The recovery mechanism rechecked fresh native owned-note evidence, original payment authorization, immutable original intent and independent absence of prior settlement/refund claims before atomically reopening only this order's Solana row. It created an `UNSIGNED_RPC_RETRY_ONLY` review, not an execution approval. The general order stays `recovery`; the original deadline, two-hour grant expiry, payment association, recipient and old reasons/approvals remain unchanged.

Then `scripts/phase7c1.ts ready <terms-digest>` prepared and simulated the actual live order. This differs from Phase 7C.1's copied-journal rehearsal. Both execution and submission functions are unconditionally disabled in that tool. Real simulation returned no error, **48611 compute units**, **5000 lamports estimated fee** and **143 remaining block heights**. [Prepared-state verification](phase7c-evidence/live2-prepared-verification.json) confirmed original payment/deadline/recipient/limits, zero signing claims, no signed transactions and no exact execution approvals. [Live simulation evidence](phase7c-evidence/live2-simulation.json) is explicitly unsigned and is not a finalized swap.

The rehearsal bytes expired during validation and were archived through `retire-expired-unsigned --review-expired-unsigned`. Its digest and approval cannot be reused. All previous expired reviews and approval records are retained. A final candidate is generated only after tests, fresh native evidence, economic revalidation and the user's separate readiness response. Readiness authorizes unsigned preparation only. Full exact bytes/digest/lifetimes stay private and are presented to the human separately.

## Bound economics

The original input is **0.001 WSOL**, with **76.043880** expected arbitrary devnet test tokens, **75.283441** minimum and **1%** maximum slippage through the original pinned Raydium CPMM pool/program. The output token has no asserted stablecoin identity or monetary value. No recipient, mint, amount or pool/program replacement is authorized.

Current direct measurement found two missing token accounts, **1488440 lamports** rent each (**0.00297688 SOL** total), below the immutable **0.006 SOL** rent cap. Estimated network fee is **0.000005 SOL**, capped at **0.00001 SOL**. Maximum total relayer debit stays **0.00701 SOL**; relayer inventory is sufficient. Rent and liquidity are refreshed before final preparation; the quote remains subject to its measured expiry. See [economic measurement](phase7c-evidence/live2-economics.json).

Exact approval still requires a later explicit human response for the displayed fresh digest. Quote age, application approval expiry and chain-enforced blockhash validity are separate gates. Any expired gate requires new unsigned bytes, re-simulation and another exact approval. Neither recovery authorization nor readiness permits key unlock/signing/broadcast.

## Privacy and remaining limits

Zcash identifiers and viewing/spending keys are not sent to Solana RPC or Raydium. No DEX HTTP API is used. Diagnostics exclude endpoints/credentials/raw errors and payment-to-recipient associations. Private captures retain the operator audit trail; public evidence is minimized. Browser captures are local and gitignored. Solana account activity and unsigned simulation are visible to the selected provider; public destination ownership, timing correlation, the trusted relayer and same-OS development-key limitations remain. No destination anonymity is claimed.

Historical wallet credentials and the unresolved original transfer are untouched. No new Zcash payment, live key unlock, signing, broadcast or refund activation occurs. Phase 7C is **not complete**, and Phase 8 is not started.

## Validation

427 tests pass: 302 Node, 25 wallet UI, 17 extension, 6 historical UI, 3 real isolated API, 3 real swap API/UI, 52 Solidity, 10 Rust wallet, 5 watch and 4 offline signer. One pre-existing standalone expensive proof remains ignored; isolated Node integration exercises native proof/signing. Both typechecks, lint and production build pass. All 537 historical and 91 Phase 7B protected files remain unchanged.

Logs: [full Node](phase7c-evidence/live2-node.txt), [wallet UI](phase7c-evidence/live2-ui.txt), [extension](phase7c-evidence/live2-extension.txt), [historical UI](phase7c-evidence/live2-historical-ui.txt), [real API](phase7c-evidence/live2-real-api.txt), [swap API/UI](phase7c-evidence/live2-real-swap-ui.txt), [contracts](phase7c-evidence/live2-contracts.txt), [wallet](phase7c-evidence/live2-rust-wallet.txt), [watch](phase7c-evidence/live2-rust-watch.txt), [signer](phase7c-evidence/live2-rust-signer.txt), [types](phase7c-evidence/live2-types.txt), [web types](phase7c-evidence/live2-types-web.txt), [lint](phase7c-evidence/live2-lint.txt), [production build](phase7c-evidence/live2-build.txt), [final independent reconciliation](phase7c-evidence/live2-final-audit.txt), [preservation](phase7c-evidence/preservation.json).

The full Node suite includes recovery, swaps, RPC failover, privacy/replay, expiry, concurrency and restart tests. Native/contract tests use isolated fixtures; synthetic signing tests do not access live credentials. No production source changes were necessary in this phase. Final short-lived approval details remain private and are freshly generated only after this validation and the user's readiness response.

The final candidate's minimized verification record is [final prepared-state verification](phase7c-evidence/live2-final-preparation.json). It contains no payment identifier, recipient, order join or exact wire. Full exact bytes/digest and their chain/application lifetimes remain in private operator captures and the human approval summary. This record is not an execution approval or finalized settlement.
