# Mainnet operator setup for the Contabo pilot

This is the remaining operator work for two controlled transfers: shielded ZEC to a Base native transfer and shielded ZEC to a Solana native transfer. Completing setup does not authorize either transaction.

## 1. Provider configuration

Provision two independently operated providers for each network. Separate hostnames sold by the same upstream do not count as independent unless the operational dependency is understood and explicitly accepted.

- Zcash: two authenticated mainnet lightwalletd endpoints. The current scanner requires HTTPS/TLS gRPC and exact transaction/height/block agreement. For launch, add an independently verified chain/inclusion source; provider agreement alone does not validate proof of work or a Merkle path.
- Base: two mainnet JSON-RPC providers. Verify chain ID 8453, finalized state, relayer nonce/balance, recipient code, gas estimate, canonical receipt, and active L1 fee formula.
- Solana: two mainnet JSON-RPC providers. Verify genesis `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`, finalized state, blockhash validity, fee, simulation, transaction message, and balance effects.
- Pricing: two signing authorities with pinned Ed25519 public keys, distinct operators, exact pair/network/context binding, timestamp/expiry, rational price, and bounded disagreement.

Put endpoints in `/etc/zecone/mainnet-profiles.json` and `/etc/zecone/mainnet-readonly.json` with mode 0600. Use placeholders until real subscriptions exist. Never commit or print URLs containing API keys.

## 2. Account roles

Generate fresh production identities offline. Testnet/dev keys are prohibited.

- One user-controlled Base recipient and one user-controlled Solana recipient.
- One dedicated Base relayer and one dedicated Solana relayer on the separate signing device.
- A separate Ed25519 execution-authority key on the operator approval device.
- A Zcash mainnet UFVK/watch profile on the VPS; its spending key remains offline.
- A separate backup age identity off the VPS.

Recipient and relayer must be different. Signer public keys must derive the configured relayer addresses. Record device identity and attestation references. The VPS receives only public keys and the UFVK.

## 3. Zcash watch profile

Choose the exact wallet birthday/checkpoint from authenticated wallet history. Import the UFVK through the existing `mainnet:watch import` flow into a new `/var/lib/zecone/zcash-watch` directory. Do not copy a development wallet database.

The production acceptance scan must demonstrate maintained-SDK sync, full-transaction UFVK trial decryption, exact receiver/value/output matching, at least 20 confirmations, two-provider transaction/block agreement, reorg handling, and payment uniqueness. Real execution remains blocked until independent chain inclusion/proof-of-work confidence is added or explicitly accepted through a reviewed architecture change.

## 4. Limits and funding

Keep profiles disabled while configuring. Start with the pilot caps already documented in `MAINNET-PILOT-PLAN.md`: at most 0.02 ZEC source spend per order and 0.04 ZEC daily, 0.0001 ETH Base destination debit, and 0.00101 SOL Solana destination debit. Recompute real quotes; never raise limits merely to fit a stale price.

Fund destination relayers only after their offline signer derivations and recovery backups pass. Verify gas/rent sufficiency through both providers. The payer funds a fresh shielded request only after the exact order and expiry are approved. Use distinct Zcash notes/orders for Base and Solana.

## 5. Read-only acceptance

On the VPS:

```bash
deploy/zecone-vps validate
deploy/zecone-vps start-readonly
deploy/zecone-vps health
deploy/zecone-vps logs
```

Then run the repository's non-spending configuration/readiness, quote-context, watch, prepare, and simulate commands described in `MAINNET-SETUP-GUIDE.md` and `MAINNET-OPERATOR.md`. Require two-provider agreement. Preserve sanitized evidence without provider credentials or Zcash-to-destination correlation.

The acceptable state before funding is:

- Health reports read-only, paused, no signing/broadcast/refunds, and sufficient disk.
- Configuration has no FAIL findings and every required live dependency is PASS.
- The single-writer lease cannot be acquired concurrently and survives restart.
- Backup is encrypted off-host and its disposable restore passes.
- The signer and execution authority are on separate devices and revocation is tested.
- Exact unsigned Base and Solana transactions simulate with both providers.
- Emergency pause is tested before any transaction approval.

## 6. PC-to-VPS exchange

Use the private SSH path to download an unsigned preparation and its digest. The operator device validates economic terms and produces the exact execution authorization. Transfer the unsigned bytes to the separate offline signer, which independently validates network, recipient, amount, fee cap, nonce/blockhash, terms digest, and prepared digest. Return only the signed bundle.

Upload the signed bundle over SSH, verify its hash, and run the operator simulation. There is no web callback and no publicly reachable signer. If any quote, authorization, nonce, or blockhash expires, discard the bytes and repeat preparation. Never transfer approval to changed bytes.

## 7. Controlled execution gate

Each live transfer needs a separate explicit approval package containing the exact destination, source maximum, destination maximum debit, relayer funding, signer/authority identities, signed transaction digest/ID, expiry, verification plan, uncertain-broadcast recovery, and emergency-stop procedure.

Only after that approval may the operator acquire/arm the durable lease and invoke the exact execute command. After submission, wait for canonical finality from both providers, verify recipient gain and relayer debit, restart/reconcile, and prove duplicate execution is rejected. If outcome is uncertain, pause and reconcile the original identity; do not create a replacement or refund.

## Blockers at this checkpoint

- No Contabo hostname, SSH key/configuration, or authorized source IP was provided, so the VPS was not inspected.
- No independent production RPC/lightwalletd subscriptions or genuine signed price authorities are configured.
- No production recipient, relayer, signer, execution-authority, UFVK, or backup identity has been provisioned.
- No relayer is funded and no authenticated mainnet owned-note acceptance run exists.
- The Zcash chain-inclusion/proof-of-work verification gap remains a financial-safety blocker.
- The local Docker Linux daemon was unavailable, so only Compose schema validation and the local disposable service test ran; image build/start still needs a Docker-enabled host.
- The actual Contabo single-writer filesystem, backup destination, firewall, monitoring, and conflicts remain unverified.

Keep mainnet execution disabled until every blocker is resolved and both live transactions receive separate capped approval.
