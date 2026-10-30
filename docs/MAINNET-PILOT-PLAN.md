# Mainnet controlled pilot plan

**Status: BLOCKED. No live transfer is authorized by this document.** The pilot
is a two-transfer, operator-supervised acceptance run on Base and Solana using
shielded ZEC as the source asset. It is not a public service, not a bridge and
not evidence of production readiness. Zcash remains **NO-GO** without an
independent Merkle-inclusion/proof-of-work boundary.

## Scope

Perform, in order:

1. One Base mainnet native-ETH transfer to an operator-controlled recipient.
2. One Solana mainnet native-SOL transfer to an operator-controlled recipient.

Each transfer must use a distinct, confirmed shielded-ZEC source payment. Do not
reuse a source payment, order, signed bundle, nonce or transaction identity.
Do not replace a signed, submitted or uncertain attempt with a new transfer.

The pilot is deliberately smaller than a public launch:

- One local single-writer operator process.
- Two independent RPC providers per destination network.
- Two independent Zcash lightwalletd endpoints for observation only.
- Two independent signed price authorities.
- Two devices: an operator workstation and a separate offline signer device.
- Public/free infrastructure only, with hard financial caps.

## Fixed pilot caps

These are the maximum debits. They include advertised network/service fees where
the code says they do. The ZEC caps are source-spend limits, not dollar limits.

| Network | Per transfer | Daily | Fee cap | Notes |
| --- | ---: | ---: | ---: | --- |
| Zcash source | 0.02 ZEC (`2000000` zats) | 0.04 ZEC (`4000000` zats) | 0.0001 ZEC (`10000` zats) | Two distinct source notes |
| Base | 0.0001 ETH (`100000000000000` wei) | 0.0001 ETH | 0.00001 ETH (`10000000000000` wei) | Amount plus fees must fit the cap |
| Solana | 0.00101 SOL (`1010000` lamports) | 0.00101 SOL | 0.00001 SOL (`10000` lamports) | Amount plus fee must fit the cap |

Suggested transfer amounts:

- Base: `90000000000000` wei (0.00009 ETH); reserve up to `10000000000000`
  wei for gas and L1 data fees.
- Solana: `1000000` lamports (0.001 SOL); reserve `5000` lamports for the
  signature fee.

At illustrative prices of ETH/USD 3,000, SOL/USD 150 and ZEC/USD 30, the two
destination amounts cost about 0.009 ZEC and 0.005 ZEC respectively. The
0.02 ZEC per-transfer cap provides roughly 2x headroom. These prices are not
inputs to the protocol. Recompute at signing; if the quote exceeds a cap, stop
or reduce the transfer. Never raise a cap to make a stale quote fit.

## Infrastructure choice

All prices and limits were checked on 21-22 October 2026 and must be rechecked
before creating accounts. Free tiers are acceptable for the pilot only.

| Need | Pilot choice | Why | Recurring cost |
| --- | --- | --- | ---: |
| Base RPC | Alchemy Free + Infura Free | Separate companies; durable free tiers; Base mainnet supported | $0 |
| Solana RPC | Helius Free + Alchemy Free | Separate companies; Solana mainnet supported | $0 |
| Zcash observation | `https://zec.rocks:443` + `https://us.zec.stardust.rest:443` | Two independent public operators; no account | $0 |
| Price data | Chainlink Base feeds + Kraken or Coinbase public API | Different upstream operators; no paid oracle plan | $0 |
| Operator host | Existing Windows workstation | Local single writer; no public listener required | $0 |
| Signer | Existing second device or offline machine | Keystore and passphrase stay off the operator host | $0 |
| Network assets | About 0.04 ZEC, 0.0002 ETH, 0.003 SOL | Two transfers plus fees and small buffers | Under $5 |

Provider facts used for this choice:

- Alchemy Free: 30 million compute units/month, 15 RPS. Pay-as-you-go is about
  `$0.525` per million compute units.
- Infura Free: 3 million credits/day, 500 credits/second. Developer is about
  `$50/month`; not required for the pilot.
- Chainstack Developer: `$0`, 3 million request units/month, 25 RPS, one node
  per project. Solana mainnet is limited to 5 RPS. Growth is `$49/month`.
- Helius Free: 1 million credits/month, 10 RPS, one `sendTransaction` per
  second. Developer is `$49/month`.
- QuickNode's free trial lasts one month and then deactivates. Do not build a
  pilot or launch on it.
- `zec.rocks` regional endpoints are one operator. They are not two independent
  providers and must not be counted as a pair.
- Stardust `eu.zec.stardust.rest` and `us.zec.stardust.rest` are separate
  endpoints of one operator. Use at most one of them in the pilot pair.
- Public Zcash endpoints are best-effort and have no SLA. This is acceptable
  only for the controlled pilot, with fail-closed behavior. It is not acceptable
  for a public launch.
- Pyth now requires an API key for Hermes and paid plans for ongoing use. The
  pilot does not need Pyth. Chainlink plus a public exchange API is cheaper.
- Chainlink is an on-chain data source. It does not directly produce the
  repository's Ed25519 `PriceStatement`; each authority must sign its own
  statement.

## Independence definition

The code checks distinct HTTPS hostnames and distinct operator names. It does
not prove corporate independence, human independence or device separation.
The operator must independently confirm all of the following:

- Alchemy and Infura are different companies.
- Helius and Alchemy are different companies.
- `zec.rocks` and Stardust are different operators.
- The two price authorities are operated by different people on different
  devices, with distinct Ed25519 keys.
- The Base/Solana relayers and the Zcash receiver are distinct credentials.
- The execution authority key is not the relayer key and is not a price key.
- `separateDeviceValidated: true` and
  `independenceAcknowledged: true` are set only after the operator has evidence
  for those statements.

If only one person or one device is available, stop. A declaration in JSON is
not attestation.

## Topology

```text
Zcash chain -- zec.rocks -------\
                                >-- watch-only scanner --\
Zcash chain -- Stardust --------/                          \
                                                            > local operator host
Base chain  -- Alchemy --------\                            /  (single writer,
Base chain  -- Infura ----------/-- signed quote/plan -----/   loopback only)
Solana chain-- Helius ---------\
Solana chain-- Alchemy --------/

offline signer device: relayer key + execution authority + price authority A
separate device:       price authority B
```

The operator host has outbound HTTPS only. Do not expose a public listener, a
wallet RPC, a keystore or the SQLite state directory. Keep profiles, passphrases,
keystores, journals, snapshots and evidence in a private directory outside the
repository.

## Preconditions

Do not begin until all are true:

1. The operator has explicitly approved a controlled mainnet pilot and the caps
   above.
2. Two devices are available. The second device can be offline and does not need
   to run the repository.
3. Free-tier accounts exist for Alchemy, Infura and Helius, with keys stored in
   a password manager and in private local files only.
4. `zec.rocks` and one Stardust endpoint respond and are distinct operators.
5. Two price authorities have generated independent Ed25519 keys and can sign
   the exact statement bytes.
6. A fresh controlled Zcash watch-only wallet and an owned source note are
   available. Do not use a historical wallet or a previously spent note.
7. The Base and Solana recipient addresses are controlled by the operator and
   can sign the ownership challenge.
8. Relayers are funded only within the buffers above.
9. The repository tests, typecheck and lint pass on the reviewed checkout.
10. Every execution gate and two-device approval is satisfied, and a fresh
    in-process native scan is available at execution time.

## Setup order

The exact commands are in [MAINNET-SETUP-GUIDE.md](MAINNET-SETUP-GUIDE.md).

### 1. Freeze the checkout

Record `git rev-parse HEAD`, `git status --short`, test/typecheck/lint results
and the preservation evidence. Do not pull, rebase or change dependencies during
the pilot.

### 2. Build the native tools

Build the workspace and the Zcash watch binaries. The provisioning command
expects `target/debug/derive-mainnet-ufvk.exe` and
`target/debug/inspect-mainnet-ufvk.exe`; build them with the
`services/zcash-watch` manifest and root `--target-dir target`.

### 3. Create private configuration

Create a private directory outside the repository. Put the profile, read-only
configuration, passphrase file, keystores, journals, plans and evidence there.
The repository must contain no production endpoint, passphrase, private key or
source-payment identifier.

### 4. Inspect without spending

Run `mainnet:config-check` without `--probe` first. Fix configuration errors
before any network operation. Then run `--probe` for Base and Solana. Zcash is
reported blocked because the closed probe is JSON-RPC-only and lightwalletd is
gRPC; it must not be sent a JSON-RPC request. `executionAvailable` must remain
`false` in every report.

### 5. Provision identities only after approval

Provision the Base recipient/relayer, Solana recipient/relayer and Zcash
receiver. Keep the keystores on the devices where they belong. Record only
public addresses and public keys in the profile. Never copy the Zcash spending
seed to the operator host; the watch wallet gets the UFVK only.

### 6. Fund the minimum

Fund the destination relayers with the buffers above. Fund the Zcash receiver
with two notes of at least 0.02 ZEC each. Do not pre-fund more than the pilot
needs. Confirm the exact balances through both providers before proceeding.

### 7. Produce a fresh Zcash observation

Import the UFVK into a new watch-only wallet, bind one order to the exact
account, address, amount and expiry, and observe through both lightwalletd
endpoints until the source note has the required confirmations. The watch
journal must show a confirmed owned note and no reorg.

### 8. Run Base first

Create a quote context, have both price authorities sign the exact
network/context-bound statements, create the quote, prove recipient ownership,
prepare the unsigned transfer and simulate it through both providers. Stop and
review the exact terms digest, fees, amount, recipient, relayer and expiry.

Only after every other precondition and evidence review is complete should the
operator arm execution. `execute` performs a fresh in-process native scan; do
not supply or reuse a JSON snapshot. Execute exactly once, reconcile the same
transaction identity and stop. Do not start Solana until the Base result is
finalized and recorded.

### 9. Run Solana

Repeat the quote, ownership, prepare and simulate flow for Solana. Use a new
source payment and a new quote context. Execute once and reconcile. Never reuse
the Base plan, quote, nonce or source payment.

### 10. Record and stop

Record finalized transaction IDs, block/slot, exact amounts, fees, provider
agreement and the source-payment digest. Preserve the private journals and the
public evidence. Stop after the second reconciliation. Do not enable refunds,
public access, higher caps or another transfer.

## Abort criteria

Abort the current transfer, and do not retry with new bytes, if any of these
occur:

- `mainnet:config-check` reports `FAIL` on a destination profile, or
  `executionAvailable` is anything other than `false`.
- The two providers disagree on chain identity, finalized head, balance, fee or
  simulation.
- The price statements are older than 60 seconds, expire within the quote
  window, disagree by more than 100 bps, or are not bound to the exact quote
  context.
- The quote exceeds any profile cap or any cash budget.
- The source note is missing, unconfirmed, spent, locked, ambiguous or reused.
- The recipient ownership proof is missing, expired or for a different address.
- The prepared terms, signed bundle, plan digest or transaction bytes changed.
- A broadcast result is uncertain. Reconcile; never resubmit or replace.
- A Zcash reorg, provider failure, scanner disagreement or checkpoint gap is
  observed.
- Any device, key, passphrase or profile is suspected compromised.

## Success criteria

The pilot succeeds only if all are true:

- Two finalized destination transfers, one on Base and one on Solana.
- Each transfer is funded by a distinct confirmed shielded-ZEC source payment.
- Each source payment is observed through two independent lightwalletd
  endpoints and bound to the exact order.
- Each destination transaction is verified through two independent RPC
  providers and matches the prepared terms exactly.
- No retry, replacement, refund, double spend or reused source note exists.
- The journals show one signing claim and one broadcast claim per transfer.
- Private keys, passphrases and source identifiers never entered the repository
  or public evidence.
- The operator can explain every residual trust assumption.

## Execution readiness

`mainnet:operator execute` now invokes `MainnetWatchScanner` in-process and
derives its checkpoint from the watch journal; it no longer accepts a JSON
snapshot. This closes the handoff defect only. The pilot remains **BLOCKED**
until independent providers, genuine signed prices, funded relayers, a
controlled owned-note run, signer/device evidence and the remaining gates are
actually present. Zcash still lacks independent Merkle/PoW verification.

## Residual risks

- Public Zcash endpoints can disappear, lag or collude. Two responses are not a
  consensus proof.
- Free RPC tiers can rate-limit or change terms.
- Price feeds can be stale or manipulated within the 100 bps bound.
- The signer is software, not an HSM or hardware wallet.
- A single operator host can be compromised; device separation is asserted, not
  cryptographically attested by the repository.
- Destination transactions are public. Timing and amount correlation remains.
- Zcash lacks independent Merkle/PoW verification in this implementation.

## Cost

Pilot recurring infrastructure is **$0** on the selected free tiers. Crypto
spend should be **under $5** at the illustrative prices, including buffers.
That is not a guarantee: network fees and asset prices can rise. The hard caps
are denominated in native units and must not be raised to preserve a dollar
budget.
