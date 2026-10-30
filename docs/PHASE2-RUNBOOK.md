# Phase 2 local testnet runbook

This adds an external-dApp connector and one fixed ZEC-funded Base action to the existing Phase 1 application. It remains a single-user Windows local prototype. Use only Zcash Testnet and Base Sepolia. Do not recreate keys, restore an older wallet DB, remove uncertainty markers, or expose local port 3210.

## Start the wallet and the separate dApp

1. Confirm the existing local wallet has already been paired and ownership-verified. Start the production gateway with `npm.cmd run wallet:start` (or use `Launch-ZecOne.cmd`). It binds only `127.0.0.1:3210`.
2. In a second terminal, run `npm.cmd run dapp:fixture`. The compatibility fixture runs at `http://127.0.0.1:4321`, a separate origin/port. It uses a local copy of the public provider SDK and no wallet secrets.
3. Select **Discover and connect**. Verify the approval popup shows exactly `http://127.0.0.1:4321`. Approve account sharing only if that origin is correct. The dApp can then read the public EVM address and Base Sepolia chain ID.
4. Use the signature buttons to review a message and an EIP-712 typed value. The test transaction is a zero-value self-transfer on Base Sepolia; it still consumes real user test ETH. Inspect destination, value, gas, fee caps, method, and the simulation warning before approval.
5. Revoke the fixture origin in the wallet **Apps** page. The fixture's subsequent transaction request must fail with unauthorized error 4100. Closing the popup only closes transport; it does not delete the stored origin grant.

Compatible external dApps must include the SDK source (or a future published package) and permit the popup's opener communication. The fixture does not establish compatibility with all public websites or extension-only dApps. An integrating site's COOP may sever the opener. WalletConnect is not available.

## Fixed action contract and ZEC sponsorship

Compile and run local contract tests before any deployment:

```powershell
forge build
forge test
npm.cmd run typecheck
npm.cmd run typecheck:web
npm.cmd test
```

`npm.cmd run phase2:deploy-action` has an explicit testnet-broadcast flag and uses only the configured Base Sepolia relayer. It persists signed deployment bytes before broadcast and reuses the same transaction on retry. Check `.state/actions-confirmed.json` and the public Base Sepolia receipt before proceeding. Never copy values from `.secrets` into commands or logs.

In the wallet, open **Sponsor**, create the fixed action quote, and inspect the displayed EIP-712 intent: chain 84532, your EOA, configured action contract, exact `recordFor` calldata, zero value, 0.005 ETH maximum execution gas budget, fixed 0.01 TAZ price, and expiry. Approve the terms to produce a user signature. Then request the native fee quote, review payment plus fee, and explicitly approve the shielded Zcash send. The existing native service proves locally and the settlement watcher waits for ten Zcash confirmations before the prefunded relayer executes. Do not treat pending/unconfirmed payments as settled.

The action is a record event only. It does not mint an NFT or convert ZEC into ETH. Base L1 data fees may be additional to the contract's execution gas budget. The operator sees the payment-to-action association. Failed, expired, or uncertain actions stay in recovery for manual review; no automatic refund is claimed.

The authorized live Phase 2 run has completed; do not repeat its payment or test transaction. Read the sanitized current state with `npm.cmd run phase2:sponsor-status`, then independently reconcile the preserved receipts, scanner record, event, replay bit, recipient record and broadcast count with `npm.cmd run phase2:verify-live`. The verifier is read-only and writes only the public evidence file `docs/phase2-evidence/sponsor-final.json`.

## Evidence and recovery

The live EOA dApp proof uses a one-run marker `.state/phase2-dapp-live-started.json`; its transaction reference is written to `docs/phase2-evidence/live-dapp.json`. It refuses to run twice. Inspect request/receipt state before attempting any recovery. The action journal and contract replay map are authoritative for the sponsored action. Keep `docs/phase1-evidence/` and `docs/evidence/` intact.

Never remove `.state` markers to force retries. For an unknown Base broadcast, reconcile the recorded hash and signed bytes before action. For a Zcash output, use the existing Phase 0/1 recovery rules and fully scanned canonical chain. A refund requires a separately reviewed shielded destination and transaction; no refund may race an unresolved Base execution.

See [feasibility](PHASE2-FEASIBILITY.md), [security](PHASE2-SECURITY.md), [limitations](PHASE2-LIMITATIONS.md), [Phase 1 runbook](PHASE1-RUNBOOK.md), and final [results](PHASE2-RESULTS.md).
