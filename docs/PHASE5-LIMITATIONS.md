# Phase 5 limitations and release gates

2026-10-13. **Phase 5 is not complete. No live shielded refund has been signed, broadcast or confirmed.** No new asset purchase was approved for this checkpoint. Phases 0–4E evidence remains historical evidence, not a Phase 5 refund proof.

| Requirement | Implemented/verified | Remaining work |
|---|---|---|
| Preservation | 284 prior public files/pins, 26 private files and eight historical settled orders checked unchanged | Separate-device encrypted backup custody remains operational work |
| Twenty-state lifecycle | Validated versioned graph, audit events, refund recovery adoption | Wire all new purchase stages into this graph without rewriting history |
| Refund authorization | User/operator/signer certificates, strict native Ironwood effects verification and independently scanned watch-wallet evidence | Funded-note validation, production deployment, independent execution interlock and separate-device verification |
| Shielded refund | Isolated PCZT review/signing, synthetic proof/extraction, seed-free UFVK scanner with unfunded real-chain proof | Actual-note PCZT export; canonical transaction/confirmation reconciliation; live signing and broadcasting remain disabled |
| Concurrency/crashes | Execution/refund races, native request/order/input claims, exact replay, finalization recovery and a simulated delivery journal covering crashes/ambiguous acknowledgements | Simulated delivery is not wired into the production refund transport; real chain/broadcast reconciliation remains unimplemented |
| Live refund proof | None | Separate signer device and isolated new wallet, fresh paid order, controlled destination failure, ten-confirmation refund proof |
| Market reference | Real Coinbase/Kraken ZEC/USD and ETH/USD feeds, timestamps, quorum/deviation/freshness checks | CoinGecko adapter requires a Demo key and has no live validation here |
| Quote policy | Reference-only integer quote calculations, bounded fee/movement/deadlines, provider-commitment semantics tested | Real references do not determine payable legacy intents; versioned execution/contract integration remains |
| Liquidity/gas/minimums | Existing per-chain reservation, gas caps, exact NFT consideration, swap minimum output retained | Reference quote is not independently reserving liquidity; avoid treating it as a payment offer |
| Keystore | Standard AEAD/KDF, isolated approval vault, explicit lock/unlock, reversible verified copy tests | Existing funded wallets remain plaintext; no activation, OS isolation or seed-only restoration proof |
| Unified checkout | Shared payment, gas, recipient, privacy and recovery terms across three products | Complete interactive refund UI and real failed/refunded browser flow remain gated |
| OpenSea import | Strict URL parser and authoritative metadata/order resolution; mainnet always non-executable | Positive end-to-end live URL import not demonstrated; unsupported order types remain rejected |
| Privacy | Minimal new lifecycle events/refund public views; authenticated price API; no added analytics | Provider still correlates payments/recipients; historical audit retention is unchanged |

## Critical blocker and alternative

The user confirmed no second computer is available. The portable workflow now passes separate-process local review/sign/proof/extraction/recovery with synthetic notes. Its development password is beside its encrypted keys, and the same OS user can access both; this is explicitly simulated isolation. Real-chain readers remain blocked from signing. The current final test total is 284, with typechecks and production build passing; earlier evidence is retained. See [submission readiness](PHASE5-SUBMISSION-READINESS.md).

The second independent provider returned no usable evidence. The latest fresh payer scan reached 4,498,578 with zero receipts. The user's authorized 0.002 ZEC funding attempt from the original payer was interrupted without a saved transaction reference. Its construction marker and lock remain; there has been no automatic retry. This recovery blocker prevents claiming either funding success or a funded live refund proof.

The user chose an independent signer on another computer and prohibited existing credential migration. The existing merchant wallet still loads its seed for scanning/allocation and has not been switched to the new adapter. Reusing its local `send` command would not create an independent refund signer. The new isolated native integration verifies and signs synthetic transaction effects separately from the review certificate; the real-chain watch reader is blocked from signing. The [watch-only proof](PHASE5-WATCH-ONLY.md) uses separate local databases but the same provider and OS account, and is unfunded. There is no validated production deployment or enabled broadcast path.

Supported PCZT primitives have now been integrated and locally tested for a narrow Ironwood profile. Safest continuation: provision an isolated signer wallet on a separate device, export viewing data only to a new backend wallet, connect independently verified actual-note evidence, and implement exact-transaction broadcast/confirmation reconciliation. Validate that deployment before funding a fresh live demonstration. Do not weaken signer checks to produce a demo transaction. See [native integration](PHASE5-NATIVE-REFUNDS.md).

Until those gates pass, retain manual review and disabled refund execution. A separately operated manual wallet is an operational alternative only after independent verification and explicit authorization; it would not satisfy the automated Phase 5 acceptance criteria and is not invoked by this checkpoint.

## Browser evidence boundaries

Real browser evidence uses the local backend and actual historical orders without route mocking. Real market lookups and read-only testnet RPC simulation are distinguished from synthetic UI/contract fixtures. Earlier fresh quote checks timed out behind an orphaned service lock; its absent owner and unchanged settled history were verified before archiving that lock. The original lock is retained privately, and the public recovery report records the checks. No native send marker was removed. See the final results/report for the post-recovery quote outcome.

No mainnet transactions, real-money liquidity, production bridge, Solana support, arbitrary marketplace execution or Phase 6 work were added. No new refund transaction reference exists to publish.
