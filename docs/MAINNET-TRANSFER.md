# Mainnet transfer preparation and offline verification

> Acceptance update (21 October 2026): [MAINNET-ACCEPTANCE.md](MAINNET-ACCEPTANCE.md) is authoritative. Full-transaction UFVK decryption is implemented, but no authenticated mainnet scan config or owned-note fixture exists. Provisioning is tested only with disposable credentials; genuine pricing/providers and an activated operator signer/broadcast path are still missing. Mainnet remains NO-GO.

Status: **NO-GO for live execution.** This workflow constructs exact unsigned
Base and Solana mainnet transfers, verifies separately produced signatures and
fails closed before any submission. It has no key loader or signing function.
The legacy `submitMainnetTransfer()` always throws
`MAINNET_LIVE_EXECUTION_NOT_ACTIVATED_SEPARATE_AUDIT_AND_OPERATOR_APPROVAL_REQUIRED`.
A separate `executeMainnetTransfer()` exists and is fixture-tested. The operator
CLI invokes it only behind exact-order, signer and fenced-lease gates, but no
production credentials or live submission is activated.

## What is implemented

- Mainnet address validation and checksum/ownership proof. The service never
  generates, imports or stores a destination or relayer key.
- `MainnetTransferTerms` binding the destination network, dedicated relayer,
  authorized recipient, address-ownership binding, amount, total fee cap,
  source ZEC amount, source-payment commitment, production profile digest and
  expiry.
- Exact Base preparation against two independently acknowledged HTTPS
  providers: finalized block, recipient EOA check, relayer nonce, balance,
  gas estimate and gas price. The unsigned transaction is legacy EIP-155 with
  chain ID `8453`.
- Exact Solana preparation against two providers: full mainnet genesis, common
  finalized slot, finalized block anchor, system-account checks, relayer
  balance, shared recent blockhash, fee and unsigned simulation. The unsigned
  transaction is a legacy SOL transfer from the prefunded relayer.
- Offline signed-bundle verification:
  - Base: field-for-field parse, signer recovery, exact transaction hash, and
    `getL1Fee` calls to the canonical Base GasPriceOracle on both providers.
  - Solana: canonical wire round-trip, exact message-byte comparison, one
    expected signer and Ed25519 verification.
- Durable single-writer reservations and signed production-price verification
  in `services/settlement/production-safety.ts`. These are not yet wired to a
  live submitter.

## Required operator inputs

Nothing below is generated or invented by this repository.

1. A dedicated, prefunded mainnet relayer account. Its public key must derive
   to `profile.relayer`; testnet keys and addresses must not be reused.
2. A destination address controlled by the recipient. The recipient proves
   ownership by signing the challenge printed by the `address` command.
3. Two independently operated HTTPS RPC providers per chain, with
   `independenceAcknowledged: true`.
4. Two fresh, independently signed production price feeds. Demo/testnet prices
   and unsigned price files are rejected.
5. A Zcash mainnet shielded source-payment commitment and independently
   corroborated owned-note evidence from an authenticated watch profile. The
   native scanner now trial-decrypts provider-corroborated full transactions,
   but no production providers/UFVK pair or owned-note acceptance run is
   configured, so a real source payment cannot be authorized here.

## Commands

The profile file uses the existing `ProductionProfile` shape. A local copy
must set `enabled`, `relayer`, one `recipients` entry, limits, two providers,
`confirmations`, and the offline signer's SPKI PEM public key plus its
attestation reference. The key must derive to `relayer`; Base needs secp256k1
and Solana needs Ed25519. Do not commit real local profiles or secrets.

Print a destination ownership challenge:

```powershell
npm run mainnet:transfer -- address --network base --address 0x...
npm run mainnet:transfer -- address --network solana --address ...
```

The recipient signs the exact `message` and returns `nonce`, `expires` and
`signature`. For Base the signature is an EIP-191 `0x` hex signature. For
Solana it is a base58 Ed25519 signature. Save only the public proof:

```json
{ "nonce": "0x...", "expires": 1790000000, "signature": "0x..." }
```

Create a plan from a request file and signed pricing file:

```powershell
npm run mainnet:transfer -- plan `
  --profiles config/mainnet-profiles.local.json `
  --network base `
  --request request.json `
  --pricing pricing.json `
  --ownership-proof recipient-proof.json `
  --out .state/mainnet/base-plan.json
```

`request.json` contains `recipient`, `amount`, `feeCap`, optional
`l1DataFeeBound`, `sourcePaymentCommitment` and `expires`. `amount` is in
destination base units (wei or lamports). For Base, `feeCap` must cover both
the execution gas fee and the L1 data fee bound. `pricing.json` contains two
signed `SignedPrice` feeds for `ETH/ZEC` or `SOL/ZEC` and an optional
`maximumSpreadBps`.

Prepare the exact unsigned transfer against live finalized state:

```powershell
npm run mainnet:transfer -- prepare --plan .state/mainnet/base-plan.json
```

The resulting plan contains either `tx` (Base legacy fields) or
`unsignedWire`/`messageBase64` (Solana). Sign it on the separate offline
device. The relayer must be the signer; the repository never performs this
step.

Write the signed bundle:

```json
{
  "version": 1,
  "network": "base",
  "termsDigest": "<plan.termsDigest>",
  "preparedDigest": "<digest of plan.prepared>",
  "signed": "0x..."
}
```

For Solana, `signed` is the base64 wire transaction containing exactly one
signature for the relayer.

Verify without sending:

```powershell
npm run mainnet:transfer -- verify `
  --plan .state/mainnet/base-plan.json `
  --bundle base-signed.json `
  --out .state/mainnet/base-verified.json
```

Verification returns `broadcast: false` and either a Base transaction hash or
a Solana base58 transaction id. It re-checks the live Base L1 fee and the exact
Solana message bytes.

## Remaining live boundary

`scripts/mainnet-operator.ts` now wires the exact executor path to
`mainnet:execute`, with an isolated purpose-bound signer, a fenced single-writer
lease, an independent pause control, and explicit exact-order confirm/arm/resume
strings. It also supplies `status`, `prepare`, `simulate`, `reconcile` and
`pause`. The library-only executor still provides the durable claim,
write-ahead signed-bytes persistence, one-shot adapter, two-provider finality
readers, and uncertainty reconciliation.

The operator path is fixture-tested, but live activation remains blocked by:

- production profiles with independent providers and funded relayers;
- a separately validated offline signer and execution-authority key;
- genuine signed production prices;
- a demonstrated production single-writer deployment and emergency runbook;
- an authenticated Zcash mainnet scan and controlled owned-note acceptance run,
  including an inclusion/consensus review beyond provider corroboration.

No mainnet payment, production signature, submission or broadcast has occurred.
