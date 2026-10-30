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
- Funding, signing, and broadcast remain separate, explicit approvals.
- One-shot submission, single-writer lease, emergency pause, and fail-closed
  replay/refund behavior are unchanged.

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
