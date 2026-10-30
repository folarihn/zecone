# First real shielded ZEC → Base ETH mainnet transfer — runbook

**Objective:** one real shielded Zcash → Base ETH mainnet transfer, before
**28 October 2026**.

**Hard bounds (locked for the pilot):**

- Maximum source payment: **0.02 ZEC** (2,000,000 zatoshis).
- Minimum **20 confirmations** on the Zcash side.
- Destination: **Base (`eip155:8453`)**, asset **ETH**.
- Funding, signing, and broadcast are **three separate, explicitly approved
  actions**. Never auto-fund, auto-sign, or auto-broadcast.
- Production keys are never generated, wallets never funded, and nothing is
  signed or broadcast without a separate operator approval.

---

## 0. Trust boundary (must be accepted before the first transfer)

The Zcash side uses the maintained SDK wallet-sync plus two independent
lightwalletd providers that must agree on bytes, height, and block hash, and
externally staged raw blocks for the payment and confirmation segment. This is
**not** a local full-node consensus implementation: it proves complete-block
Merkle inclusion and a bounded proof-of-work confirmation segment, while the
approved raw-block source, two independent lightwalletd operators, the scanner
executable, provider configuration, and imported UFVK remain trusted. If an
authenticated verified-chain-data boundary cannot be supplied, the Zcash side
must remain **NO-GO** rather than treating two RPC responses as consensus.

## 1. Build the offline Zcash helpers (local)

```powershell
cargo build --locked --manifest-path services/zcash-watch/Cargo.toml
```

Produces `target/debug/derive-mainnet-ufvk`, `target/debug/inspect-mainnet-ufvk`,
and the `zecone-zcash-watch` scanner.

Verify Docker (image build):

```powershell
docker compose --project-directory deploy -f deploy/compose.yaml build
```

## 2. Provision identities on an offline/isolated machine

Run only on a machine that will be isolated, with an empty output directory
**outside** the repository:

```powershell
npm run mainnet:provision -- `
  --out D:\offline\mainnet-creds `
  --passphrase-file D:\offline\passphrase.txt `
  --zcash-birthday <recent-mainnet-height> `
  --confirm CREATE_MAINNET_KEYS
```

Outputs (stay on that machine):

- `base-recipient.keystore.json`, `base-relayer.keystore.json`
- `solana-recipient.keystore.json`, `solana-relayer.keystore.json`
- `zcash-receiver.keystore.json` (seed mode) or a UFVK import
- `zcash-receiver.ufvk` — watch-only key for the backend/watch host
- `provisioning.json` — public addresses and roles only

Only the **public** addresses from `provisioning.json` are shared.

## 3. Production profiles

`config/mainnet-profiles.production.json` (three entries). Each entry:

```jsonc
{
  "network": "base",               // "zcash" | "base" | "solana"
  "enabled": false,                // keep false until explicitly armed
  "providers": [
    { "endpoint": "https://...", "operator": "operator-a" },
    { "endpoint": "https://...", "operator": "operator-b" }
  ],
  "independenceAcknowledged": true,
  "relayer": "0x<base-relayer>",   // base/solana only
  "recipients": ["0x<base-recipient>"],
  "perTransaction": "<cap>",
  "daily": "<cap>",
  "feeCap": "<cap>",
  "confirmations": 20,             // zcash only; base/solana >= 1
  "priceAuthorities": [            // two distinct Ed25519 operators
    { "operator": "auth-a", "publicKey": "<ed25519-spki>" },
    { "operator": "auth-b", "publicKey": "<ed25519-spki>" }
  ],
  "signer": {
    "identity": "<signer-device-id>",
    "publicKey": "<relayer-signing-key>",   // secp256k1 base, ed25519 solana
    "transport": "offline-bundle",
    "separateDeviceValidated": true,
    "attestationReference": "<reference>"
  },
  "executionAuthority": {
    "identity": "<execution-device-id>",
    "publicKey": "<ed25519-spki>",
    "separateDeviceValidated": true,
    "attestationReference": "<reference>"
  }
}
```

Also write `config/mainnet-readonly.production.json` (see
`config/mainnet-readonly.example.json`), filling in the real provider endpoints
and env-only key references. Neither file contains a private key or passphrase.

Validate (no network), then read-only probe:

```powershell
npm run mainnet:config-check -- --profiles config/mainnet-profiles.production.json --readonly config/mainnet-readonly.production.json
npm run mainnet:config-check -- --profiles config/mainnet-profiles.production.json --readonly config/mainnet-readonly.production.json --probe
```

## 4. Two independent signed price feeds

For `ETH/ZEC`, produce a `pricing.json` with two independently signed statements:

```jsonc
{
  "pair": "ETH/ZEC",
  "feeds": [
    { "price": { "version": 1, "operator": "auth-a", "pair": "ETH/ZEC",
      "numerator": "...", "denominator": "...", "at": ..., "expires": ...,
      "network": "base-mainnet", "quoteContext": "<context-digest>" },
      "signature": "<base64 ed25519>", "publicKey": "<auth-a>" },
    { "...": "auth-b" }
  ],
  "maximumSpreadBps": 100,
  "networkFee": "<wei>",
  "l1DataFee": "<wei>",
  "serviceFee": "0",
  "ttlSeconds": 120
}
```

Build the context both authorities sign, then the quote:

```powershell
npm run mainnet:quote -- context --profiles config/mainnet-profiles.production.json --network base --pair ETH/ZEC --amount <ETH-weis> --network-fee <wei> --l1-data-fee <wei> --service-fee 0 --out quote-context.json
npm run mainnet:quote -- quote --profiles config/mainnet-profiles.production.json --pricing pricing.json --network base --amount <ETH-weis> --out quote.json
```

## 5. Destination ownership proof

The Base recipient signs a challenge proving ownership of the destination
address. Supply `ownership-proof.json`:

```jsonc
{ "nonce": "<hex64>", "expires": <unix-seconds>, "signature": "<recipient-signature>" }
```

## 6. Prepare + simulate (no signing, no broadcast)

```powershell
npm run mainnet:prepare -- --network base --profiles config/mainnet-profiles.production.json `
  --request request.json --pricing pricing.json --quote quote.json `
  --ownership-proof ownership-proof.json --out plan.json

npm run mainnet:simulate -- --profiles config/mainnet-profiles.production.json --plan plan.json
```

`request.json` needs `recipient`, `amount` (≤ cap), `feeCap`, `l1DataFeeBound`,
`sourcePaymentCommitment`, `expires`.

## 7. Fund source and stage authenticated blocks

- Fund the Zcash **watch-only** address with **≤ 0.02 ZEC** (separate approval).
- Sync and produce the authenticated raw-block corpus and the owned-note binding
  at ≥ 20 confirmations:

```powershell
npm run mainnet:block-export ...      # authenticated raw blocks, external dir
npm run mainnet:watch ...             # UFVK scan → watch journal + order binding
```

## 8. Offline sign (separate signing device)

```powershell
npm run mainnet:offline-sign -- --plan plan.json --profiles config/mainnet-profiles.production.json `
  --approval approval.json --confirm <prepared-digest> `
  --keystore <relayer.keystore.json> --passphrase-file <passphrase-file> `
  --signer-ledger <signer-ledger.sqlite> --out signed-bundle.json --arm SIGN_EXACT_MAINNET_BUNDLE
```

`approval.json` binds `termsDigest`, `preparedDigest`, `maximumDestinationDebit`,
`expires`.

## 9. Execute + reconcile (explicit go required)

```powershell
npm run mainnet:execute -- --plan plan.json --profiles config/mainnet-profiles.production.json `
  --confirm <termsDigest> --lease-owner <operator-id> --lease <lease.sqlite> --journal <submitter.sqlite> `
  --watch-journal <watch.sqlite> --watch-binding binding.json --watch-wallet <watch-profile-dir> `
  --watch-server <https-primary> --watch-peer <https-peer> --watch-authenticated-blocks <raw-blocks-dir> `
  --execution-authorization execution-authorization.json --bundle signed-bundle.json `
  --arm ARM_MAINNET_EXECUTION --resume-submitter RESUME_MAINNET_SUBMITTER

npm run mainnet:reconcile -- --plan plan.json --profiles config/mainnet-profiles.production.json `
  --lease <lease.sqlite> --journal <submitter.sqlite> --order <order-id> --arm ARM_MAINNET_EXECUTION
```

## 10. Backup and recovery

- Keystores are encrypted (age) with a passphrase of ≥ 24 chars.
- The UFVK and provisioning metadata are retained off-host.
- Backup: `npm run mainnet:watch-backup` for the watch profile; keystores are
  copied to the BitLocker-encrypted `D:` drive and to a second, physically
  separate location before any live transfer.
- Recovery drill: `npm run mainnet:zcash-recover -- --keystore <keystore> --passphrase-file <passphrase-file> --provisioning <provisioning.json> --out <ufvk> --confirm RECOVER_MAINNET_UFVK`.

## 11. What is shared vs. never shared

**Shared (public only):** the three public addresses, provider endpoints +
operator names, the two price-authority **public** keys, exact caps,
`plan.json`, `preparedDigest`, and `termsDigest`.

**Never shared:** any keystore, seed, passphrase, UFVK, relayer private key,
provider API key, or the signed bundle. Those stay on their respective
offline/backend devices.
