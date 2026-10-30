# Phase 4A testnet runbook

This runbook applies only to Base Sepolia (84532), Ethereum Sepolia (11155111) and Robinhood Chain Testnet (46630). Never substitute mainnet RPCs or chain IDs. Keep `.secrets/` and `.state/` local and gitignored. Do not regenerate/migrate the user key, and never delete a payment, signed transaction or recovery journal to force a retry.

## Read-only checks

```powershell
npm.cmd ci
npm.cmd run phase4a:preflight
npm.cmd run typecheck
npm.cmd run typecheck:web
npm.cmd test
forge test
cargo test --locked --offline
```

The preflight records the configured network IDs, current canonical block, gas price, existing user/provider/seller balances and local Zcash Testnet scanned balance. It does not sign or broadcast. Check its result in `docs/phase4a-evidence/network-preflight.json` before proceeding. Keep the existing Phase 3 Base deployment/evidence intact.

## Fund separate destination liquidity

The settlement provider is `0xf9dE6070331A3B68233c3b2062BceB7105162Cd2`. Balances on the two networks are independent; Sepolia ETH cannot pay Robinhood gas. Run `node --import tsx scripts/phase4a-costs.ts` to estimate deployment gas and reserve seller funding plus one purchase before setup. The previous 0.05 ETH recommendation was an arbitrary operating buffer, not a minimum. Live RPC estimates on 2026-10-13 showed 0.2 Sepolia ETH and 0.01 Robinhood ETH were sufficient. The setup helper now checks each exact gas estimate against the current balance and retains a purchase reserve. The existing seller is `0x7D26bC3A7CE602cB1cf9F8Bb4e3a8eDCb052C4b0`; setup sends it 0.001 test ETH from the same network's provider. The recipient is the user's existing EOA `0x1865Dd77bFcb632571d3c93144D5634F0D93c714` and needs no ETH for a sponsored purchase.

Ethereum.org's [Sepolia network page](https://ethereum.org/developers/docs/networks/#sepolia) lists faucet choices. Alchemy currently offers 0.1 ETH per 24h but may require prior mainnet activity. Robinhood confirms its testnet faucet at [official support](https://robinhood.com/us/en/support/articles/robinhood-chain-testnet/) and links `https://faucet.testnet.chain.robinhood.com`. Faucet eligibility and delivery are controlled by those providers. Re-run preflight and verify the balances before setup; do not claim funds merely because a faucet accepted a request.

## Deploy a marketplace to one destination

Stop the local wallet and marketplace workers first. Check that no purchase reservation is active and save a private backup of `.state/` with SQLite WAL consistency. Do not include secrets in logs or source control. Ensure the existing seller key file exists at `.secrets/marketplace-seller/base-sepolia.json`; the setup intentionally reuses this local key and does not generate or migrate keys. It never reads the user EOA key.

```powershell
forge build
npm.cmd run phase4a:setup -- 11155111 --allow-testnet-broadcast
npm.cmd run phase4a:preflight
```

For Robinhood, use `46630` instead. The setup helper refuses Base, unknown chains, missing broadcast opt-in, active reservations, insufficient balance for the estimated transaction plus purchase reserve, wrong RPC chain ID, high fees, noncanonical/underconfirmed receipts and ambiguous prior submissions. It stores exact raw transactions and hashes under `.state/phase4a-setup/<chainId>/` before broadcast. On a retry, reconcile that exact hash; never delete the journal or deploy a replacement blindly.

After all receipts reach the configured depth and are rechecked against canonical block hashes, the verified deployment manifest is written to the chain's gitignored `.state/marketplace-<chainId>-confirmed.json`. Review each returned contract address and transaction hash on the configured testnet explorer. Confirm the executor immutables, marketplace listing, seller ownership/approval and provider balances before exposing the purchase route. The public RPC is rate-limited and is for this prototype only.

## Purchase verification

Start the wallet and independent marketplace using the existing Phase 3 runbook commands. Connect the dApp to ZecOne, approve the exact origin, select the destination testnet through the explicit `wallet_switchEthereumChain` confirmation, and choose the ordinary marketplace purchase. Confirm the reviewed chain, contract, listing, price, recipient, quote expiry, fixed simulated rate, ZEC amount and gas reserve. The ZEC path requires ten confirmations before the provider prepares the destination transaction. The dApp receives only public EVM data and limited purchase status.

For each network separately, use a fresh listing and order. Verify the source Zcash output from the local wallet scan and at least ten confirmations. On the destination explorer verify one successful settlement transaction, the exact seller payment, marketplace/executor events, canonical block and `ownerOf(tokenId)` equal to the user's EOA. Record the balances before/after, actual fee, Zcash txid, destination tx hash and confirmation count in `PHASE4A-RESULTS.md`. Restart both services and verify the same order/hashes reconcile, the NFT owner is unchanged, and the same order cannot settle again. Do not reuse a completed order.

## Live demonstration and evidence helpers

After both setups complete, start the wallet and marketplace as above. The following helpers drive actual browser approvals and use the existing local user signer. Each chain's live helper deliberately refuses a second attempt once its durable marker exists. Inspect that marker and its original purchase if interrupted; never delete it or create a replacement order.

```powershell
node --import tsx scripts/pair-phase4a-browser.ts
node --import tsx scripts/live-phase4a-purchase.ts 46630 --allow-testnet-spend
node --import tsx scripts/live-phase4a-purchase.ts 11155111 --allow-testnet-spend
node --import tsx scripts/phase4a-status.ts
node --import tsx scripts/verify-phase4a-setup.ts 46630
node --import tsx scripts/verify-phase4a-setup.ts 11155111
node --import tsx scripts/verify-phase4a-live.ts 46630
node --import tsx scripts/verify-phase4a-live.ts 11155111
```

The browser helper estimates the exact signed executor call before authorizing ZEC. It approves listing 1 only: 0.015 TAZ on Robinhood and 0.03 TAZ on Sepolia, plus the separately displayed native Zcash fee. The verifier requires mined shielded payment observations, ten confirmations before authorization, canonical destination receipts, seller balance increase, user ownership, a single broadcast, and a simulated replay rejection. Its `before-restart` and `after-restart` modes check that restarting the wallet and repeated scans preserve the same transaction, provider nonce/balance, and user-owned NFT. `capture-phase4a.ts <chainId> completed` captures the actual completed wallet state. Read-only verification never substitutes for a live transaction.

## Recovery

- **Provider liquidity too low:** keep the confirmed payment/order in recovery, record the chain and missing amount, and top up only that chain. Recheck the saved quote and chain state before resuming; never swap or bridge funds automatically.
- **RPC outage or chain mismatch:** pause signing/submission. Preserve the exact signed transaction and query hash. A chain ID response is not proof of chain honesty; compare independent explorer/provider data before continuing.
- **Revert or failed receipt:** retain the ZEC liability and exact transaction. Do not create a new order or automatically retry. Record the reason and destination, then perform any refund only as an explicitly reviewed separate shielded payment; no automatic refund is implemented.
- **Timeout/unknown broadcast:** inspect the exact saved transaction hash and nonce. Reconcile receipt and canonical block. Never sign a replacement for an uncertain broadcast.
- **Reorg after apparent completion:** keep the recovery state, check the receipt and current owner again, and record both L2 and parent-chain status where applicable. Robinhood's 20 L2 confirmations are not parent-chain finality.
- **Interrupted Zcash send:** use the existing request ID and native reconciliation route. Never re-run a fresh send to satisfy the same order.

An order with a confirmed ZEC payment and failed destination execution remains an auditable manual recovery liability. A recovery record is not proof of refund. Preserve SQLite database, WAL, payment request journal, signed approvals and transaction hashes for investigation.
