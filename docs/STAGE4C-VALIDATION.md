# Stage 4C validation — 22 October 2026

## Decision

The existing Contabo deployment is suitable for a bounded read-only Zcash
verifier, and the public-provider path works for a short cryptographically
verified export. It is **not approved for production payment acceptance**.

- **Two published provider operators — PASS with qualification.** zec.rocks and
  Stardust/ChainSafe agreed at ten confirmations. Additional fallback checks
  against Cake Wallet and Zcash Explorer also agreed. There is still no
  operator attestation, SLA or proof of backend/administrative independence.
- **Three-block export — PASS.** Heights 3,526,768–3,526,770 passed exact
  two-source raw-byte agreement, header hash, Equihash proof of work, target,
  transaction Merkle root, previous-hash continuity and accumulated work.
- **Representative ten-block export — BLOCKED.** Anonymous Tatum returned HTTP
  429 at height 3,526,765. The exporter failed closed and removed its partial
  output. An operator-owned Tatum key or approved full-node exporter is still
  required.
- **Backup mechanics — PASS.** A disposable mainnet watch profile was encrypted
  to a disposable age X25519 recipient, restored and verified with matching
  account, address, birthday and SQLite integrity.
- **Off-host backup — BLOCKED.** No production age recipient, destination,
  credentials, retention policy or alert route exists. No upload occurred.
- **VPS read-only inspection — PASS.** The host and container were healthy. The
  VPS has Node and `age`, but no `rclone`, `b2` CLI or Zcash watch binary.
- **Production acceptance — BLOCKED** pending the operator gates below.

## Live provider evidence

At `2026-10-22T14:55:11.893Z`, zec.rocks and Stardust reported mainnet tip
`3,526,794` and agreed on height `3,526,784` with ten confirmations. The block
hash was
`000000000045a19177def45061c1c7f53c65bcaafcc3252df750ae83ff57785f`,
with four transactions. Tatum and Blockchair returned identical raw bytes,
SHA-256
`190c590f7976f3a01e6df2dd91cf9e9c17a730a1f5407c01bfc05fbd3db23dc8`.
Local proof of work and transaction Merkle verification passed.

Earlier live checks at height `3,526,781` also passed with zec.rocks paired
with Cake Wallet (`zec-node.cakewallet.com`) and with Zcash Explorer
(`lwd.zcashexplorer.app`). Those are fallback candidates, not approved
production providers. The selected configuration remains zec.rocks and
Stardust in `deploy/config/mainnet-public-probes.json`.

## Three-block verified export

The intermediate checkpoint at `2026-10-22T14:51:39.051Z` exported heights
`3,526,768` through `3,526,770` to a new directory outside the repository.
Every block had:

- exact byte agreement from Tatum and Blockchair;
- a matching header hash and transaction Merkle root;
- passing Equihash `(200,9)` proof of work and target validation;
- a previous-hash link to the prior block and accumulated work
  `0x703ef88fa98`.

The three raw-block SHA-256 values were:

- `3d1345f9cec78d34dc92ca22195919a772395f68b7fcbe229383a6afb7cc7f8d`
- `14c253ec1172cd9d8c9f7546a8a6106b629eba4e23feb69cabff7a1a48813dd8`
- `b73a33f14c7d53048e4c1e43a08baa378be80f6634b6d94b4215ffab106b4211`

The limitation is unchanged: ZIP-244 authorizing-data and chain-history
commitments are not recomputed locally. Exact dual-exporter agreement reduces
single-provider tampering risk but is not full consensus validation.

The next ten-block attempt started at height `3,526,765` against tip
`3,526,795`. Tatum returned HTTP 429 and the exporter removed the incomplete
directory. This is the same production reliability gate recorded in Stage 4B.

## Provider independence

zec.rocks and Stardust publish different operator names, and the live responses
agreed on tip, block hash and Orchard tree root. Cake Wallet and Zcash Explorer
were reachable as additional fallback candidates. These facts support
operational diversity but do **not** prove separate administrative control,
hosting, failure domains, logging policy or resistance to coordinated
misbehaviour. No SLA exists. Do not describe the pair as production-approved.

## Backup drill

A disposable synthetic profile containing a mainnet-shaped viewing key,
manifest and SQLite database was encrypted with a newly generated disposable
age X25519 identity. The ciphertext was 12,199 bytes with SHA-256
`44c059c963d871c3f58b47210d8a855b70caf5849a88eb75fe8b5f064b4da874`.
Restore produced a matching account, address and birthday, and SQLite
`PRAGMA integrity_check` passed. The identity, plaintext and restored directory
were deleted after the drill.

This proves the local encryption/restore implementation, not an off-host
backup. No production identity, archive or upload was created.

## VPS inspection

Read-only SSH to `root@37.60.246.170` worked on 22 October 2026. The host
reported 11 GiB RAM with 9.5 GiB available and 77 GiB free on `/`. The dedicated
ZecOne filesystem is 49 GiB. `zecone-readonly-1` was healthy with zero restarts,
image `zecone-readonly:stage1-1.89`, and the health endpoint on
`127.0.0.1:3410` remained `READ_ONLY`, `operatorPaused: true` and
`OPERATOR_SETUP_REQUIRED`.

The host has `node` and `age`, but no `rclone`, `b2` CLI or
`zecone-zcash-watch` binary. `/opt/zecone` contains the staged deployment
source, not a Git checkout. No package, file, container, service or firewall
rule was changed. The ten-block export was run from the operator workstation;
running the exporter on the VPS is not yet deployed or validated.

## Safety result

No production UFVK, seed, wallet, owned note, payment, order, signature,
broadcast or refund was created or accessed. No VPS service was restarted and
no host file was modified. No paid service or account was created. Mainnet
execution remains disabled.

## Operator gates

Before a production watch-only wallet or payment acceptance:

1. Supply a Tatum key with automatic upgrades disabled, or an approved full-node
   exporter, and pass a representative ten-block segment twice on different
   days without rate-limit failure.
2. Obtain provider independence evidence or explicitly accept the documented
   no-SLA public-provider risk. Verify fallback endpoints before cutover.
3. Create the production age recipient on an offline device, provision a
   versioned/object-locked off-host bucket, upload the ciphertext, verify its
   SHA-256 remotely, and complete a restore drill on the offline device.
4. Approve deployment of the exporter/watch binary and any backup uploader to
   the VPS. Do not restart or redeploy ZecOne without a separate approval.
5. Provision the production UFVK and birthday only after the above, then run a
   controlled authenticated owned-note scan. This is a separate approval.
6. Decide whether the capped pilot accepts the ZIP-244/full-node trust boundary
   or requires a full-consensus verifier.

Evidence:

- [Provider/connectivity report](stage4c-evidence/mainnet-connectivity-2026-10-22T14-55-19-342Z.json)
- [Fallback provider probes](stage4c-evidence/fallback-provider-probes-2026-10-22T14-50Z.json)
- [Three-block verified export](stage4c-evidence/mainnet-block-segment-2026-10-22T14-51-39-051Z.json)
- [Ten-block rate-limit failure](stage4c-evidence/authenticated-export-blocked-2026-10-22T14-58-14Z.json)
- [Disposable backup/restore drill](stage4c-evidence/backup-drill-2026-10-22T14-55-50-655Z.json)
