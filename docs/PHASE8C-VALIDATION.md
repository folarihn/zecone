# Phase 8C validation

Starting commit: `e66ac6c`. Scope is read-only provider evidence and disposable tests. No live credential unlock, signing, submission, new payment, refund execution or mainnet spending. [Design, configuration and limits](PHASE8C-RPC.md).

## Changes

- `services/execution/rpc-confidence.ts`: shared modes, credential-safe configuration, independently asserted operators, bounded read-only transport and policy gate.
- `services/solana/receipt-confidence.ts`: finalized transaction/status/block/genesis and material effect comparison.
- `services/evm/receipt-confidence.ts`: chain/canonical-block/depth/receipt-effect comparison for registry testnets only.
- `services/solana/settlement.ts`, `services/evm/adapter.ts`: explicit report methods and opt-in required-corroboration receipt acceptance; no new financial authorization or submission path.
- `scripts/phase8-rpc-audit.ts`: fixed read-only historical destination probes, sanitized summary only.
- `scripts/phase8-preserve.mjs`: separate Phase 8C baseline/output namespace; previous inventories/reports retained.
- `scripts/phase6-lint.mjs`, `tests/phase8-rpc.test.ts`: lint coverage and sixteen disposable security regressions.

No changes to genesis/network allowlists, token pools, recipients, economic limits, signer/key code or historical credentials. The existing read-failover/status helper is not relabeled as independent corroboration. No original settlement receipt, signature, claim or payment authorization is modified.

## Tests and evidence

Sixteen new cases cover primary-only evidence and required-policy veto; independent Solana agreement with different observation heads; bounded secondary timeout; unavailable primary; different finalized transaction slots; wrong genesis; changed token/account/native/message effects; unavailable/pruned/lagging peer; duplicate operator/host and missing acknowledgement; compatible EVM depth observations; conflicting EVM status/block; wrong EVM chain/mainnet rejection and insufficient depth; credential/correlation redaction and send-method denial; required policy in both receipt adapters; completed-order restart/preparation/execution/refund veto; malformed/unsafe-number/oversized response rejection.

**480 tests pass**: 351 Node (including all 16 new RPC cases), 29 wallet UI, 17 extension, 6 historical UI, 3 isolated API/UI, 3 completed swap API/UI, 52 Solidity, 10 Rust wallet, 5 watch and 4 signer. Zero final failures; one pre-existing standalone expensive native signer proof remains ignored. Both TypeScript checks, scoped lint and production build pass. Focused runs are not double-counted.

Logs are under `phase8c-evidence/`: `node.txt`, `focused.txt`, `ui.txt`, `extension.txt`, `phase6c-ui.txt`, `phase7a-ui.txt`, `phase7c-ui.txt`, `contracts.txt`, `rust-wallet.txt`, `rust-watch.txt`, `rust-signer.txt`, `types.txt`, `types-web.txt`, `lint.txt` and `build.txt`. Earlier development/interrupted fixture output stays private. Local compiler-cache/loopback restrictions required permitted test execution. A diagnostic test initially lacked a BigInt serializer after adding adapter serialization coverage; the fixture was corrected, private configuration fields retained, and the full final suite passed.

All **537 historical + 91 Phase 7B = 628 protected files** match their original inventories. The inventories themselves match the earlier private audit copies. Both original financial journals match their pre-validation private fingerprints. Original Phase 8B evidence is unchanged in the final working tree; a copied audit helper's temporary report-path mistake was corrected and its previous report restored exactly before final validation. No wallet or journal was affected by that output-path issue.

Both completed settlements retain signed wire, signatures, receipts, one signing claim and one broadcast claim. Fresh finalized receipt reads match saved receipts; restart/replay/refund-veto probes on consistent SQLite copies pass with **zero signer access and zero broadcast calls**. Phase 7C's historical effects remain 76.043880 output tokens, 0.003981880 SOL total relayer debit, including 0.002976880 SOL rent. These are historical effects, not a new delivery/current balance. Refunds remain disabled. Evidence: `preservation.json`, `inventory-check.json`, `completed-order-audit.json` and `validation-summary.json`.

Reproduction (PowerShell):

```powershell
node --import tsx --test --test-concurrency=1 tests/*.test.ts
npm run typecheck
npm run typecheck:web
npm run lint
npm run wallet:build
$env:ZECONE_QA_EVIDENCE_DIR='.state/phase8c/browser'
npm run test:ui
npm run test:extension
npm run test:phase6c
$env:ZECONE_PHASE7C_REGRESSION='1'
npm run test:phase7a
$env:ZECONE_PHASE7C_FINALIZED='1'
npm run test:phase7c
forge test
cargo test -p zecone-zcash
cargo test --manifest-path services/zcash-watch/Cargo.toml
cargo test --manifest-path services/refund-signer-native/Cargo.toml
node --import tsx scripts/phase8-rpc-audit.ts
node scripts/phase8-preserve.mjs --phase8c
```

Initialize the private Phase 8C financial baseline with `--initialize` before validation if missing. Keep historical inventories and the earlier private inventory copy intact. Original journals are opened read-only; replay/restart probes use consistent private SQLite copies. Financial fingerprints never enter public evidence. Browser artifacts stay private and must not overwrite historical screenshots. Local Anvil/browser fixtures require loopback connectivity; public audit reads need explicitly permitted network access.

## Live provider validation

No independent secondary endpoint/operator acknowledgement is configured. Existing default primaries are the Solana devnet public endpoint, Base Sepolia public endpoint, Ethereum Sepolia PublicNode endpoint and Robinhood testnet public endpoint. No paid endpoint was enabled or purchased. Live results must be read from `phase8c-evidence/live-confidence.json`, including unavailable evidence; synthetic corroboration does not establish live two-provider agreement.

Actual read results: both Solana completed transactions, Base Sepolia and Robinhood testnet have usable primary evidence and report `PRIMARY_ONLY`. Ethereum Sepolia reports `DEGRADED` with `MISSING_OR_INSUFFICIENT_FINALITY`; this run could not obtain usable historical receipt evidence from its configured primary. This does not prove transaction failure, a changed old settlement, or permission to retry spending. **No live result is CORROBORATED.**

Fresh finalized Solana receipt comparison against saved receipts and duplicate/recovery/refund probes on consistent copies are in `completed-order-audit.json`. This is historical receipt verification, not another settlement or a current-wallet-balance claim. Audit signer/submission methods are forbidden and must remain unused.

## Remaining limits and Phase 8D boundary

Independent live corroboration remains blocked by the absence of an independently operated configured secondary. Primary-only preparation, balance/quote/simulation reads and legacy EVM paths remain as documented. Operator labels cannot prove actual upstream independence. EVM depth confidence does not prove L1/rollup consensus finality. Trusted RPC agreement does not prove an order's economic authorization; existing settlement policy remains necessary.

Legacy plaintext keys and same-user/process isolation limitations from Phase 8B are unchanged. No new UI confidence banner is claimed; explicit local/service reporting is implemented here. Provider provisioning and any stronger policy rollout require deliberate operator configuration. Phase 8D usability work can be reviewed separately, but must preserve these limitations. **Stop after Phase 8C.**
