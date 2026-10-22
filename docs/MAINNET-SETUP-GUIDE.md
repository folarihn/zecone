# Mainnet setup guide

This is the hands-on companion to [MAINNET-PILOT-PLAN.md](MAINNET-PILOT-PLAN.md)
and [MAINNET-PUBLIC-LAUNCH.md](MAINNET-PUBLIC-LAUNCH.md). It describes the
cheapest safe controlled-pilot setup. It does **not** authorize a live transfer.
Mainnet execution remains disabled by the repository.

Read the whole guide before creating accounts or keys. Stop at every review
gate. If a step does not match the reviewed plan, stop instead of improvising.

## Safety rules

- Never put production endpoints, passphrases, private keys, keystores, UFVKs,
  source-payment identifiers or journals in the repository.
- Never paste a seed, private key or age identity into a shell, chat, issue or
  browser page.
- Keep the watch-backup age identity on a different device from the encrypted
  archive. Never store both together or in the repository.
- Never fund more than the pilot caps.
- Never reuse a source note, order, nonce, quote, signed bundle or plan.
- Never run `execute` until every pilot precondition, two-device approval and
  fresh native-scan requirement is actually satisfied.
- Never raise a cap, extend an expiry or replace an uncertain transaction to
  make a failed step pass.
- Use two devices. One device is not a valid pilot configuration.
- Treat `independenceAcknowledged`, `separateDeviceValidated` and
  `attestationReference` as factual claims that need evidence.

## 1. Prepare the workstation

Use PowerShell in the repository root. Confirm the reviewed checkout:

```powershell
git rev-parse HEAD
git status --short
npm.cmd ci --ignore-scripts
cargo build --locked
forge build
```

Expected: the checkout is the reviewed commit and the preservation audit has
already been recorded. Do not pull or change dependencies during the pilot.

Create a private directory outside the repository and restrict it to the current
Windows user:

```powershell
$private = Join-Path $env:USERPROFILE "ZecOne-mainnet-pilot"
New-Item -ItemType Directory -Force -Path $private | Out-Null
$acl = "$env:USERNAME:(OI)(CI)F"
icacls $private /inheritance:r /grant:r $acl
$keys = Join-Path $private "keys"
$state = Join-Path $private "state"
$evidence = Join-Path $private "evidence"
New-Item -ItemType Directory -Force -Path $keys,$state,$evidence | Out-Null
```

Do not commit anything under `$private`.

Build the native Zcash watch and provisioning helpers. The provisioning script
expects the helpers at the repository-level `target/debug` path:

```powershell
cargo build --locked --offline --manifest-path services/zcash-watch/Cargo.toml --target-dir target -j 2 --bins
Test-Path .\target\debug\derive-mainnet-ufvk.exe
Test-Path .\target\debug\inspect-mainnet-ufvk.exe
Test-Path .\target\debug\zecone-zcash-watch.exe
```

All three must be `True` before provisioning.

## 2. Create free provider accounts

Create accounts in a browser profile that is not used for production keys. Store
credentials in a password manager. Do not save them in the repository.

| Provider | What to create | Copy into the private config |
| --- | --- | --- |
| Alchemy | Base Mainnet app and Solana Mainnet app | HTTPS RPC URLs including the API key |
| Infura | Base Mainnet API key | `https://base-mainnet.infura.io/v3/<KEY>` |
| Helius | Solana Mainnet API key | `https://mainnet.helius-rpc.com/?api-key=<KEY>` |
| `zec.rocks` | No account; public endpoint | `https://zec.rocks:443` |
| Stardust | No account; public endpoint | `https://us.zec.stardust.rest:443` or the EU endpoint |

Before using an endpoint, confirm it is the intended network and operator. Do
not use two regional `zec.rocks` URLs as a pair. Do not use a one-month
QuickNode trial. Do not pay for a plan during the pilot.

The Base pair for the pilot is Alchemy + Infura. The Solana pair is Helius +
Alchemy. Keep the API keys for the two networks separate if the provider allows
it.

## 3. Create the offline identities

Create the Base/Solana recipient and relayer keys with the repository's offline
provisioning command. This step creates real mainnet credentials. Run it only
after the operator approves the pilot.

Create a passphrase of at least 24 bytes in a password manager, save it there,
and write the exact passphrase to a private file. Do not use an inline command
that leaves it in shell history. Then check the file size:

```powershell
$pass = Join-Path $private "passphrase.txt"
(Get-Item $pass).Length
```

The length must be between 24 and 1024 bytes. Keep a separate offline backup of
the passphrase; losing it loses the keystores.

Run provisioning into an empty directory outside the repository:

```powershell
npm run --silent mainnet:provision -- `
  --out (Join-Path $keys "provisioned") `
  --passphrase-file $pass `
  --zcash-birthday <RECENT_MAINNET_HEIGHT_BEFORE_FIRST_RECEIPT> `
  --confirm CREATE_MAINNET_KEYS
```

The command prints only `PROVISIONED`, the output path, `signing:false`,
`broadcast:false` and the credential count; it must not print secrets. Inspect
only the public fields in `provisioning.json`:

```powershell
$prov = Join-Path $keys "provisioned\provisioning.json"
Get-Content $prov
```

Record these public values for the profiles:

- `base-recipient.address`
- `base-relayer.address` and `base-relayer.publicKey`
- `solana-recipient.address`
- `solana-relayer.address` and `solana-relayer.publicKey`
- `zcash-receiver.address`, `account` and the UFVK file path

Keep `base-relayer.keystore.json` and `solana-relayer.keystore.json` on the
offline signer device. Keep the Zcash receiver keystore and seed off the operator
host. The operator host may hold the watch-only UFVK.

Generate the execution-authority key on the offline signer device, and one price
authority key on each of two separate devices. Ed25519 keys can be generated
with OpenSSL 3:

```powershell
openssl genpkey -algorithm ED25519 -out execution-authority-private.pem
openssl pkey -in execution-authority-private.pem -pubout -out execution-authority-public.pem

openssl genpkey -algorithm ED25519 -out pricing-a-private.pem
openssl pkey -in pricing-a-private.pem -pubout -out pricing-a-public.pem

openssl genpkey -algorithm ED25519 -out pricing-b-private.pem
openssl pkey -in pricing-b-private.pem -pubout -out pricing-b-public.pem
```

Do not copy any `*-private.pem` file to the operator workstation. The profile
contains only the public keys.

## 4. Write the private profiles

Create `$private\profiles.json` with the actual addresses and public keys. The
template below is deliberately incomplete; replace every placeholder. Keep the
file outside the repository.

```json
[
  {
    "network": "zcash",
    "enabled": true,
    "providers": [
      { "endpoint": "https://zec.rocks:443", "operator": "zec-rocks" },
      {
        "endpoint": "https://us.zec.stardust.rest:443",
        "operator": "stardust-staking"
      }
    ],
    "independenceAcknowledged": true,
    "recipients": [],
    "perTransaction": "2000000",
    "daily": "4000000",
    "feeCap": "10000",
    "confirmations": 20
  },
  {
    "network": "base",
    "enabled": true,
    "providers": [
      {
        "endpoint": "https://base-mainnet.g.alchemy.com/v2/<ALCHEMY_KEY>",
        "operator": "alchemy"
      },
      {
        "endpoint": "https://base-mainnet.infura.io/v3/<INFURA_KEY>",
        "operator": "infura"
      }
    ],
    "independenceAcknowledged": true,
    "relayer": "<BASE_RELAYER_ADDRESS>",
    "recipients": ["<BASE_RECIPIENT_ADDRESS>"],
    "perTransaction": "100000000000000",
    "daily": "100000000000000",
    "feeCap": "10000000000000",
    "confirmations": 1,
    "signer": {
      "identity": "base-relayer-offline-device",
      "publicKey": "-----BEGIN PUBLIC KEY-----\n<BASE_RELAYER_PUBLIC_KEY>\n-----END PUBLIC KEY-----\n",
      "transport": "offline-bundle",
      "separateDeviceValidated": true,
      "attestationReference": "<PRIVATE_EVIDENCE_ID>"
    },
    "executionAuthority": {
      "identity": "execution-authority-offline-device",
      "publicKey": "-----BEGIN PUBLIC KEY-----\n<EXECUTION_AUTHORITY_PUBLIC_KEY>\n-----END PUBLIC KEY-----\n",
      "separateDeviceValidated": true,
      "attestationReference": "<PRIVATE_EVIDENCE_ID>"
    },
    "priceAuthorities": [
      {
        "operator": "pricing-a",
        "publicKey": "-----BEGIN PUBLIC KEY-----\n<PRICING_A_PUBLIC_KEY>\n-----END PUBLIC KEY-----\n"
      },
      {
        "operator": "pricing-b",
        "publicKey": "-----BEGIN PUBLIC KEY-----\n<PRICING_B_PUBLIC_KEY>\n-----END PUBLIC KEY-----\n"
      }
    ]
  },
  {
    "network": "solana",
    "enabled": true,
    "providers": [
      {
        "endpoint": "https://mainnet.helius-rpc.com/?api-key=<HELIUS_KEY>",
        "operator": "helius"
      },
      {
        "endpoint": "https://solana-mainnet.g.alchemy.com/v2/<ALCHEMY_KEY>",
        "operator": "alchemy"
      }
    ],
    "independenceAcknowledged": true,
    "relayer": "<SOLANA_RELAYER_ADDRESS>",
    "recipients": ["<SOLANA_RECIPIENT_ADDRESS>"],
    "perTransaction": "1010000",
    "daily": "1010000",
    "feeCap": "10000",
    "confirmations": 1,
    "signer": {
      "identity": "solana-relayer-offline-device",
      "publicKey": "-----BEGIN PUBLIC KEY-----\n<SOLANA_RELAYER_PUBLIC_KEY>\n-----END PUBLIC KEY-----\n",
      "transport": "offline-bundle",
      "separateDeviceValidated": true,
      "attestationReference": "<PRIVATE_EVIDENCE_ID>"
    },
    "executionAuthority": {
      "identity": "execution-authority-offline-device",
      "publicKey": "-----BEGIN PUBLIC KEY-----\n<EXECUTION_AUTHORITY_PUBLIC_KEY>\n-----END PUBLIC KEY-----\n",
      "separateDeviceValidated": true,
      "attestationReference": "<PRIVATE_EVIDENCE_ID>"
    },
    "priceAuthorities": [
      {
        "operator": "pricing-a",
        "publicKey": "-----BEGIN PUBLIC KEY-----\n<PRICING_A_PUBLIC_KEY>\n-----END PUBLIC KEY-----\n"
      },
      {
        "operator": "pricing-b",
        "publicKey": "-----BEGIN PUBLIC KEY-----\n<PRICING_B_PUBLIC_KEY>\n-----END PUBLIC KEY-----\n"
      }
    ]
  }
]
```

Important details:

- `signer.publicKey` must derive to `relayer`; the configuration check enforces
  this.
- `executionAuthority` must be Ed25519 and must not be the same key as the
  relayer.
- The two `priceAuthorities` must have distinct public keys and distinct
  operator names. Use the exact same operator strings in the signed price
  statements.
- `separateDeviceValidated: true` is a claim. Set it only after you have
  evidence for physical separation.
- `independenceAcknowledged: true` is a claim. Set it only after confirming the
  provider companies/operators.
- `enabled: true` makes the profile usable by planning commands. It does not
  enable `execute`.
- Do not put a real UFVK or seed in this file.

Create `$private\readonly.json` with the same provider endpoints:

```json
{
  "mode": "READ_ONLY",
  "paymentsEnabled": false,
  "signingEnabled": false,
  "broadcastEnabled": false,
  "refundsEnabled": false,
  "networks": {
    "zcash": {
      "network": "mainnet",
      "lightwalletd": "https://zec.rocks:443",
      "independentNode": "https://us.zec.stardust.rest:443",
      "status": "PILOT_PUBLIC_BEST_EFFORT"
    },
    "ethereum": {
      "chainId": 1,
      "primary": null,
      "secondary": null,
      "status": "NOT_USED_BY_PILOT"
    },
    "base": {
      "chainId": 8453,
      "productionPrimary": "https://base-mainnet.g.alchemy.com/v2/<ALCHEMY_KEY>",
      "productionSecondary": "https://base-mainnet.infura.io/v3/<INFURA_KEY>"
    },
    "solana": {
      "genesisHash": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      "productionPrimary": "https://mainnet.helius-rpc.com/?api-key=<HELIUS_KEY>",
      "productionSecondary": "https://solana-mainnet.g.alchemy.com/v2/<ALCHEMY_KEY>"
    }
  },
  "productionKeyReferences": {
    "signer": "offline-device:base-relayer",
    "executionAuthority": "offline-device:execution-authority",
    "priceAuthorities": ["device-a:pricing-a", "device-b:pricing-b"]
  },
  "executionLimits": {
    "zcashPerTransaction": "2000000",
    "zcashDaily": "4000000",
    "basePerTransaction": "100000000000000",
    "solanaPerTransaction": "1010000"
  }
}
```

`productionKeyReferences` and `executionLimits` satisfy the structural check only.
They are not attestations and do not unlock anything.

## 5. Check configuration without spending

Run the structural check first. It must not contact a provider:

```powershell
$profiles = Join-Path $private "profiles.json"
$readonly = Join-Path $private "readonly.json"
npm run --silent mainnet:config-check -- `
  --profiles $profiles `
  --readonly $readonly `
  > (Join-Path $evidence "config-check.json")
Get-Content (Join-Path $evidence "config-check.json")
```

Expected: every finding is understood, `executionAvailable` is `false`, and no
secret or raw endpoint URL is printed. Fix `FAIL` findings before continuing.
`BLOCKED` findings such as a missing signer or `PROFILE_DISABLED` are expected
until the corresponding input is real.

Then run the read-only network probe for Base and Solana:

```powershell
npm run --silent mainnet:config-check -- `
  --profiles $profiles `
  --readonly $readonly `
  --probe `
  > (Join-Path $evidence "config-check-probe.json")
Get-Content (Join-Path $evidence "config-check-probe.json")
```

The probe checks Base chain ID/finalized block and Solana genesis/finalized slot.
It also checks balances and unsigned simulation if a relayer and recipient are
configured. Zcash is intentionally reported blocked: lightwalletd is gRPC and
the closed probe is JSON-RPC-only. The command must not send JSON-RPC to a
lightwalletd endpoint.

A probe does not prove provider independence, device isolation, source-note
ownership or execution safety. It cannot make `executionAvailable` true.

## 6. Fund the minimum

Fund only after the configuration check is reviewed.

- Base relayer: about 0.0002 ETH. It must cover the 0.00009 ETH transfer, gas,
  L1 data fee and a small buffer.
- Solana relayer: about 0.003 SOL. It must cover the 0.001 SOL transfer, the
  5,000-lamport fee and rent/account considerations. The 0.001 SOL recipient
  amount is above the current ~0.00089088 SOL rent-exempt minimum for a new
  zero-data system account; recheck this minimum at run time.
- Zcash receiver: two notes of at least 0.02 ZEC each. The receiver must have
  enough spendable balance to pay the Zcash fee while leaving the source note
  amount intact.

Do not fund the recipient addresses. Do not send from an exchange account that
requires a memo or a shared deposit address for Zcash. Use a wallet that can
produce a shielded note and a transaction ID you control.

Re-run the probe after funding. A liquidity `FAIL` means the relayer is not
funded enough for the configured debit. Do not raise the cap; add only the
missing buffer if it still fits the pilot budget.

## 7. Import and observe the Zcash source

Use a new watch-only directory. Do not point this at a historical wallet.

```powershell
$watch = Join-Path $private "zcash-watch"
$ufvk = Join-Path $keys "provisioned\zcash-receiver.ufvk"
$server = "https://zec.rocks:443"
$peer = "https://us.zec.stardust.rest:443"
$birthday = "<HEIGHT_BEFORE_THE_SOURCE_NOTE>"
$blocks = Join-Path $private "zcash-authenticated-blocks"

npm run --silent mainnet:watch -- import `
  --wallet $watch `
  --ufvk $ufvk `
  --birthday $birthday `
  --server $server `
  --peer $peer
```

The import must fail rather than open a spending wallet. The watcher holds only
the UFVK. Choose a birthday at or before the source note's block; a very old
birthday makes the scan slow, while a birthday after the note misses it. A
buffer of 100-1,000 blocks is reasonable for a fresh note.

Before observation, export the raw binary mainnet block containing each
candidate payment and the following blocks needed for the confirmation policy
from an approved full-node source. Store each outside the repository as
`<height>-<display-hash>.bin` in `$blocks`. ZecOne verifies the complete block's
transaction Merkle root, header hash, Equihash solution and target, and verifies
the linked proof-of-work confirmation segment. lightwalletd compact transaction
lists are intentionally not used as a complete Merkle tree because the protocol
omits transactions without shielded activity. Missing or malformed raw blocks
fail closed.

Create one order binding. The amount is the exact source-note value in zatoshis,
not the destination quote. For a 0.02 ZEC note:

```powershell
$order = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$binding = Join-Path $state "zcash-binding.json"
@"
{
  "orderId": "$order",
  "account": "<ZCASH_ACCOUNT_FROM_PROVISIONING>",
  "address": "<ZCASH_RECEIVER_ADDRESS>",
  "zatoshis": "2000000",
  "expires": $($now + 3600)
}
"@ | Set-Content -Encoding utf8 $binding
```

Do not add a `memoHex` unless the funding wallet will actually include that
memo. A wrong memo makes the payment invisible to the binding.

Bind and observe:

```powershell
$journal = Join-Path $state "zcash-watch.sqlite"
npm run --silent mainnet:watch -- bind `
  --journal $journal `
  --binding $binding

npm run --silent mainnet:watch -- observe `
  --wallet $watch `
  --server $server `
  --peer $peer `
  --authenticated-blocks $blocks `
  --journal $journal `
  --binding $binding
```

The observation must become `confirmed` with reason `OWNED_NOTE_CONFIRMED` and
`reorgDetected: false`. The scanner's minimum is 10 confirmations; the profile
requires 20. Wait for at least 20 before planning execution. Record
`paymentDigest` from the confirmed observation. That value is the
`sourcePaymentCommitment` for the destination request.

Do not reuse this note for the second transfer. Create a separate order binding
and confirm a second note.

## 8. Back up and recover the watch profile

Stop the watcher before copying the profile. The backup command refuses a
profile containing `process.lock`, a symlink, an unexpected file, a testnet key
or an inconsistent `watch-only.json`. It reads only
`watch-only.json`, `viewing-key.txt`, `wallet.sqlite` and optional SQLite WAL/SHM
files. It does not include the keystore or seed.

Generate a separate age identity on the offline backup device. The identity is
written to a new private file and must never be stored with the backup or in the
repository:

```powershell
$ageIdentity = Join-Path $keys "zcash-watch-backup.agekey"
$ageRecipient = Join-Path $keys "zcash-watch-backup.agepub"
npm run --silent mainnet:watch-backup -- identity `
  --out $ageIdentity `
  --confirm CREATE_AGE_IDENTITY
```

Copy the printed `recipient` value (beginning `age1`) into `$ageRecipient`. Then
create the encrypted archive and record its SHA-256:

```powershell
$watchBackup = Join-Path $evidence "zcash-watch-backup.age"
npm run --silent mainnet:watch-backup -- backup `
  --profile $watch `
  --recipient-file $ageRecipient `
  --out $watchBackup `
  --confirm CREATE_WATCH_BACKUP
```

Keep the age identity on a different device from the archive. A copied archive
is not recoverable without that identity. Verify the live profile and perform a
real restore into a new directory:

```powershell
npm run --silent mainnet:watch-backup -- verify --profile $watch

$restoredWatch = Join-Path $state "zcash-watch-restored"
npm run --silent mainnet:watch-backup -- restore `
  --backup $watchBackup `
  --identity-file $ageIdentity `
  --out $restoredWatch `
  --confirm RESTORE_WATCH_PROFILE
```

The restored account, address and birthday must exactly match provisioning and
the original watch manifest. Never restore over an existing wallet. Test the
restore before funding. Production backup readiness also requires an approved
age recipient and an audited off-host destination; the public repository does
not supply either.

Recover the UFVK from the receiver keystore when the original viewing-key file is
lost. This requires the receiver passphrase and the provisioning metadata:

```powershell
$recovered = Join-Path $keys "recovered"
New-Item -ItemType Directory -Path $recovered
npm run --silent mainnet:zcash-recover -- `
  --keystore (Join-Path $keys "provisioned\zcash-receiver.keystore.json") `
  --passphrase-file $pass `
  --provisioning $prov `
  --out (Join-Path $recovered "zcash-receiver.ufvk") `
  --confirm RECOVER_MAINNET_UFVK
```

The printed account and address must match `provisioning.json`. Independently
inspect the new UFVK without printing it:

```powershell
Get-Content (Join-Path $recovered "zcash-receiver.ufvk") |
  .\target\debug\inspect-mainnet-ufvk.exe
```

The helper must report `ufvkValid: true` and the same public address. It never
prints the viewing key. Then rebuild the watch-only profile from the recovered
UFVK and the recorded birthday; do not overwrite the original profile.

## 9. Build a price context and sign the feeds

The quote context binds the network, pair, amount, fee bounds and exact profile.
Compute it before asking either authority to sign:

```powershell
$contextFile = Join-Path $state "base-context.json"
npm run --silent mainnet:quote -- context `
  --profiles $profiles `
  --network base `
  --pair ETH/ZEC `
  --amount 90000000000000 `
  --network-fee 2000000000000 `
  --l1-data-fee 3000000000000 `
  --service-fee 0 `
  --out $contextFile
Get-Content $contextFile
```

Use the exact same `--network-fee`, `--l1-data-fee` and `--service-fee` values in
`pricing.json` later. Changing any of them changes the context and invalidates
the signatures.

Each authority reads an independent price source, computes ZEC per one whole
destination unit, and creates a statement in this exact key order:

```json
{
  "version": 1,
  "operator": "pricing-a",
  "pair": "ETH/ZEC",
  "numerator": "<ZEC_PER_ETH>",
  "denominator": "1",
  "at": 1799999999,
  "expires": 1800000059,
  "network": "base-mainnet",
  "quoteContext": "<QUOTE_CONTEXT>"
}
```

For Solana, use `"pair": "SOL/ZEC"`, `"network": "solana-mainnet"` and
`"numerator": "<ZEC_PER_SOL>"`.

The rational is ZEC per destination unit. If 1 ETH is worth 100 ZEC, use
`numerator: "100", denominator: "1"`. Do not use a decimal. Both authorities
must sign the same economic values within the 100 bps spread limit.

The signature is Ed25519 over the exact bytes `JSON.stringify(statement)`. Key
order, whitespace and escaping matter because the verifier re-stringifies the
parsed object. Do not pretty-print the statement, reorder its keys or edit it
after signing. A minimal signer-device helper is:

```js
import { readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, sign } from "node:crypto";

const [statementFile, privateKeyFile, outFile] = process.argv.slice(2);
const statement = JSON.parse(readFileSync(statementFile, "utf8"));
const signature = sign(
  null,
  Buffer.from(JSON.stringify(statement)),
  createPrivateKey(readFileSync(privateKeyFile)),
).toString("base64");
writeFileSync(outFile, JSON.stringify({ statement, signature }, null, 2));
```

Run that only on the authority device, with the private key readable only by
that authority. Inspect the statement before signing. The repo never needs the
private key.

Create `pricing.json` with both signed feeds, the public keys pinned in the
profile, and the exact fee values used for the context:

```json
{
  "pair": "ETH/ZEC",
  "feeds": [
    {
      "price": {
        "statement": {
          "version": 1,
          "operator": "pricing-a",
          "pair": "ETH/ZEC",
          "numerator": "<ZEC_PER_ETH>",
          "denominator": "1",
          "at": 1799999999,
          "expires": 1800000059,
          "network": "base-mainnet",
          "quoteContext": "<QUOTE_CONTEXT>"
        },
        "signature": "<BASE64_ED25519_SIGNATURE>"
      },
      "publicKey": "-----BEGIN PUBLIC KEY-----\n<PRICING_A_PUBLIC_KEY>\n-----END PUBLIC KEY-----\n"
    },
    {
      "price": {
        "statement": {
          "version": 1,
          "operator": "pricing-b",
          "pair": "ETH/ZEC",
          "numerator": "<ZEC_PER_ETH>",
          "denominator": "1",
          "at": 1799999999,
          "expires": 1800000059,
          "network": "base-mainnet",
          "quoteContext": "<QUOTE_CONTEXT>"
        },
        "signature": "<BASE64_ED25519_SIGNATURE>"
      },
      "publicKey": "-----BEGIN PUBLIC KEY-----\n<PRICING_B_PUBLIC_KEY>\n-----END PUBLIC KEY-----\n"
    }
  ],
  "networkFee": "2000000000000",
  "l1DataFee": "3000000000000",
  "serviceFee": "0",
  "ttlSeconds": 60,
  "maximumSpreadBps": 100
}
```

The operator name and public key must match a pinned authority. A
self-selected key is rejected even if its signature is valid.

## 10. Create the quote

```powershell
$quote = Join-Path $state "base-quote.json"
npm run --silent mainnet:quote -- quote `
  --profiles $profiles `
  --pricing (Join-Path $state "base-pricing.json") `
  --network base `
  --amount 90000000000000 `
  --out $quote
Get-Content $quote
```

The quote must be fresh, under the caps, and show `CORROBORATED_SIGNED_PRICES`.
If it fails, do not edit the signature or the context. Obtain new statements.

## 11. Prove destination ownership and prepare

Get the ownership challenge for the exact recipient:

```powershell
npm run --silent mainnet:transfer -- address `
  --network base `
  --address "<BASE_RECIPIENT_ADDRESS>"
```

Sign the printed `message` with the recipient wallet. Save only:

```json
{
  "nonce": "<NONCE_FROM_OUTPUT>",
  "expires": 1799999999,
  "signature": "<SIGNATURE>"
}
```

Create `$state\base-request.json`:

```json
{
  "recipient": "<BASE_RECIPIENT_ADDRESS>",
  "amount": "90000000000000",
  "feeCap": "10000000000000",
  "l1DataFeeBound": "3000000000000",
  "sourcePaymentCommitment": "<CONFIRMED_ZCASH_PAYMENT_DIGEST>",
  "expires": 1799999999
}
```

Prepare the exact unsigned transfer:

```powershell
$plan = Join-Path $state "base-plan.json"
npm run --silent mainnet:prepare -- `
  --network base `
  --profiles $profiles `
  --request (Join-Path $state "base-request.json") `
  --pricing (Join-Path $state "base-pricing.json") `
  --quote $quote `
  --ownership-proof (Join-Path $state "base-ownership-proof.json") `
  --out $plan
```

Review the `termsDigest`, `preparedDigest`, amount, recipient, relayer, fees,
source commitment and expiry. Any change requires a new plan.

Simulate without signing or broadcasting:

```powershell
npm run --silent mainnet:simulate -- `
  --profiles $profiles `
  --plan $plan
```

Stop here. This guide does not authorize live execution. The `execute` command
now runs the native scanner in-process and accepts `--watch-wallet`,
`--watch-server`, `--watch-peer` and `--watch-authenticated-blocks` instead of a JSON snapshot. Run it only after
every precondition, two-device approval and evidence review is complete. A
simulation is not authorization.

## 12. Reconcile and record

After all preconditions and evidence reviews are complete:

- Run one exact execution with the required confirm/arm/resume gates.
- Reconcile the same transaction identity; never submit a replacement.
- Record finalized transaction ID, block/slot, amount, fee, provider agreement
  and source `paymentDigest`.
- Preserve the private journals and hash the public plan/quote/evidence files.
- Stop before starting Solana. Repeat the entire flow with a new source note,
  new quote context and new plan.

Do not enable refunds, public traffic, higher caps or a second attempt in the
same run.

## 13. Evidence checklist

Store under `$private\evidence`:

- `git rev-parse HEAD` and `git status --short`.
- Test, typecheck, lint and build logs.
- `config-check.json` and `config-check-probe.json`.
- Provisioning public fields only; never keystores, passphrases, age identities
  or UFVKs.
- Encrypted watch-backup SHA-256 and the restored account/address/birthday
  metadata; keep the age identity and archive separate.
- UFVK recovery output metadata; no recovered viewing-key contents.
- Both Zcash watch observations with `paymentDigest`.
- Quote context, signed statement inputs, pricing, quote, request, ownership
  proof, plan and simulation output.
- The exact terms digest and prepared digest.
- Finalized transaction evidence and reconciliation output.
- A signed operator note explaining any failure, abort or residual uncertainty.

Do not publish source-payment identifiers, UFVKs, private endpoints, passphrases
or keystores. Public evidence should contain only the destination transaction,
amounts, finality and non-sensitive configuration facts.

## Troubleshooting

- **`PROVISION_HELPER_UNAVAILABLE`**: the `derive-mainnet-ufvk` or
  `inspect-mainnet-ufvk` binary is missing. Rebuild with the watch manifest and
  `--target-dir target`.
- **`PLACEHOLDER_OR_INSECURE_PROVIDER`**: an endpoint still contains
  `.invalid`, `localhost`, `.local`, `.test` or `.example`, or is not HTTPS.
- **`PROVIDER_INDEPENDENCE_REQUIRED`**: two endpoints share a hostname, or two
  operators have the same name. Do not relabel one provider to bypass it.
- **`SIGNER_RELAYER_MISMATCH`**: the signer public key does not derive to the
  configured relayer. Use the relayer key from the same provisioning output.
- **`INDEPENDENT_EXECUTION_AUTHORITY_REQUIRED`**: the authority is missing, not
  Ed25519, or duplicates the relayer key.
- **`UNAUTHORIZED_OR_UNBOUND_PRODUCTION_PRICE`**: the operator name, pinned key,
  network or quote context does not match. Regenerate the context and signatures
  rather than editing the quote.
- **`WATCH_PROFILE_MUST_BE_STOPPED`**: `process.lock` still exists. Stop the
  watcher cleanly and retry; do not delete the lock to force a backup.
- **`HISTORICAL_WALLET_PATH_FORBIDDEN` / `WATCH_PATH_INSIDE_REPOSITORY`**: the
  path is historical, inside the repository, or reached through a symlink.
  Choose a new external directory; never override the guard.
- **`WATCH_BACKUP_DECRYPT_FAILED`**: the age identity is wrong or the archive
  was altered. Restore from another verified copy; do not edit the ciphertext.
- **`MAINNET_CHECKPOINT_ABOVE_TIP`**: the watch checkpoint is ahead of the
  provider. Stop and investigate the provider/reorg; do not reset blindly.
- **`MAINNET_OWNED_NOTE_CRYPTOGRAPHIC_VERIFIER_REQUIRED`**: the native scan did
  not produce object-bound owned-note evidence. Rerun from a fresh native scan
  and inspect the provider/UFVK results; do not substitute JSON metadata.

## Stop point

The controlled pilot is complete only after two finalized transfers and two
clean reconciliations. Until then, keep all spending gates closed and report the
pilot as **BLOCKED**, not as a partial success.
