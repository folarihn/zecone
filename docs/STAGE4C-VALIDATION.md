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
- **Authenticated Tatum export — PASS.** Two ten-block segments, heights
  3,526,778–3,526,787 and 3,526,745–3,526,754, passed exact Tatum/Blockchair
  agreement and all local checks. The authenticated endpoint returned HTTP 200
  with no 429 during either export.
- **GetBlock export — PASS.** Heights 3,526,768–3,526,777 passed exact
  Tatum/GetBlock byte agreement and all local checks. A one-block test at height
  3,526,807 also passed. Blockchair is development-use only and was replaced by
  GetBlock in the sanitized probe configuration.
- **Provider independence — UNVERIFIED.** GetBlock resolves to AS44051 Fornex
  Hosting and Tatum to AS396982 Google Cloud. The operators, domains, IPs, ASNs
  and response stacks differ, but shared upstreams and administrative
  independence have no attestation. Both free tiers have no ZecOne SLA.
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
production providers. The selected lightwalletd configuration remains zec.rocks
and Stardust in `deploy/config/mainnet-public-probes.json`.

## Authenticated Tatum and GetBlock exports

The operator-owned Tatum key was read from the header-formatted secret file and
parsed in-process; it was never printed, logged or written to evidence. Tatum
returned HTTP 200 with `x-ttm-plan: free;ratelimit=3;strategy=shared`. Two
ten-block exports completed without HTTP 429:

- `3,526,778–3,526,787`: minimum 31 confirmations, accumulated work
  `18b1ed3b5e35`, start hash
  `000000000042bbe5062a40e59811f57ac63f9eae8c0223d6cecbd09f3467d919`.
- `3,526,745–3,526,754`: minimum 71 confirmations, accumulated work
  `186060d4d397`.

Both segments had exact Tatum/Blockchair raw-byte agreement, matching header
hashes, passing Equihash `(200,9)` proof of work and target checks, matching
transaction Merkle roots and contiguous previous-hash links.

GetBlock was then validated against Tatum. A one-block test at height
`3,526,807` returned 19,566 bytes with SHA-256
`ec17bfcdda29e182b10df119ebef26ad99b3068f00055071c7fdeb031b203841`; both
providers returned identical bytes. The ten-block export at heights
`3,526,768–3,526,777` had minimum 51 confirmations and accumulated work
`18c36117bf61`; every block passed exact agreement, proof of work, Merkle root
and continuity checks. The first authenticated attempt at the tip failed closed
with `zcash_export_block_insufficient_confirmations`; starting at least 40
blocks below tip avoided lightwalletd lag.

GetBlock is a free shared endpoint with a documented 50,000 Compute Units per
day, 20 RPS and two access tokens. A sequential five-block probe returned the
expected byte lengths, and a further burst returned HTTP 200 with no rate-limit
headers or 429. The free plan is positioned for prototypes and testnet work,
has no extra CU purchase and is explicitly excluded from GetBlock's SLA. It is
technically sufficient for this read-only validation, not production
acceptance.

The sanitized configuration uses
`https://shared.eu-central-1.getblock.io` plus `endpointEnv:
"ZECONE_GETBLOCK_URL"`. The credential-bearing URL remains only in
`%USERPROFILE%\ZecOne-mainnet-pilot\secrets\zcash-rpc-secondary-url.txt`.
Runtime resolution requires an HTTPS URL on the declared host and rejects
userinfo, query strings, fragments and host changes. No token is stored in Git.

External evidence directories:

- `%USERPROFILE%\ZecOne-mainnet-pilot\evidence\authenticated-10-first-20261022T153055Z`
- `%USERPROFILE%\ZecOne-mainnet-pilot\evidence\authenticated-10-second-20261022T153204Z`
- `%USERPROFILE%\ZecOne-mainnet-pilot\evidence\getblock-10-20261022T154219Z`

A credential scan found zero occurrences of the Tatum key across the generated
evidence files. The GetBlock URL was not written to evidence. Exact dual-source
bytes plus PoW and Merkle checks still do not recompute ZIP-244 authorizing-data
or chain-history commitments locally.

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

The earlier anonymous ten-block attempt at height `3,526,765` failed closed when
Tatum returned HTTP 429 and the exporter removed the incomplete directory. The
later authenticated exports above resolved that anonymous rate-limit gate for
read-only evidence. A second successful export day is still required.

## Provider independence

zec.rocks and Stardust publish different operator names, and the live responses
agreed on tip, block hash and Orchard tree root. Cake Wallet and Zcash Explorer
were reachable as additional fallback candidates. These facts support
operational diversity but do **not** prove separate administrative control,
hosting, failure domains, logging policy or resistance to coordinated
misbehaviour. No SLA exists. Do not describe the pair as production-approved.

For raw blocks, GetBlock resolves to AS44051 Fornex Hosting in Frankfurt and
Tatum to AS396982 Google Cloud. The operators, domains, IPs, ASNs and response
stacks differ, and GetBlock serves Zebra JSON-RPC. This is stronger than a
same-host pair but still only supports **operator-level** independence. Shared
upstreams, administrative control and coordinated-failure resistance remain
**UNVERIFIED**; both free tiers are excluded from their providers' SLAs.

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
rule was changed. The ten-block exports were run from the operator workstation;
running the exporter on the VPS is not yet deployed or validated.

## Safety result

No production UFVK, seed, wallet, owned note, payment, order, signature,
broadcast or refund was created or accessed. No VPS service was restarted and
no host file was modified. No paid service or account was created. Mainnet
execution remains disabled.

## Operator gates

Before a production watch-only wallet or payment acceptance:

1. Keep the authenticated Tatum key and GetBlock URL in operator-only secret
   storage, with automatic upgrades disabled, and pass a representative
   ten-block segment twice on different days without rate-limit failure. The
   same-day Tatum and GetBlock segments pass; the second day is still required.
2. Obtain production provider terms and upstream-independence evidence, or
   explicitly accept the documented free-tier no-SLA risk. Verify fallback
   endpoints before cutover.
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
