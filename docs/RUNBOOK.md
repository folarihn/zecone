# Reproducible Phase 0 runbook

## Current checkpoint

The user explicitly resumed the funded Phase 0 live test on 2026-10-12. Local wallets exist in this checkout. The steps below describe one run; inspect persisted state before repeating them to avoid creating a second order. All commands operate in the repository root. PowerShell examples use `npm.cmd` to avoid npm.ps1 execution-policy differences.

## Build and inspect without spending

Follow README install/verification commands. Read-only Zcash operations:

```powershell
.\target\debug\zecone-zcash.exe --wallet .secrets/user/zcash addresses
.\target\debug\zecone-zcash.exe --wallet .secrets/user/zcash observe
.\target\debug\zecone-zcash.exe --wallet .secrets/merchant/zcash observe
npm.cmd run cli -- status
```

`observe` always synchronizes first. It reports `network`, `tip`, `scanned`, `observedAt` and shielded outputs, with integer amounts serialized as strings. Empty payments mean no receipts, not a simulated success. No payment-ingestion HTTP endpoint or JSON-file override exists in the runtime CLI. By default Rust uses TLS lightwalletd at `https://testnet.zec.rocks:443` and rejects a non-test chain. `--server` can select a different TLS testnet lightwalletd; infrastructure changes need independent verification.

The Rust wallet uses a local seed, not a remote signing service. It trial-decrypts compact blocks and constructs/proves transactions locally. Receiving observation keys are `txid:pool:index`, where pool 2 is Sapling, pool 3 is Orchard and pool 4 is Ironwood. Database schema reads are tested against the pinned SQLite crate. Incoming notes remain detectable after being spent because the query does not filter to unspent balances. Change is excluded. One dedicated account maps to one payment order, so no memo interpretation is needed. Current NU7 Testnet requires the pinned prerelease library family and a server/library consensus-branch match; a successful empty scan alone is insufficient compatibility evidence.

## After funding and explicit resumption

1. Deploy the contract using the **relayer** key. Default RPC is `https://sepolia.base.org`; optionally set `$env:BASE_SEPOLIA_RPC` to a trusted provider's Base Sepolia HTTPS endpoint. An API key is optional for public RPC and must stay in the environment if needed.

```powershell
forge build
npm.cmd run cli -- deploy --allow-testnet-broadcast
```

Deployment raw bytes/hash are saved before broadcast in `.state/deployment-pending.json`. A successful confirmed result writes `.state/deployment-confirmed.json`. Retry the same command after a timeout; it reuses the same signed deployment. Do not delete pending state or use the relayer outside this service while a nonce is unresolved.

2. Run the **user-side** signing utility locally. It loads only the user's key, binds the actual deployed contract and Base Sepolia domain, chooses a random nonce and 24-hour expiry, and signs the fixed 0.01 test ZEC mint price. This creates a local proof of control; the backend never needs the user's key.

```powershell
npm.cmd run user -- .state/intent.json
npm.cmd run cli -- create .state/intent.json
```

Creation returns an order ID and a unique shielded payment address. Repeating the same intent returns the existing order. The fixed mint token ID is the signed EIP-712 digest interpreted as a uint256. This Phase 0 supports an EOA recipient; EIP-1271 smart-account signature validation is not implemented.

3. Use the **payer** Zcash account from PUBLIC_WALLETS.json to send 1,000,000 zatoshis to the **new order address**, not the merchant's generic funding address. Keep the same request UUID on a retry. Replace the two angle-bracket placeholders with public values from steps above.

```powershell
$paymentRequestId = [guid]::NewGuid().ToString()
.\target\debug\zecone-zcash.exe --wallet .secrets/user/zcash send --request-id $paymentRequestId --account '<payer-account-uuid>' --address '<order-shielded-address>' --zatoshis 1000000 --allow-testnet-broadcast
```

Sender must first have spendable shielded funds; default library policy needs 10 confirmations on untrusted incoming notes. ZIP-317 fees are in addition to the 0.01 test ZEC payment. The send command rejects transparent recipients and foreign-network addresses. It records construction before broadcast. A repeated request ID never constructs a second payment: it returns the previous txid for reconciliation. A crash during construction leaves a started marker and requires manual wallet-history inspection. Never invent a new request ID to bypass an uncertain send. Save the returned actual txid.

For an existing constructed request, `reconcile-send --request-id <uuid>` checks the exact saved transaction against the server and updates its status using the native wallet API after a fresh sync. `expired-unmined` requires a nonzero expiry height below the scanned tip and a second server NotFound result after sync. Other lookup errors fail closed. Adding `--allow-testnet-broadcast` permits rebroadcasting the exact persisted transaction only when it is not found; it never constructs a replacement. The server's acceptance/rejection is not a confirmation. A replacement after verified expiry must retain the original request/txid and document its relationship to the same order.

4. Verify fresh confirmed payment, then execute the fixed mint. The service requires 10 Zcash confirmations and a fully scanned wallet; confirmation counting is `tip - mined_height + 1`. Run `scan` until verified, then `tick`. To progress a pending Base receipt, run `tick` again. Do not run a background automation without asking the user to resume this test.

```powershell
npm.cmd run cli -- scan
npm.cmd run cli -- tick --allow-testnet-broadcast
npm.cmd run cli -- status
```

Base transactions require 3 canonical-block confirmations and an exact `OrderMinted` event, on-chain consumed flag, and matching NFT owner before settled. `tick` processes one order at a time. A pending or uncertain transaction blocks later nonces. It persists signed bytes before broadcast and reuses them on retries. There is no fee-bump/cancellation implementation; long-lived pending transactions require review.

The expiry rule is conservative: sufficient confirmations must be observed before wall-clock expiry. A payment mined before expiry but discovered too late enters recovery. Contract expiry is also checked against Base block time; keep system time accurate.

## Recovery

`status` includes an append-only sequence of audit events and recovery cases with `review_required` status. It deliberately omits raw signed transaction bytes. Underpayments remain awaiting payment; at expiry any received amount creates a recovery case. Extra funds create an excess-payment case even if one mint completes. Late payments never reopen expired orders. Reorgs remove unbroadcast authorization; post-authorization reorgs create recovery cases, and potentially mined Base transactions are reconciled before further action.

Confirmed Base reverts set `failed`; retry is explicit and checks a fresh sufficient payment:

```powershell
npm.cmd run cli -- retry '<order-id>'
npm.cmd run cli -- tick --allow-testnet-broadcast
```

This only prepares eligibility; pending, expired and unknown-outcome transactions cannot use this path. The prior hash remains in the audit history. `prepare` also checks on-chain replay protection before constructing another transaction.

Refund execution is **manual and not implemented as an automatic state transition**. Record the case, reconcile original Zcash notes and every Base transaction, obtain a payer-approved shielded refund address (a shielded sender address cannot be recovered from the payment), and prevent any further mint attempt before refunding. Retain confirmed refund txid, amount, destination, reviewer and reason in the case evidence. Never mark refunded from a broadcast acknowledgement. This slice provides the auditable recovery queue; reviewed refund signing/confirmation workflow is future work.

## Locks, backup and errors

On Windows the Rust entry point and Tokio workers use explicit 64 MiB stacks. The first funded debug-build construction exceeded the default process stack; see [the inspected recovery record](evidence/live-recovery.md). Do not clear a started marker merely because a process exited: inspect the native wallet's outgoing history and pre-broadcast persistence first.

`.state/service.lock` and each Zcash wallet's `process.lock` refuse concurrent processes. After a crash, first confirm the recorded PID is no longer alive and that no transaction's outcome is unresolved; then remove only that exact stale lock. No automatic lock stealing. Do not edit the Zcash wallet database. Back up seed, wallet DB, account metadata, birthdays and application DB together. Native seed-only restoration is not exposed by this prototype; use a reviewed import/recovery tool before attempting it.

CLI errors are redacted to avoid leaking credential URLs or signed raw bytes from provider error objects. Use `status`, the persisted hashes, read-only `observe`, chain explorers and local audit data to diagnose. A generic error is never a success signal. Public RPC outages preserve pending state. Node 24 marks its built-in SQLite API experimental; the exact Node version is recorded and should be retained for reproduction.

## Evidence required for completion

Save the actual Zcash txid, note pool/index, amount, mined height, block hash, observed tip and confirmation count; signed order ID and recipient; deployed contract/address/hash; Base mint tx hash, canonical receipt block and event; and ownerOf result. Base explorer links are `https://sepolia.basescan.org/tx/<actual-hash>`. Shielded amounts/recipient cannot be established by a public explorer alone; use local scan evidence without exporting viewing/spending keys. Never substitute fixture txids from tests.

After the order is settled, `node --import tsx scripts/live-evidence.ts` independently rereads the Base receipt, canonical block, exact event, consumed flag and NFT owner, and combines these with the persisted Zcash confirmation audit. It writes `docs/evidence/live-test.json`, excluding private keys and raw signed transaction bytes. Run `tick` again after settlement to check that reconciliation does not prepare or send a second mint; compare the relayer nonce and broadcast audit count before and after.
