# Mainnet operator boundary

**Decision: mainnet execution remains disabled.** The operator CLI, isolated
signer, durable single-writer lease and emergency pause now exist, but no
production credentials, independent providers, signed prices or authenticated
Zcash mainnet observation have been supplied. Do not treat local validation or
fixtures as authorization for a real transfer.

Stage 4B validated the public read-only Zcash path. Stage 4C rechecked the live
providers, passed a three-block cryptographically verified export and a
disposable age restore drill, but the representative ten-block export failed
closed on anonymous Tatum HTTP 429. Before wallet provisioning, follow
[STAGE4C-VALIDATION.md](STAGE4C-VALIDATION.md),
[STAGE4C-OPERATOR-CHECKLIST.md](STAGE4C-OPERATOR-CHECKLIST.md) and
[STAGE4B-BACKUP.md](STAGE4B-BACKUP.md): supply an authenticated raw-block source,
pass a reliable representative export, decide the ZIP-244/full-node trust
boundary, and complete a real off-host encrypted backup and restore drill.
Public probe success does not lift the mainnet pause.

## Commands

All commands are local-only unless the step explicitly reads the configured
providers. None of them prints private keys, passphrases or signed bytes.

```powershell
npm run mainnet:status -- --profiles config/mainnet-profiles.example.json
npm run mainnet:config-check -- --profiles config/mainnet-profiles.production.example.json --readonly config/mainnet-readonly.example.json
npm run mainnet:config-check -- --profiles <profiles.json> --readonly <readonly.json> --probe
npm run mainnet:quote -- context --profiles <profiles.json> --network base --pair ETH/ZEC --amount <units> --network-fee <wei> --l1-data-fee <wei> --service-fee 0 --out <context.json>
npm run mainnet:quote -- quote --profiles <profiles.json> --pricing <pricing.json> --network base --amount <units> --out <quote.json>
npm run mainnet:prepare -- --network base --profiles <profiles.json> --request <request.json> --pricing <pricing.json> --quote <quote.json> --ownership-proof <proof.json> --out <plan.json>
npm run mainnet:simulate -- --profiles <profiles.json> --plan <plan.json>
npm run mainnet:simulate -- --profiles <profiles.json> --plan <plan.json> --bundle <signed-bundle.json>
npm run mainnet:execute -- ... --confirm <exact-terms-digest> --arm ARM_MAINNET_EXECUTION --resume-submitter RESUME_MAINNET_SUBMITTER
npm run mainnet:reconcile -- ... --order <order-id> --arm ARM_MAINNET_EXECUTION
npm run mainnet:pause -- --journal <journal.sqlite> --lease <lease.sqlite> --reason "operator emergency"
npm run mainnet:revoke-signer -- --signer-ledger <signer-ledger.sqlite> --reason "operator revocation"
```

`mainnet:config-check` is non-spending and always reports
`executionAvailable: false`. It checks the three profile networks, independent
HTTPS providers, limits, confirmations, exact destination/relayer addresses,
signer and execution-authority key types, price-authority pins and the
disabled read-only switches. `--probe` additionally runs the closed read-only
identity/finality RPC surface only for real configured endpoints; `.invalid`
and local placeholders are never contacted. Zcash lightwalletd endpoints are
not probed with JSON-RPC; they return an explicit blocked finding because the
transport is gRPC. A complete profile check does not verify provider
independence, device attestation, ownership of a UFVK or production activation.

`mainnet:quote context` produces the exact context that both price authorities
must bind into their signed statements. `mainnet:quote quote` verifies the
authorized keys, network, context, freshness, spread and caps. Neither command
signs or broadcasts.

The exact execute inputs are:

```powershell
npm run mainnet:execute -- `
  --profiles <profiles.json> --plan <plan-with-prepared.json> `
  --confirm <termsDigest> --lease-owner <operator-id> `
  --lease <lease.sqlite> --journal <submitter.sqlite> `
  --watch-journal <watch.sqlite> --watch-binding <binding.json> `
  --watch-wallet <native-watch-dir> --watch-server <https-primary> `
  --watch-peer <https-peer> `
  --watch-authenticated-blocks <external-raw-block-directory> `
  --execution-authorization <execution-authorization.json> `
  --keystore <relayer.keystore.json> --passphrase-file <external-passphrase> `
  --approval <exact-signing-approval.json> --signer-ledger <signer-ledger.sqlite> `
  --arm ARM_MAINNET_EXECUTION --resume-submitter RESUME_MAINNET_SUBMITTER
```

`execute` runs `MainnetWatchScanner` in-process immediately before signing and
does not accept a JSON snapshot file. It derives the scan checkpoint from the
watch journal. The scanner must produce a fresh confirmed owned note in the
current observation window; a copied, older or caller-supplied snapshot is
never accepted.

The exact signing approval is:

```json
{
  "version": 1,
  "termsDigest": "<same prepare terms digest>",
  "preparedDigest": "<same prepared digest>",
  "maximumDestinationDebit": "<prepared capped debit>",
  "expires": 1799999999
}
```

Use `--bundle <signed-bundle.json>` instead of the keystore/passphrase/approval
arguments when a separately operated signer produced the bundle. Inline signing
requires a durable `--signer-ledger` path; `:memory:` is rejected so spending
limits and revocation survive a restart. The owned-note evidence must come from
the in-process trusted scanner in the current observation window; a copied or
older snapshot is never accepted. An expired lease needs
`--recover-expired-lease true` only after the operator has stopped the old
process and reviewed its transaction identity.

`status` is a configuration and local-journal report. It does not claim provider
connectivity, signer attestation or chain finality.

## Execution gates

`mainnet:execute` performs every step in this order:

1. Load the exact plan and reject a changed profile or prepared transfer.
2. Require the literal `--confirm <termsDigest>` for the exact order.
3. Require `ARM_MAINNET_EXECUTION` and `RESUME_MAINNET_SUBMITTER`; neither is a
   default and omitting either performs no signing or submission.
4. Acquire a durable, fenced single-writer lease. An unexpired lease held by
   another owner fails. Recovering an expired lease requires an explicit
   `--recover-expired-lease true`; the old process then fails its next guard.
5. Only after the lease is held, open the purpose-bound relayer keystore and
   create a fresh native payment observation from the trusted scanner output.
6. Sign only the exact prepared digest and terms. The signer enforces its own
   per-transaction and daily ceilings and never accepts arbitrary calldata.
7. Resume the submitter journal only for this armed, exact order, execute the
   one-shot boundary, then pause both the journal and operator control in a
   `finally` block. A crash leaves the lease expired and reconciliation
   required; it must not be replaced automatically.

`mainnet:pause` persists the pause in the existing submission journal and the
independent operator-control database without loading a production profile. New
signing, broadcast and reconciliation then fail closed until an explicit
operator re-arm. A mistyped or missing journal path fails instead of creating a
decoy database. A pause cannot cancel bytes that a provider has already
accepted. `mainnet:revoke-signer` requires the existing signer ledger and
persists a revocation tombstone; subsequent opens and signs fail until the
ledger is deliberately replaced as part of a separately reviewed key-rotation
operation.

## Isolated signer

`services/settlement/mainnet-signer.ts` supports Base secp256k1 and Solana
Ed25519 relayer keys from the encrypted provisioning keystore. The operator must
pass an external passphrase file; no environment-variable or implicit unlock is
supported. The signer:

- requires the exact `termsDigest`, `preparedDigest`, maximum debit and a
  short-lived approval;
- derives the public relayer and refuses a keystore that does not match the
  profile's pinned signer/relayer binding;
- signs only the prepared legacy Base transfer or a Solana message that it
  rebuilds from the exact terms and compares byte-for-byte, rejecting changed
  destination, amount, fee payer, blockhash or extra instructions;
- requires a non-memory ledger path and records a durable digest-only signer
  ledger, enforcing independent per-transaction/daily limits across restarts;
- emits no debug logging and returns no ordinary-user signed bytes.

The keystore password and process boundary do not prove physical device
isolation. A production signer still requires independent attestation and
review.

## Single-writer and recovery

`services/settlement/mainnet-operator-lease.ts` stores one lease row with a
random token, owner, monotonically increasing fence, expiry and recovery count.
Every financial step invokes a guard immediately before journal preparation,
claim and submission. Losing the lease or an emergency pause makes the guard
throw. A stale process cannot reclaim its old fence after another process has
recovered the lease.

An expired lease is not taken over silently. An operator must inspect
`status`, reconcile the existing transaction identity, choose whether recovery
is safe, and then pass `--recover-expired-lease true`. The old process, if still
alive, must be stopped; it will fail its next guard.

A process can die after the journal claim but before recording the broadcast
response. `reconcile` accepts that `claimed` state: if the exact transaction is
finalized it records broadcast evidence and finalizes; if no receipt is visible
it moves the attempt to `uncertain`. It never resubmits the signed transaction
or creates a replacement.

## Zcash trust boundary

The scanner uses the maintained Zcash SDK for wallet sync and independently
fetches the candidate full transaction from two configured lightwalletd
providers. Both must agree on bytes, mined height and the block hash at that
height. The scanner then trial-decrypts the exact output with the imported UFVK
and checks account, pool, output index, incoming type, value and receiver. It
also requires externally staged raw blocks for the payment and bounded
confirmation segment. The complete raw blocks prove transaction Merkle
inclusion and supply headers for Equihash, target, linkage and accumulated-work
verification; both lightwalletd providers must corroborate every block hash.

This is not a local full-node consensus implementation. It verifies complete
block Merkle inclusion and a bounded proof-of-work confirmation segment, while
the approved raw-block source and two genuinely independent
lightwalletd operators remain mandatory, and the scanner executable, provider
configuration, service process and imported UFVK are trusted. If an
authenticated verified-chain-data boundary cannot be supplied, the Zcash side
must remain **NO-GO** rather than treating two RPC responses as consensus.

## Acceptance status

| Area                                   | Status                      | Evidence / remaining blocker                                                                                                                                                                           |
| -------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Operator CLI surface                   | PASS                        | Seven operator subcommands exist; all accept exact local files.                                                                                                                                        |
| Execution disabled by default          | PASS                        | Journal and operator control start paused; exact confirm/arm/resume strings required.                                                                                                                  |
| Exact order binding                    | PASS in fixtures            | Terms, prepared, signed, transaction, network, recipient, cap and expiry are rechecked at the boundary.                                                                                                |
| Isolated Base/Solana signer            | PASS in disposable tests    | Purpose-bound keystore, exact digest approval, local signature verification, limits, revocation and signer ledger.                                                                                     |
| Single-writer lease                    | PASS in disposable tests    | Token/fence lease, expiry recovery, stale guard, pause and release are covered.                                                                                                                        |
| One-shot submission and reconciliation | PASS in fixtures            | Tests cover duplicate, uncertain, crash-left claimed, finalized and no-resend paths.                                                                                                                   |
| Production profile template            | PASS as a disabled template | `config/mainnet-profiles.production.example.json` has two placeholder providers per network and cannot validate as active.                                                                             |
| Production pricing                     | BLOCKED                     | No genuine independently signed price feeds or pinned operator keys are configured.                                                                                                                    |
| Zcash authenticated observation        | BLOCKED                     | Implementation verifies raw-block inclusion and bounded PoW continuity; no approved raw-block source, independent mainnet lightwalletd pair, produced UFVK or controlled owned-note run is configured. |
| Base live acceptance                   | BLOCKED                     | No production RPC operators, relayer funding, signer attestation, fee-fork validation or rehearsal.                                                                                                    |
| Solana live acceptance                 | BLOCKED                     | No production RPC operators, funded relayer, signer attestation or rehearsal.                                                                                                                          |
| Production single-writer deployment    | BLOCKED                     | Lease behavior is fixture-tested; the intended host/volume topology and emergency runbook have not been exercised.                                                                                     |
| Real transaction safety                | BLOCKED                     | No real payment, production unlock, signature, broadcast or refund has occurred.                                                                                                                       |

## First-transaction prerequisites

1. Supply two independently operated mainnet providers for Zcash, Base and
   Solana; verify their network identities and acknowledge independence.
2. Produce a watch-only Zcash profile and obtain a controlled authenticated
   owned-note observation. Record the verified-chain-data limitation or keep
   Zcash blocked.
3. Provision fresh recipient/relayer credentials and a separate Ed25519
   execution authority; validate physical/device separation and recovery.
4. Configure two genuine signed price authorities with fresh,
   network/context-bound statements.
5. Fund only the destination relayers within the documented caps. Confirm
   inventory, fee policy and Base fork behavior.
6. Run unsigned `prepare`/`simulate` rehearsals on both providers.
7. Obtain independent review of the exact plan, signed bundle and execution
   authorization. Then perform one capped operator-mediated run and reconcile
   its exact transaction identity before considering anything else.

Refunds remain disabled. A signed, submitted or uncertain attempt is never
replaced by a fresh transfer or refund automatically.
