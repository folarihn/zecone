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
- Price-authority independence (two distinct Ed25519 operators) is unchanged.
- The 20-confirmation Zcash policy is unchanged.
- The 1800-second Base finality gate is unchanged.
- Exact recipient/amount/fee/digest review is unchanged.
- The 0.02 ZEC source cap and the exact destination allowlist are unchanged.
- Funding, signing, and broadcast remain separate, explicit approvals.
- One-shot submission, single-writer lease, emergency pause, and fail-closed
  replay/refund behavior are unchanged.

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
