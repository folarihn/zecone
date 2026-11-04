# Single-device mainnet pilot — risk acceptance

**Scope:** the first, operator-only, capped Zcash → Base ETH mainnet transfer.

**Effective through:** the pilot expiry recorded in the production profile's
`pilot.expires` field (hard-expired, maximum 30 days). After expiry the profile
fails closed and cannot sign or execute.

## Accepted risk

The production design requires the relayer signer and the execution authority to
run on a physically separate, validated device. This pilot runs both on a single
operator-controlled laptop. The following is accepted explicitly and only for
this one transfer:

- **No device-level signing isolation.** The `mainnet:offline-sign` CLI still runs
  as a separate, network-free process, but on the same OS. A compromise of the
  laptop can reach the signer key, the execution-authority key, the watch UFVK,
  and the broadcast path together. This is a process-level boundary, not a
  device boundary.
- **No device attestation is claimed.** The profile must set
  `signer.separateDeviceValidated: false` and
  `executionAuthority.separateDeviceValidated: false`. The code rejects a pilot
  profile that sets either to `true` (that would be a fabricated attestation).
- **Same-machine operator and broadcaster.** The operator that reviews, signs,
  and broadcasts is a single human on a single machine.

## What is not weakened

- Provider independence (two distinct HTTPS operators per chain) is unchanged.
- Production price-authority independence is unchanged: the two-independent-
  operator Ed25519 path remains mandatory outside this pilot. The pilot instead
  uses the explicitly named `SINGLE_OPERATOR_PILOT_PRICING` policy (one operator,
  two independent market-data providers), which cannot activate without the
  pilot marker, cap, and expiry.
- The 20-confirmation Zcash policy is unchanged.
- The 1800-second Base finality gate is unchanged.
- Exact recipient/amount/fee/digest review is unchanged.
- The 0.02 ZEC source cap and the exact destination allowlist are unchanged.
- Funding remains separate. The default CLI retains separate SIGN and BROADCAST
  approvals. A profile may explicitly set `pilot.oneClickExecution: true` to
  replace them with one exact, localhost-only `SIGN_AND_BROADCAST` approval for
  the same capped pilot transaction.
- One-shot submission, single-writer lease, emergency pause, and fail-closed
  replay/refund behavior are unchanged.

## Optional localhost one-click execution

`npm run mainnet:pilot-one-click -- --config <session.json>` performs the slow
watcher, price, liquidity, nonce, ownership, preparation, and simulation checks
before opening a temporary review page on `127.0.0.1`. The page has no external
scripts, assets, signer material, or public listener. Its unguessable URL accepts
one POST and then closes.

The single button binds the chain ID, recipient, payout, maximum debit, fee cap,
nonce, gas, gas price, prepared block, source commitment, quote expiry, quote
digest, terms digest, and prepared transaction digest.
After approval the operator process signs locally, verifies that the signature
matches the exact prepared transaction, then repeats price, nonce, liquidity,
expiry, duplicate-settlement, and source checks before one broadcast. Any changed
or expired value aborts. A preparation or approval timeout does not consume a
renewed payment binding; the binding becomes single-use immediately before the
signer opens and remains consumed after any signing uncertainty.

This mode is unavailable unless the active Base pilot profile explicitly contains
`oneClickExecution: true`. It does not affect public services, normal production
profiles, or the existing separate-approval CLI.

## Recovery policy (accepted residual risk)

This is a single-laptop personal pilot. The operator has explicitly accepted
that independent disaster recovery is **not established**:

- The age-encrypted keystore archive is in Backblaze B2 (off-device ciphertext),
  and local recovery (keystore reopen, Zcash UFVK re-derivation, Base address
  match) is verified.
- The age identity and the wallet passphrase both reside only on this laptop's
  BitLocker-encrypted D: drive. Neither BitLocker nor the B2 ciphertext alone
  guarantees recovery if the laptop is lost or destroyed, because recovering the
  B2 archive requires both of these on-device secrets.

The off-device-backup requirement is an **operational readiness rule**, not a
code-enforced gate; this pilot records the acceptance above instead of claiming
independent disaster recovery.

## Not enabled anywhere

The `pilot` field is absent from every deploy and example configuration. It is
not read by the browser wallet, the extension, the read-only VPS service, or any
public or settlement worker. It only affects the operator CLI signer/executor
path when explicitly present.

## Hard expiry

`validateProductionProfile`, `mainnetTransferTerms`,
`verifyExecutionAuthorization`, and the offline signer all re-check the pilot
against the current time. An expired, malformed, or missing pilot marker makes
the profile fail closed (`SINGLE_DEVICE_PILOT_INVALID_OR_EXPIRED`).
