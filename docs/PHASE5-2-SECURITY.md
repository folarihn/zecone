# Phase 5.2 security boundaries

2026-10-15. **Testnet only. Production refunds disabled. Physical signer isolation not validated. Mainnet readiness: NO.**

## Quarantine and fresh custody

The unresolved earlier 0.002 TAZ request remains frozen with all database bytes and recovery markers preserved. No old seed, wallet API, input, retry or expiry assumption was used. New credentials come from the existing native OS-random provisioner, with exclusive directory/file creation. Profile IDs, database paths and payment/refund request IDs are separate. Native payer/export commands reject legacy paths before seed/database/network access.

The user externally funded new Wallet A. Its selected input is the newly received note from the recorded funding transaction. Shielded external funding does not reveal its upstream ownership; the funding source's independence relies on the user's compliance with the instruction to avoid the quarantined wallet. ZecOne did not select or spend any historical input.

New seeds and spending keys use the existing verified scrypt/AES-GCM envelope. Mutable secret buffers are cleared where supported. Only new plaintext staging files are deleted after successful encryption; old credentials are not migrated or deleted. Perfect erasure of runtime/OS copies is not claimed.

## Backend and signer separation

The backend configuration points only to B's watch wallet and contains no spending-key paths or signing method. A separate watch database supports signer-owned evidence. New B spending authority stays in the local signer credential directory. There are no refund-signing HTTP routes or enabled production broadcast methods.

**All processes still run as the same Windows user.** Development passwords are stored beside their encrypted test keys. A process with that user's access can read both. Directory separation and encryption in this setup do not establish effective independent custody. The existing live-chain signing gate remains closed.

Future physical validation must establish key custody, trusted evidence, request approval, execution interlock and recovery on the separate device. Copying a development key to a second computer alone does not establish exclusive original custody. Any future key relocation/removal requires explicit deployment review.

## Payer-only transaction authority

The new native A operation accepts its seed only through bounded local stdin, checks the derived UFVK against the fresh A viewing key, and uses a fixed profile directory and fixed payment recipient/amount/fee ceiling. It never loads B's seed. Signing A's payment is separate from refund signing authority.

A durable preconstruction marker records the intended fee and explicit expiry before proving. Canonical raw bytes, actual expiry and transaction ID are persisted/flushed before submission. The approved review digest binds network, profile/request IDs, recipient, amount, fee, expiry and bytes hash. The native layer also parses the persisted transaction and checks its exact ID/expiry before the exclusive broadcast claim and RPC call.

Only one approved payment was submitted. A durable claim survives lost acknowledgements and blocks repeated submission. Public inspection does not resubmit. Provider acceptance is not confirmation; settlement requires the mined receipt and ten confirmations. A transaction mined before expiry remains mined after that height.

## Recovery and evidence

The isolated test ledger uses the existing lifecycle and CAS transitions. It binds the immutable request and prepared transaction. Receipt verification requires matching identity, exact payment, fresh complete scans and ten confirmations. Scanner disagreement or changed mined receipt fails closed. A controlled preconstruction fault records recovery and a permanent execution veto; restart/duplicate processing retains that veto.

This is a local fault-injection assertion, not evidence of an EVM revert or proof that arbitrary undisclosed EVM transactions cannot exist. No EVM construction key or executor is active in this test profile. The profile is a separate operator harness, not a migration of the running product's historical order ledger.

Both successful B scans use zec.rocks. Their agreement and native ciphertext/witness checks are meaningful wallet evidence but do not constitute independent-provider or full consensus verification. ECC/ZEC.PRO probes returned no usable corroboration. A separately operated validating testnet node is the stronger alternative.

## Real-note unsigned PCZT

The dedicated watch export accepts only the new B backend path, a confirmed recovery order and veto, and the exact unspent single Ironwood payment. It bounds the refund to 90,000 with 10,000 fee and ten confirmations. Every transparent, Sapling and legacy Orchard bundle is rejected. The PCZT includes commitments/witnesses and encrypted output details but no spending key. Private note data stays in gitignored transfer files.

The pinned backend's `pczt` feature requires SDK transparent-input support and SQLite serde. Those compiled features do not authorize transparent spending or mainnet activity. No registry package version/source/checksum changed; only the watch build features and eleven lockfile dependency edges changed. The original wallet manifests and dependency lock remain unchanged.

The separate reader obtains its own UFVK-derived FVK, current unspent notes and an independently requested tree root at the exact proposed anchor. The existing native verifier checks ownership, input values/nullifiers, witness commitments, encrypted destination outputs, fee/change, immutable NU7 format and expiry. It does not sign. A PCZT export or effects review does not itself establish user/operator authorization or device isolation.

The portable manifest is a review-only integrity inventory, not an approval certificate. Real user/operator certificates and a validated live signing deployment are missing. The existing native real-chain signer rejection and disabled refund broadcaster have not been weakened. No REFUNDED state, refund transaction ID or destination receipt has been fabricated.

## Privacy and audit

Public evidence contains test addresses, transaction references, statuses, fees, hashes and counts. UFVKs, seed/key/password values, note nullifiers and PCZT bytes are excluded. The private transfer request contains note-linked evidence and must remain private. A light server can observe scan timing and source IP; publishing test payment/refund associations sacrifices privacy for this explicit demonstration.

Preservation records hashes for 19,946 historical private files and 393 public files and verifies fourteen private database-file snapshots. Known-secret checks compare the new credentials' encodings against publishable changes in memory. These scoped checks do not prove every conceivable secret representation is absent. Audit exports do not unlock the quarantined wallet or authorize a refund.

The live refund remains blocked until physical custody, complete authorization and deployment/broadcast/reconciliation checks pass. Stop at this gate; do not weaken it to obtain a demonstration transaction.
