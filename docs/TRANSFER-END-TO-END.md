# Transfer integration

Starting checkpoint `7edd423`, 20 October 2026. Scope: non-spending integration and disposable execution fixtures. No new live payment, credential unlock, signature, submission or refund activation.

## Operational path

The opt-in keyless wallet now supports a native EVM checkout in Send / Receive. It reuses `EvmTransferSettlement`, `EvmTransferExecutor`, `Store` and `executeOne`; it does not add an execution engine.

1. The configured account selects an allowlisted EOA recipient and bounded native amount on a supported testnet. ERC20/SPL imports cannot enter this path.
2. The adapter checks chain/head, recipient code, `eth_call`, gas, fees, pending nonce and relayer balance. A pending relayer transaction blocks readiness. The original configured maximum fee is shown separately from the fresh estimate and retained in the signed order.
3. A separate exact authorization message includes the review/order digest, chain, recipient, relayer, amount, maximum fee, Zcash testnet payment amount, deadlines and optional source origin. Its digest also binds a hash of the exact receiving account/address. Only a valid signature from the configured, distinct user EOA can create the financial order. The saved signature and complete request binding are checked again before execution/reconciliation. Local pairing/preview consent alone cannot authorize spending. No signing key is held by the new UI/server.
4. The original Store records the order. A desktop source-binding index prevents the same account/address from being recycled into another new wallet directory/order. Known historical financial accounts are excluded. The index stores hashed account/address/owner identifiers, not spending/viewing keys. It is a replay index, not a second payment ledger. Never delete it to retry an order.
5. Payment request reveal is an explicit scoped action. The fixed demonstration payment is 100000 zatoshis (0.001 TAZ); the payer's actual Zcash sending fee is additional. No sender is installed in this runtime.
6. Financial wallet startup requires a matching native watch directory and a checksum-valid shielded testnet receiver; its non-spending observer polls every 30 seconds without overlapping scans. `wallet:observe` can also invoke the native UFVK scanner manually. Snapshot-file imports are disabled. The manual entry point checks the watch manifest against exactly one authorized order before opening writable state or scanning. EVM owned Ironwood notes must match the account/address, amount, note identifier and mined height. The Store retains unique payment attribution and a ten-confirmation threshold.
7. Native evidence gets a separate digest/validity marker. A generic Store JSON observation cannot authorize execution. Failed scans invalidate readiness. Concurrent scans and signing claims are mutually exclusive. Underpayment stays non-executable; excess/duplicate value, paid expiry and reorgs require recovery. No source transaction identifiers or viewing keys enter destination RPC requests.
8. An explicitly approved operator invocation can inject a local testnet signer into the existing executor. The adapter rechecks liquidity, code, fees and simulation. Signer-returned bytes are decoded and checked for chain, sender, recipient, amount, calldata, nonce, gas and fees. JSON-RPC `eth_signTransaction` fallback has been removed: signing requires an explicitly supplied local signing function.
9. The existing worker persists raw signed bytes/hash before the guarded single broadcast. The scoped operator decision is audited atomically with the execution claim. Durable execution/submission claims prevent another attempt. Unknown submission outcomes reconcile the original hash; they never automatically construct or submit a replacement.
10. Canonical destination receipt/depth and exact transfer fields are verified by the existing adapter. Restart reconciliation needs only a public relayer account, not its key, and still works after the order's application deadline. Completed orders reject another execution before signer access.

## Wallet states

- PAYMENT_PENDING: no detected payment.
- PAYMENT_DETECTED: mined payment observed but insufficient confirmed/owned value, or native verification needs refreshing. It is never settlement.
- PAYMENT_CONFIRMED: valid native evidence and the configured confirmation threshold satisfy the order; operator execution approval is still required.
- EXECUTING: signed evidence/hash exists; poll/reconcile that attempt only.
- COMPLETED: canonical successful receipt and exact delivery fields verified.
- FAILED: expired unpaid order or confirmed reverted execution.
- RECOVERY_REQUIRED: ambiguous/interrupted signing/submission, conflicting payment evidence, excess payment, paid expiry or reorg. Live refunds stay disabled.

The native API is authenticated, CSRF-protected and rejects body/query identifiers outside its schema. It exposes review, signed order authorization, status and explicit payment reveal. It exposes **no** signer unlock, destination execution, broadcast or refund endpoint. Existing legacy wallet startup is unchanged.

## dApp handoff

A configured, permitted EVM origin can submit an empty-calldata native request to the existing intent system. After exact preview consent, the standard EIP-1193 request remains rejected/non-executed. The user separately opens a ZEC-funded checkout using its persisted request ID. The handoff rereads session/origin/channel/network/account/consent, canonicalizes the original parameters, checks origin/recipient allowlists and obtains a fresh relayer quote. Those source bindings enter the signed order digest. Revocation or changes before financial creation reject the handoff.

This is verified with a synthetic dApp and real local handlers. It is not authenticated transaction-level compatibility with OpenSea, Uniswap or arbitrary third-party sites. Contract calls, token transfers and generic Solana signing do not acquire a relayer fallback.

## Reproducible operator setup

Use a **fresh isolated** Zcash testnet watch account, not the quarantined original wallet, a completed settlement receiver or a historical credential migration. The native scanner supports:

```powershell
target/debug/zecone-zcash-watch.exe --wallet <new-watch-dir> import --ufvk-file <private-local-ufvk-file> --birthday <height>
```

Import a locally provisioned testnet UFVK privately. Do not paste it into chat or place it in the public profile. Record only the resulting watch manifest's `keyId` and receiving address in the profile. No new watch account or funding request was generated in this implementation run.

The public wallet profile retains `displayEvmAddress`, `recipients` and `profile` (`profileId` UUIDv4, `requestId`, `relayer`, `account`, `paymentAddress`). Add `native` with `chainId` (11155111 or 84532), `authorizer` equal to the displayed user EOA, `feeCapWei` within network policy, and an optional explicit HTTPS `origins` allowlist. No keys/seeds or asset allowlists belong in it. Use a dedicated testnet relayer; do not run competing signing processes with its key.

```powershell
npm run wallet:review-ui -- <public-profile.json> --state <fresh-state-dir>
# After a separately reviewed capped plan permits financial order creation:
npm run wallet:review-ui -- <public-profile.json> --state <fresh-state-dir> --enable-financial-creation --watch-wallet <new-watch-dir>
# After the separately authorized payment, observe using the exact scoped order:
npm run wallet:observe -- <fresh-state-dir> --watch-wallet <new-watch-dir> --order <order-id>
# Read status, or reconcile an existing destination hash without any key:
npm run wallet:transfer-status -- <fresh-state-dir>
npm run wallet:transfer-status -- <fresh-state-dir> --reconcile
```

Pair locally using the runtime's new private pairing file. It proves local session consent, not wallet ownership. The financial authorization requires the separate user signature. Existing cookies/session scope can resume a created native checkout after restart; session loss does not silently reassign it to another user. Operator recovery is required then.

`NativeTransferFlow.execute` is the integration point for a separately approved operator signer/executor. No live key path, signing launcher or automatic worker was enabled. Provisioning a signer and approving a capped payment/execution plan are the live-execution boundary; do not bypass it with a web endpoint.

## Fresh read-only testnet evidence

`end-to-end-evidence/live-readiness.json`: Base Sepolia and Ethereum Sepolia simulations target 1000000000000 wei (0.000001 test ETH) delivery to the configured public user address. The report records actual current gas/fee estimates, balance sufficiency, pending transactions and whether legacy reservations remain. Estimates are time-specific observations, not fees paid or promises for a later transaction. PRIMARY_ONLY on each chain; different chains are not independent corroboration. Existing legacy reservations conservatively block financial activation until operator reconciliation.

Historical SOL delivery and the pinned devnet swap remain completed and were reconciled using safe copies and fresh finalized receipts. No fresh Solana wallet transfer, native Zcash payment observation or EVM transfer was executed live in this run.

## Exact remaining live-test requirements and limits

- Select/provision fresh isolated payer/watch credentials and public checkout profile; privately verify the intended recipient/key owner and fund only testnets.
- Select a dedicated prefunded relayer and separately approve its local signer/key access, payment amount plus actual Zcash fee, destination amount, network and fee ceiling. No existing payment authorization is reused.
- Run native scanning on that fresh receiver, approve one bounded destination execution, finalize and verify its real effects. The disposable tests do not satisfy this live proof.
- Source verification is the existing native light-client scan through one provider; independent full-node corroboration is not claimed. Destination evidence is PRIMARY_ONLY unless independently configured/verified providers satisfy existing receipt policy.
- The operational wallet currently uses one isolated checkout per state directory, with a shared desktop source replay index. This is not a distributed reservation service. Keep the relayer dedicated and the replay index durable; external competing signers/replicas are outside this configuration's guarantees.
- A native EVM transaction has an **application** deadline, not an on-chain expiry. Signed bytes remain sensitive/reconcilable after it. OP Stack L1/data fees use the existing reserve estimate; it is not a chain-enforced absolute bound on future data fees. Prefer Ethereum Sepolia for the first strictly gas-capped L1 transfer proof; Base requires explicit acceptance/review of the existing data-fee reserve assumption.
- An interrupted watch claim without orderly cleanup requires operator inspection of the scanner/process and journal; it is never silently stolen. Signed/uncertain attempts cannot be reopened or retried automatically.
- Fixed demo pricing, trusted prefunded inventory, local same-user filesystem access, legacy plaintext credentials left untouched and separate-device refund validation remain limitations. Mainnet payment/execution, production pricing, isolated production custody, generalized multi-order wallet allocation and automatic recovery remain **NO-GO**. See MAINNET-READINESS.md.

Validation logs and sanitized preservation/reconciliation reports are under `end-to-end-evidence/`. No public payment-to-recipient joins were added.

All **572 tests pass**: 434 Node, 35 wallet UI, 20 installed-extension, 6 historical UI, 3 isolated API/UI, 3 completed-swap API/UI, 52 Solidity, 10 Rust wallet, 5 watch and 4 signer. Both typechecks, lint and wallet/extension builds pass. All 628 protected files and both completed records are unchanged; duplicate/refund vetoes and fresh historical receipt matching pass on safe copies. A mounted real server/browser obtained a live Base quote using a synthetic public profile with financial creation off, verified cross-site API rejection, and created no financial order, payment or signature. That read-only scenario is additional evidence, not a new paid transfer or an extra unit test counted above.

## Validation reproduction

The existing native proof finalizer hit its unchanged 180-second limit in two unoptimized runs on this host. Both failure logs are retained. Rebuilding its cache from unchanged locked sources with optimization reduced that proof test to about eight seconds; no signing rules, timers or assertions were relaxed. The binary is rebuildable output and is not one of the 628 protected files.

```powershell
cargo build --offline --locked --manifest-path services/refund-signer-native/Cargo.toml --target-dir target --config 'profile.dev.opt-level=2' -j 2 --bin zecone-refund-signer
node --import tsx --test --test-concurrency=1 tests/*.test.ts
npm run typecheck
npm run typecheck:web
npm run lint
npm run wallet:build
npm run extension:build
node scripts/phase8-preserve.mjs --end-to-end
```

The original Rust proof test that is explicitly ignored remains ignored; the full Node suite exercises the isolated native proof/finalization path. Browser suites use disposable APIs/sites or copied completed journals. No successful fixture is presented as a real payment or transfer.
