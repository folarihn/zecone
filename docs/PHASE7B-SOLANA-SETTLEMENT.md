# Phase 7B Solana settlement — completed testnet demonstration

16 October 2026. Starts at `ee33020`. A fresh real shielded payment of 0.001 TAZ reached 13 confirmations before separately approved Solana execution. One real 0.001 SOL delivery finalized on devnet, exact transaction effects were verified, and the durable order is COMPLETED/settled. Restart reconciliation, duplicate-execution rejection and completed-delivery refund veto passed against this order. See [transaction evidence](PHASE7B-TRANSACTION-EVIDENCE.md). Phase 7C/8 have not begun.

## Disk space

C: had about 2.7 GiB free. The project's 7.8 GiB Rust target output was moved to `D:/ZecOne-BuildCache/phase7b-69f0dd44/target`. A Windows junction preserves the original workspace target path and native helper locations. No personal files, wallet files, credentials, source or evidence were deleted. After builds, C: had about 10.4 GiB free and D: 233 GiB free. D: must remain available for these rebuildable native artifacts. This machine-specific junction is not a Git artifact.

## Delivered implementation

The existing payment Store, native Zcash transaction builder, UFVK scanner, Solana transaction policy, paired API, wallet UI and unified checkout are reused. Phase 7B has separate profile, journal and browser state. No historical wallet backend or settlement worker starts. Phase 7A's funded disposable payer is assigned as the dedicated devnet relayer; its unchanged key is loaded only by an explicit operator command. The recipient has a separate local user-controlled key.

`SOLANA_DEVNET_SOL_DELIVERY` binds family/network/full genesis, source, recipient, lamports, fee cap, profile/request ID, shielded payment and two-hour quote expiry. Supported amounts: 0.001, 0.002 or 0.005 devnet SOL. Pricing is fixed demonstration pricing: 100,000 zatoshis (0.001 TAZ) per delivery, not an exchange rate or production liquidity. Payer fee cap: 10,000 zatoshis; Solana fee cap: 10,000 lamports.

A fresh shielded address and viewing-key-only scanner serve the single-use order. The Store enforces unique order/account/address and note attribution. Fresh complete native scans, owned Ironwood notes, exact account/address/amount, inclusion and ten confirmations precede authorization. Excess payments enter recovery. Unconfirmed, underpaid or reorganized observations cannot authorize execution. The browser cannot supply scan evidence.

Preparation checks inventory plus fee allowance, constructs one canonical System Program transfer, verifies message/accounts/fee payer/blockhash, simulates, and persists the digest. Exact operator approval precedes signing. A signing claim is persisted before using the key; signed bytes and signature are committed before one submission attempt. Submission uses preflight, maxRetries zero and a deadline. Lost responses remain SUBMISSION_UNCERTAIN. There is no replacement/re-sign/rebroadcast path. Restart moves interrupted construction/signing to recovery, and a concurrent recovery veto prevents unpersisted bytes being submitted.

Reconciliation queries the original signature at finalized commitment, compares the approved complete message, verifies fee and exact per-transaction recipient/relayer balance deltas, then marks completed. Current aggregate balances alone are insufficient. Completed delivery vetoes refunds/re-execution. No automatic scheduler or live refund path was added.

The Solana view includes delivery terms/status and the unified tracker represents Solana without an EVM chain ID. Address reveal remains explicit. The browser cannot send ZEC, load relayer keys or broadcast. Approvals/execution are operator-mediated; a fully browser-driven signer flow is not claimed.

## Reproduce safely

The existing profile is ready; do not reprovision it. Use `npm run phase7b -- status`, `npm run phase7b -- funding`, `npm run wallet:build`, then `npm run phase7b:wallet`. Pair with the private one-use token in `.state/phase7b/browser/pairing.json` and verify the disposable local account. Do not run the historical wallet backend.

After funding the fresh payer with mature testnet notes, stop the browser backend and run `npm run phase7b -- prepare-payment`. Review exact network, shielded destination, amount, actual fee, transaction ID and expiry. Obtain human approval before `npm run phase7b -- broadcast-payment <exact-txid> --allow-testnet-broadcast`. This submits only persisted bytes once. Uncertainty requires investigation, never another request ID or preparation retry.

Run `npm run phase7b -- observe` to scan and persist ten-confirmation authorization, then `npm run phase7b -- prepare-solana` to review the exact unsigned digest. Obtain separate human approval before `npm run phase7b -- broadcast-solana <exact-digest> --allow-devnet-broadcast`. Run `npm run phase7b -- reconcile` to verify final effects, and repeat reconciliation after restart. Both approved broadcasts have already occurred for the current profile: do not broadcast again or create a replacement. Run `node --import tsx scripts/phase7b-verify-completed.ts` for credential-free finalization/restart/replay verification. It installs a send veto and uses a poison signer for rejection probes; no signing key is loaded and no transaction is sent.

Setup reserves identity before generating credentials, refuses overwriting a profile and requires review after interruption. Each profile supports one immutable checkout. Expired quotes do not authorize automatic replacement. Multi-order production allocation is out of scope.

## Validation and limitations

Baseline Node: 248 passing. Final: **378 passing tests**: [258 Node](phase7b-evidence/node.txt), [24 UI](phase7b-evidence/ui.txt), [17 installed-extension](phase7b-evidence/extension.txt), [6 historical read-only UI](phase7b-evidence/historical-ui.txt), [3 real isolated-backend checks](phase7b-evidence/real-api.txt), [52 Solidity](phase7b-evidence/contracts.txt), [9 Rust wallet](phase7b-evidence/rust-wallet.txt), [5 watch](phase7b-evidence/rust-watch.txt), [4 signer](phase7b-evidence/rust-signer.txt). One pre-existing standalone expensive proof remains ignored; Node integration exercises isolated native proof/signing. Both typechecks, scoped lint and production build passed. [Preservation](phase7b-evidence/preservation.json): 537 original inventoried files, zero changes. No original evidence logs/screenshots were overwritten.

Ten new settlement tests use synthetic payments/RPC results and ephemeral Ed25519 signers. They cover network/address/amount/recipient binding, expiry, insufficient payment/inventory, missing owned notes, duplicates, simulation/RPC failure, exact signing, finalized effects, lost broadcasts, reorganization, restart and recovery exclusion. The real-backend browser run verifies devnet reads/unsigned simulation, checkout rendering and rejected spending routes; it does not authorize settlement.

After the approved live delivery, the separate [completion verifier](../scripts/phase7b-verify-completed.ts) passed against the reopened real journal and a fresh finalized RPC receipt. It verified one signing/broadcast claim, duplicate rejection before signer access, refund veto and current balances without loading credentials or sending a transaction. The added verification script passed the [backend typecheck](phase7b-evidence/live-typecheck.txt) and [scoped lint](phase7b-evidence/live-lint.txt). No runtime settlement implementation changed after the previously recorded full suite/build; the new script and documentation complete the live evidence.

The fresh payer was funded and both separately approved transactions completed. The requested original wallet still lacks its saved transaction ID, raw transaction, selected inputs and expiry. It remains quarantined; no original wallet was opened/modified and no marker was cleared. Source identity of the fresh shielded deposit is not inferred. There is no remaining blocker for this bounded demonstration. Independent RPC validation, production custody, browser signing and live refunds remain outside the verified result. See the transaction evidence and security reports.
