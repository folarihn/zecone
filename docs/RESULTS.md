# Phase 0 results — live test passed

**Completed 2026-10-12 at 08:11 WAT (Africa/Lagos).** A real shielded Zcash Testnet payment of **0.01 TAZ** was received, verified with **10 confirmations**, and followed by one successful Base Sepolia NFT mint to the user-controlled wallet. The durable order state is settled. No frontend was built. No mainnet transaction, bridge or asset exchange was performed.

## Transaction references and ownership

| Operation | Reference |
| --- | --- |
| Payer funding, 0.125 TAZ | 2ff278de8aaf45428ba67232284be725025efcedfd05e7e9369d698c86b01628 |
| Successful shielded order payment | e1c868b73be5d6f67121b415507ea3a7529fc7c0fe9f9423933b7abd62757942 |
| Base contract deployment | [Transaction](https://sepolia.basescan.org/tx/0xcf1e9447d18d4937731d4cad4b6f06c34cea424fdc0f3f62e4ca6be53f360d9f) |
| NFT contract | [0x3a3f3b03349b5a9060d35c8252678f59dabf2a52](https://sepolia.basescan.org/address/0x3a3f3b03349b5a9060d35c8252678f59dabf2a52) |
| Successful NFT mint | [Transaction](https://sepolia.basescan.org/tx/0x22bbd585b84a07ee048f0728a409925d2c9eb4f3405d915dc507a65ec3be1bc5) |
| Verified NFT owner | 0x1865Dd77bFcb632571d3c93144D5634F0D93c714 |
| Order ID | 0xbda80ab32061662eb50fb6b80ada259a06daaa5a5502b2a0c7374dd845904821 |
| Token ID | 85784032535824098315306333478855276873012693735756378089562305503754498099233 |

The payment is a shielded Ironwood output (pool 4, index 1), worth 1,000,000 zatoshis, mined at Zcash height **4,491,375**. The verifier first authorized settlement at fully scanned tip **4,491,384**, exactly 10 confirmations. An earlier scan observed the real amount at six confirmations and correctly kept the order awaiting payment. The sender paid an additional **20,000 zatoshis** network fee. [Native sender metadata](evidence/zcash-send-metadata.json).

The mint succeeded in Base Sepolia block **48,010,357**. Independent evidence collection verified the canonical receipt, exact OrderMinted event, consumed order flag and ownerOf result with **44 Base confirmations**. Its saved Zcash audit showed 12 confirmations. These are recorded observations, not continuously updated counts or promises of finality. The user's Base ETH remained 0.01; the separate relayer paid gas.

**Primary evidence:** [live-test.json](evidence/live-test.json), including payment amount/height/block hash, mint receipt and event, owner, and the complete order audit. [Latest independent wallet/RPC observations](evidence/network.json). Shielded payment amount and recipient are established by local wallet scanning; a public explorer alone cannot establish them. No viewing or spending keys are exported.

## Verification

| Check | Result | Evidence |
| --- | --- | --- |
| Rust build and formatting | Passed with pinned NU7 prereleases | Cargo.lock; [format log](evidence/rust-format.txt) |
| Rust tests | 3 passed | [Rust log](evidence/rust-tests.txt) |
| TypeScript typecheck | Passed | [TypeScript log](evidence/typescript.txt) |
| TypeScript and local EVM tests | 20 passed | [Test log](evidence/typescript-tests.txt) |
| Solidity tests | 8 passed, including 128 fuzz cases | [Contract log](evidence/contract-tests.txt) |
| Real payment-to-mint integration | Passed, order settled | [Live evidence](evidence/live-test.json) |
| Live duplicate processing | Same intent returned the settled order; another tick sent no transaction | [Idempotency evidence](evidence/live-idempotency.json) |
| Credentials | Keys/seeds and backups stay local and gitignored under Windows ACLs | [Public addresses only](PUBLIC_WALLETS.json) |

Tests cover duplicate notes/snapshots, underpayments, confirmation thresholds, Ironwood receipts, wrong network, partial/stale scans, expiry, late/excess payments, reorgs, attribution conflicts, replay/tampered intents, crash/retry handling, confirmed EVM reverts and recipient ownership. The live idempotency check retained one order, one payment, one mint broadcast attempt and relayer nonce 2 before and after reprocessing.

Failure injection and the Anvil integration test use explicitly synthetic fixtures on a disposable loopback EVM, separate from the real transactions above. No deliberate extra failed transactions or underpayments were broadcast on public testnets.

## Issues found and resolved

1. **Windows stack overflow during proving.** The process exited before constructing or broadcasting an outgoing transaction. Native wallet history, sent-note count, process exit and persistence markers were inspected before retry. The wallet now runs with an explicit 64 MiB thread stack.
2. **Stable library incompatibility with NU7.** Initial txid 4a10f571865ace3c61fc53ed6c032bb81b12bdfd605a1703c63bf0d7ba00046a was rejected for an obsolete consensus branch. Empty-wallet scanning had not exposed this. The service now pins official NU7 prereleases, verifies server/library branch agreement and supports Ironwood observations. Private backups precede migration.
3. **Safe replacement after rejection.** The rejected transaction was retained until verified expired and unmined beyond expiry height 4,491,367. Only then was a replacement constructed for the same order and amount. The replacement is the successful payment above. [Expiry evidence](evidence/expired-payment.json) and [full recovery record](evidence/live-recovery.md) preserve both attempts. Native database writes used supported library APIs.

No refund was required or claimed. There are no open settlement recovery cases for this order. Sender construction/rejection recovery remains recorded in the audit and evidence. Build logs retain harmless incremental-cache copying warnings and Node's experimental SQLite warning.

## Trust assumptions and limitations

- The operator and public lightwalletd are trusted for payment attestation and chain data. The NFT contract verifies the user's bound intent and prevents replay; it does not verify Zcash consensus. Confirmation thresholds cannot eliminate reorg risk.
- NU7 currently requires the pinned **prerelease** Rust wallet libraries. Successful Phase 0 execution is not a production security audit.
- Gas sponsorship uses a prefunded EOA relayer. ERC-4337 bundlers/paymasters were researched; no UserOperation integration was implemented or claimed as tested.
- The user's key is separate from the relayer's key and used only by the local signing utility. Keys/seeds are plaintext development files under OS permissions; the same OS account can access them.
- Automatic refunds, seed-only restoration, fee replacement, EIP-1271 signatures and production scaling remain outside this slice. Failed settlements have a durable manual-review queue, not automatic refund-success claims.

Reproduce using [RUNBOOK.md](RUNBOOK.md), [FEASIBILITY.md](FEASIBILITY.md), lockfiles and scripts/verify.ps1. Inspect persisted state before running anything: this checkout already contains the completed order and deployed contract. **Stop here after Phase 0. Frontend work has not begun.**
