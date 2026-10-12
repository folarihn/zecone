# Live test construction recovery — 2026-10-12

The first local send for request `d862b657-e9a8-4dba-ac99-efc778466f39` exited with `thread 'main' (19472) has overflowed its stack`, before returning any broadcast acknowledgement.

Before retry, the operator verified:

- Recorded process PID 32356 had exited.
- The durable `.started.json` marker existed, but the constructed-transaction `.json` marker did not. The code writes the latter before calling `send_transaction`.
- A read-only query of the native wallet found one transaction: original incoming funding `2ff278de8aaf45428ba67232284be725025efcedfd05e7e9369d698c86b01628`, mined at 4,490,256, with no created timestamp, raw bytes, fee or target height. `sent_notes` count was zero.
- Therefore the interrupted attempt had no persisted outgoing transaction and had not reached the broadcast call. This conclusion is specific to this inspected failure; missing markers alone must not generally be treated as proof of no payment.

The Rust entry point was moved onto a thread with an explicit 64 MiB stack, and Tokio worker stacks were explicitly sized too. `cargo fmt --check`, `cargo build --locked --offline` and both Rust tests passed after the change. The old process lock and started marker were renamed in the private wallet directory with `interrupted-stack-overflow` names, preserving them. The retry reused the same request UUID, account, amount and recipient. No native wallet database rows were edited and no alternate payment order was created.

Successful payment and settlement evidence, if completed, is recorded separately in `live-test.json`; this recovery record is not a payment-success claim.

## Consensus rejection

The retried construction produced txid `4a10f571865ace3c61fc53ed6c032bb81b12bdfd605a1703c63bf0d7ba00046a` with fee 20,000 zatoshis, target height 4,491,327 and expiry 4,491,367. Its first broadcast returned code -25. A later exact-transaction reconciliation found it absent and a same-bytes rebroadcast returned code -1 with the diagnostic that the transaction used an incorrect consensus branch ID. Neither response was treated as a payment.

`GetLightdInfo` reported branch `77190ad9`, node `v7.0.0-rc.0`, lightwalletd `v0.5.4` and chain `test`. The initial stable `zcash_protocol 0.10.5` selected an older branch. The official `0.11.0-pre.0` release sets NU7 Testnet activation to 4,465,026 with branch `77190ad9`. The project upgraded to the corresponding published prerelease crate family and adapted RNG, clock, boxed address and migration APIs. Both wallets and the original executable/lockfile were backed up privately before migration. A consensus preflight test rejects old and unknown branches at the current height. Ironwood output observation (pool 4) was added and its ten-confirmation/deduplication policy tested.

The rejected transaction and original request remain preserved. A replacement must wait until native reconciliation reports `expired-unmined` at a fully scanned tip beyond 4,491,367, and must be linked to the same signed order. No manual native wallet database mutation is permitted.

The required expiry check subsequently passed at tip 4,491,368, followed by a fresh check saved in [expired-payment.json](expired-payment.json). Native `set_transaction_status(TxidNotRecognized)` recorded absence after sync and a second lookup. The replacement request is `c6b591fd-967a-4a82-9201-407a538d62f2`, linked to the original request and the unchanged order `0xbda80ab32061662eb50fb6b80ada259a06daaa5a5502b2a0c7374dd845904821`. Its amount and destination are unchanged. The order journal records both the consensus rejection and replacement-after-expiry events.
