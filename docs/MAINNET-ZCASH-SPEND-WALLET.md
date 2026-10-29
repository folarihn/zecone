# Mainnet shielded ZEC spending wallet — compatibility and design

**Phase 3 status:** dedicated wallet, synchronization, construction, durable
approval journal, guarded broadcaster, and reconciliation implementation. Real
ZEC broadcast is disabled and was not activated during validation.

## 1. Compatibility report

| Component | Reusable? | Notes |
|---|---|---|
| Zcash watcher (`zecone-zcash-watch`) | Yes (watch-only) | Mainnet UFVK sync, note decryption, 20-confirmation raw-block verification, reorg detection. No spending key. |
| Legacy `services/zcash` spending primitives | Yes (testnet) | `UnifiedSpendingKey::from_seed`, `propose_transfer`, `GreedyInputSelector`, `create_proposed_transactions`, `LocalTxProver::bundled()`, `SpendingKeys` — all network-generic but currently wired to `Network::TestNetwork`. |
| Supported consensus upgrades | Yes | `zcash_protocol 0.11.0-pre.0` + `zcash_primitives 0.31.0-pre.1`; mainnet `BranchId::for_height` and Sapling/Orchard/Ironwood pools (pool 2/3/4). |
| Mainnet transaction construction | Yes | `zip321::TransactionRequest` + `MultiOutputChangeStrategy` (Ironwood change after NU6.3) + ZIP-317 fee rule. |
| Lightwalletd sync | Yes | `zcash_client_backend::sync::run` against `zec.rocks` + `stardust` (both `chain_name == "main"`). |
| Fee calculation | Yes | ZIP-317 `StandardFeeRule` + change split policy; fee ceiling enforced before signing. |
| Signing / broadcast | Yes, gated | `LocalTxProver::bundled()` proves + signs on a disposable wallet snapshot after exact SIGN approval. Official lightwalletd `SendTransaction` is behind disabled-by-default live controls and a separate exact BROADCAST approval. |

### Identity / feature alignment (finding)

The dedicated `services/zcash-mainnet-spend` crate uses the same SDK feature set
as the watcher. It verifies both the SHA-256 UFVK account fingerprint and the
configured watcher address against the unlocked seed before opening the wallet.
The watcher may expose the Orchard-only default while an owned note used the
all-receivers default; the implementation derives and checks those exact public
representations from the same UFVK instead of treating arbitrary unified
addresses as equivalent.

## 2. Secure keystore unlock

`keystore::unlock_seed` (in `services/zcash-mainnet-spend`) reproduces the Node
keystore format exactly:

- scrypt (N/r/p read from the header), 32-byte output;
- AES-256-GCM with the AAD `{"version":1,"format":…,"kdf":"scrypt","N":…,"r":…,"p":…,"cipher":"aes-256-gcm","purpose":…}`;
- constant-failure on wrong passphrase, wrong purpose, or corrupted ciphertext/tag;
- never logs or writes seed material; returns a `SecretVec`.

The passphrase is read **only** from stdin (`mainnet-identity` command), never
from the plaintext passphrase file. Validated against the real keystore: the
unlocked seed derives address `u1qqq8z5wnpx…`, matching `provisioning.json`.

## 3. Live-spend procedure (two approvals)

1. **SYNC** — open the mainnet wallet, sync to tip, and confirm the note is
   mature and canonical. If the original authenticated deposit was spent by a
   prior finalized ZecOne transaction, reconstruct its journal-backed change
   lineage and require the newly selected input to be an unspent descendant.
2. **PROPOSE** — select the owned note, build the shielded proposal, report
   recipient, amount, fee, change, and expiry height for human review.
3. **SIGN approval** (single-use, exact): recipient, amount, fee ceiling,
   internal Ironwood change identity, selected inputs, anchor/target/expiry
   heights, prepared digest, and session expiry.
4. **Construct + prove + sign** — offline, no network submission; the signed
   transaction is encrypted in the durable journal and never printed or passed
   in command arguments.
5. **BROADCAST approval** (single-use, exact): signed transaction digest plus
   the full SIGN session binding, followed by fresh two-provider chain and
   spendability checks and both height/time expiry checks.
6. **Reconcile** — never blind-resend; reconcile the exact txid against two
   lightwalletd peers before any retry.

Every successor spend rechecks the original deposit, each finalized parent
transaction, exact reviewed inputs, wallet-recorded spend edges, mined heights,
change totals and the current unspent input. A note from an unrelated deposit
cannot enter the lineage merely because it belongs to the same wallet.

Mock mode advances the same durable journal using deterministic outcomes but
cannot invoke a network submission. Live broadcast remains disabled unless all
independent live controls are explicitly enabled.

## 4. Deliberately out of scope

1. Activating the real mainnet broadcast control or moving funds.
2. Automatic approval, automatic spending, automatic retry, or automatic replenishment.
3. Off-laptop recovery of the age identity + passphrase (unchanged residual risk).

The CLI requires the keystore passphrase as its first stdin line and never reads
the historical plaintext passphrase file. Initialization obtains the real
birthday tree from two independent TLS lightwalletd providers. Synchronization
allows ordinary tip skew but requires exact tree/hash agreement at the common
height before scanning and at the exact scanned height afterward.
# Phase 3 broadcast and reconciliation

The dedicated wallet now has a durable v3 transaction journal and a real
lightwalletd submission implementation. Real submission remains disabled by
default and was not activated during implementation.

The v3 workflow uses these durable states:

`PREPARED -> SIGN_APPROVED -> SIGNED -> BROADCAST_APPROVED -> SUBMITTING ->
SUBMITTED -> CONFIRMED -> FINALIZED`

Failure and recovery states are `EXPIRED`, `REJECTED`, and `UNCERTAIN`.
`UNCERTAIN` deliberately retains both the encrypted signed transaction and the
source-note reservation. A replacement transaction cannot be prepared until
reconciliation proves the original transaction expired or was rejected.

Signed bytes are encrypted with a wallet-derived, domain-separated key and
authenticated to the unique session ID. They are never accepted in command
arguments and are never printed. Each lightwalletd submission result is stored
separately; provider acceptance is not confirmation. Reconciliation requires
both providers to agree on transaction status, authenticates the mined block
tree, synchronizes wallet state, and checks the source-note/nullifier state.
One live command sends once through the explicitly selected primary or peer
provider. It never automatically retries through the other provider; an
uncertain outcome retains the same encrypted bytes and note reservation.

## Windows commands

Set reusable public paths in the PowerShell window. The passphrase is always
read by the child process from its hidden interactive prompt.

```powershell
$wallet = 'D:\zecone-mainnet\zcash-spend-wallet'
$keystore = 'D:\zecone-mainnet\provisioning\zcash-receiver.keystore.json'
$journal = 'D:\zecone-mainnet\zcash-spend-sessions.sqlite'
$account = 'c89c7cda1189ef6eaac30df339e43b74142e49dfd1340bad213c10e356eac6b9'
$address = 'u13cvyuec8pnfx8ydcm6f3js5quu3nl2pp56ld8z03548w55qv0xhhwz67npgp0ypevusapedw9davchxwe3k7f8jfghsukkl0zghr3zwf'
$common = @('--wallet',$wallet,'--keystore',$keystore,'--expected-account',$account,'--expected-address',$address)
```

Run the commands from the repository root:

```powershell
npm run zec-wallet:status -- @common
npm run zec-wallet:sync -- @common
npm run zec-wallet:prepare -- @common --journal $journal --recipient $address --zatoshis 100000 --max-fee 20000
# Paying a restricted-pilot checkout: bind to its inclusion height and payment deadline.
npm run zec-wallet:prepare -- @common --journal $journal --recipient '<checkout address>' --zatoshis '<exact zat>' --max-fee 20000 --max-expiry-height '<paymentExpiryHeight>' --approval-deadline '<paymentDeadline>'
npm run zec-wallet:sign -- @common --journal $journal --session '<session-id>'
npm run zec-wallet:broadcast -- @common --journal $journal --session '<session-id>' --mode disabled
npm run zec-wallet:reconcile -- @common --journal $journal --session '<session-id>' --confirmations 10
npm run zec-wallet:history -- --journal $journal
```

`--max-expiry-height` lowers the transaction's Zcash expiry to the checkout's
inclusion height, so the network cannot mine it later; preparation refuses a
bound within 3 blocks of the target height (ZIP-203). `--approval-deadline`
caps the approval session at the checkout's payment deadline, so the existing
expiry checks refuse SIGN and BROADCAST after it. Both values are bound into the
prepared and review digests.

For the restricted pilot this journal is the deadline evidence. Chain data
proves only the inclusion height, so the operator sync reads this journal
(read-only) for the exact txid the watcher authenticated: the session must be
bound to the order's deadline and height, and its SIGN, signing and broadcast
attempt must all precede the payment deadline. Otherwise the order goes to
manual review and no payout can be bound. Payments from any other wallet are not
eligible for automatic settlement.

The disabled broadcast command fails before unlocking or consuming approval.
Mock testing uses `--mode mock`. A separately authorized real transfer requires
all of the following in the same command: `--mode live`,
`--enable-live-broadcast`, and a `--broadcast-control` JSON file whose network
is `zcash-mainnet`, `liveBroadcastEnabled` is true, and `emergencyPaused` is
false. The checked-in example remains paused and disabled. SIGN and BROADCAST
still require separate exact interactive approval strings.

