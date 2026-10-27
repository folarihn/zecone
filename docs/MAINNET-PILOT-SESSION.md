# Single-use Base pilot session

Production quote limits remain unchanged (60-second default, 120-second maximum).
Only an active Base single-device pilot explicitly configured with
`pilot.quoteValiditySeconds: 300` can use a maximum 300-second quote. Its original
pricing statement remains signed and bound to the exact profile, amount and fees.
No expired plan, signing approval, execution authorization,
signature, watch grant, or SQLite status becomes fresh merely by reopening it.

The new operator CLI keeps the two human reviews in one interactive terminal.
It performs the expensive authenticated native scan and recipient ownership
challenge before fetching a fresh price. Pricing, exact preparation, unsigned
simulation, signing review, offline signing, signed-bundle verification,
broadcast review and the existing one-shot executor then run consecutively.
Independent Base reads run concurrently. The native grant stays in the same
process; it is never reconstructed from a JSON snapshot or SQLite status.

## Commands

Copy `config/mainnet-pilot-session.example.json` into a protected operator folder
and supply the reviewed production paths and immutable native order binding.
State and signer ledgers must live outside the repository, on the protected
operator volume. Retain the existing signer ledger, expired signed bundle and
retired transaction hash. Never delete signature history to make a check pass.

```powershell
npm run mainnet:pilot-session -- --check --config <reviewed-config.json>
```

`--check` loads no signing key, performs read-only Base RPC and settlement-journal
checks, and reports whether Zcash execution is enabled. It does not claim that
native payment authorization has passed. Only when every gate is resolved may
the operator start an interactive session:

```powershell
npm run mainnet:pilot-session -- --run --config <reviewed-config.json>
```

For live-data verification without a payout signature or execution approval:

```powershell
npm run mainnet:pilot-session -- --dry-run --config <reviewed-config.json>
```

This mode uses the same native proof, pricing, exact prepare, unsigned simulation,
ownership, liquidity, nonce and policy adapters. The coordinator stops before
either approval callback or payout signer. It creates no pretend signed bundle
or executable broadcast approval, consumes no settlement and leaves the controls
paused. The complete two-approval state machine, including simulated signing and
submission boundaries, is covered separately by synthetic tests.

Starting a session grants no signature or broadcast approval. The CLI refuses
noninteractive input. At each prompt it displays the exact chain, recipient,
amount, maximum debit, fee ceiling, source commitment, expiry, terms digest and
prepared digest. The second prompt also displays the signed transaction hash
and signed digest. No future amount is approved in configuration.

## The two required approvals

1. Type `SIGN <session-id> <review-digest>` exactly as displayed after preparation.
2. After signed validation, independently type
   `BROADCAST <session-id> <review-digest>` exactly as displayed.

Each review digest is SHA-256 of the complete displayed approval body, including
its action, session ID and expiry. A signing response cannot authorize broadcast,
and neither response works for another quote or session. The CLI does not accept
approval files, environment variables, flags, earlier chat authorizations or
generic yes responses as substitutes for these two interactive replies.

The exact signing approval is passed to the existing offline signer process.
Only after the separate broadcast response is accepted does the adapter create
the independent execution-authority signature, arm the lease, resume the
submitter and call the existing executor. Production profile, native provenance,
recipient ownership, signed bytes, nonce, full maximum-debit liquidity, finality,
fee limits and source-consumption checks remain mandatory.

## Expiry, uncertainty and replay

Expiry at either prompt aborts. Expiry during signing retains the signed bundle
and records its transaction identity but never permits broadcast. A later session
requires fresh preparation and both fresh approvals; there is no retry loop.
All historical signed transaction hashes are checked with both providers before
another signing attempt and again before submission. Native payment grants
retain their existing 120-second age limit. If the grant ages out, abort and
perform a new scan before a new price.

A durable session journal locks the source during a running or uncertain attempt.
Before submission it permanently consumes the source conservatively. The existing
submission journal independently enforces its permanent unique source and
transaction indexes, daily limits and one-attempt claim. Unknown signing outcomes
and unknown submission outcomes require reconciliation, never automatic recovery.
The executor rechecks the live expiry immediately after the durable claim and
before its sole RPC submission. Every exit pauses both the lease and submitter.

An expired Ethereum signature remains cryptographically usable on chain; quote
expiry is an application gate. Preserve the old bundle securely and never submit
it or infer revocation from expiry. Nonce changes or either provider finding any
retired transaction force reconciliation before proceeding.

## Resolved source-verification and identity bindings

No transaction was signed or broadcast while implementing this workflow.
Both configured Base providers reported 0.0036 ETH, latest/pending nonce zero,
and no transaction or receipt for the retired hash. No existing mainnet
submission journal was found in the pilot directory.

The production Zcash profile was inherited from the read-only deployment with
`enabled: false`. Its switch controls source-verification authorization in the
operator paths. The authorized fix enables only that source profile. The Base
single-device pilot marker, expiry and limits are unchanged. Submitter resume,
lease arming and execution-authority signing remain behind the separate exact
`BROADCAST` approval; enabling source verification does none of those things.

There are two legitimate digests, not interchangeable encodings of one digest:

- Rust `verify_mainnet_payment` in `services/zcash-watch/src/main.rs` computes
  `ownershipEvidence.digest` with domain `zecone-mainnet-owned-note-v3`, raw
  transaction bytes, little-endian height/pool/index/value, block hash, exact
  payment address, transaction Merkle root, segment end hash and work.
- TypeScript `verifyOwnedNote` in `services/settlement/mainnet-watch.ts` computes
  `paymentDigest` as SHA-256 of the canonical JSON payment binding: network,
  account, exact address, txid, pool/index, amount, height, block hash, both
  providers, confirmation policy and the entire native ownership evidence.

The earlier ad-hoc preparation used the native proof digest as an execution
commitment. The corrected configuration preserves that digest explicitly as
`sourceEvidenceDigest`, pins it into the immutable watch-order binding, and uses
only the independently derived native journal `paymentDigest` for
`sourceCommitment`. The live native verifier derived
`dedcf63826eae9dd57369b4b3e9c77e40b44b0093646608de188917d829beed7`.
The executor still demands exact equality; it accepts no alternate digest or
metadata-only proof. A different deposit, even with the same amount and address,
fails the pinned native evidence check.

The existing import creates an Orchard-only watcher default using
`get_next_available_address`. The incoming note was received at the existing
wallet's all-receiver default. Offline UFVK inspection proved that the complete
note address exactly equals that derived default, both addresses belong to the
same viewing key, and their Orchard receivers are different. They are therefore
distinct authenticated receivers, not assumed-equivalent address strings.

The scanner's optional `--receiving-address` selects an address only from notes
that have already passed native UFVK decryption, exact pool receiver comparison,
Merkle and proof-of-work verification. It exposes the original `defaultAddress`
separately and changes neither the wallet nor its manifest. The journal retains
its strict selected-address equality, account matching and native provenance
requirements. The session, generic watch CLI and operator CLI all pass the exact
approved receiver to that verifier.

The final live-data dry run passed with 43 seconds remaining on its fresh quote.
No payout signature or approval was created. Every actual live session still
starts from a fresh scan, price and exact reviews, and aborts if either human
approval misses the unchanged validity window.

## Extended pilot market gate

The opt-in is restricted to an enabled Base single-device pilot, capped at 300
seconds and its existing pilot expiry. Production feeds and profiles without
this opt-in retain their original limits. Captured observations still require
two distinct sources, the original 90-second acquisition freshness rule and
200-basis-point maximum source spread. The signed snapshot is usable for its
explicit pilot quote window; it is never renewed or altered after approval.

Immediately before submission the executor requires the original signed quote
context and fetches both market sources again. It rejects stale/missing sources,
source disagreement, expired quotes, mismatched transaction bindings or ETH/ZEC
movement in either direction beyond `pilot.marketMovementBps` (at most 200).
Comparison uses exact rational arithmetic, with no rounding allowance at the
boundary. A market read that crosses expiry also aborts. The final live-clock
check remains immediately before the sole submission.

The native payment grant retains its 120-second freshness limit. The session
refreshes the authenticated scan when its age exceeds 60 seconds, including after
human reviews; the same exact evidence and execution commitments must still
match. Extended quote validity never extends a native grant. Revalidation pins
the approved finalized block while checking both providers' current pending
nonces and liquidity. A changed canonical hash or non-finalized anchor fails.

Both exact operator approvals remain mandatory. The pending review is saved as
`review-SIGN.json` or `review-BROADCAST.json` with `approvalGranted: false` for
accurate display in chat; merely writing or reading this file grants nothing.
