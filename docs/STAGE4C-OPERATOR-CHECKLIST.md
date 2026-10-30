# Stage 4C operator checklist

**Status: production is BLOCKED.** This checklist prepares the read-only
watch-only path. It does not authorize a wallet, payment, signature, broadcast,
refund or VPS change. Obtain explicit approval before each bracketed step.

## 0. Approvals and record keeping

- [ ] Record the reviewed commit and the operator's name/time for every gate.
- [ ] Keep seeds, spending keys, age identities, keystores and passphrases off
  the repository, out of chat and off the VPS. The watch-only UFVK/profile is
  the only private wallet material allowed on the VPS.
- [ ] Use two devices: the VPS/watch host and the offline recovery device.
- [ ] Do not restart/redeploy ZecOne, Hermes, PM2, Nginx, Redis or the dedicated
  Docker daemon without a separate exact command approval.

## 1. Approve and recheck the two providers

The checked public pair is:

- `https://zec.rocks:443` — operator `zec.rocks`
- `https://us.zec.stardust.rest:443` — operator `stardust` (ChainSafe)

They are free public services with no ZecOne SLA. Different names and live
agreement do not prove administrative/backend independence.

- [ ] On the operator workstation, run:

```powershell
npm run mainnet:connectivity -- C:\zecone-evidence
```

- [ ] Require `status: PASS` and `zcash.status: PASS`; preserve the generated
  JSON outside the repository.
- [ ] If either provider fails, test the documented fallbacks
  `https://zec-node.cakewallet.com:443` and
  `https://lwd.zcashexplorer.app:9067` with the Rust probe before changing
  configuration.
- [ ] Record whether the operator accepts the no-SLA public-provider risk or has
  obtained an attestation/SLA. Until then, label the pair **UNVERIFIED
  INDEPENDENCE**, not production-approved.

## 2. Produce a verified raw-block segment

Run this on a trusted operator machine, not the shared VPS. Choose a start
height at least 40 blocks below the current tip; the first authenticated attempt
at tip-minus-10 failed on lightwalletd confirmation lag.

Inject both credentials into the process without printing them. The Tatum file
is header-formatted, so parse the value rather than using the file verbatim.
The GetBlock URL contains an access token; keep it out of Git and shell history.

```powershell
$keyFile = "$env:USERPROFILE\ZecOne-mainnet-pilot\secrets\tatum-key.txt"
$env:ZECONE_TATUM_API_KEY = [regex]::Match(
  (Get-Content -Raw -LiteralPath $keyFile),
  '(?i)apikey\s*:\s*"([^"]+)"'
).Groups[1].Value
$env:ZECONE_GETBLOCK_URL = (
  Get-Content -Raw -LiteralPath `
    "$env:USERPROFILE\ZecOne-mainnet-pilot\secrets\zcash-rpc-secondary-url.txt"
).Trim()
```

```powershell
npm run mainnet:block-export -- `
  --config deploy/config/mainnet-public-probes.json `
  --output C:\zecone-exports\mainnet-20261022T150000Z `
  --start-height <tip-minus-40> `
  --count 10
```

- [ ] Require `status: PASS`, `chainContinuity: PASS`, ten blocks, and no
  `NOT_LOCALLY_RECOMPUTED` field interpreted as full consensus.
- [ ] Run the same ten-block check twice on different days. Tatum and GetBlock
  passed the same-day segments; a second day is still required.
- [ ] Copy only the verified directory and manifest to the VPS after approval:

```bash
scp -r mainnet-20261022T150000Z \
  root@37.60.246.170:/var/lib/zecone/authenticated-blocks/
ssh root@37.60.246.170 \
  "chown -R 10001:10001 /var/lib/zecone/authenticated-blocks/mainnet-20261022T150000Z && \
   chmod -R u=rwX,go= /var/lib/zecone/authenticated-blocks/mainnet-20261022T150000Z"
```

- [ ] Never place raw blocks or the manifest in Git. The VPS does not currently
  have the watch binary or exporter code deployed.

**Gate 2 is PASS for same-day read-only evidence**: authenticated Tatum passed
two ten-block segments and GetBlock passed one ten-block segment. The production
gate remains **BLOCKED** pending a second successful day, production provider
terms, and resolution of the independence/SLA and ZIP-244 trust boundaries.
Blockchair was removed from the probe configuration; it is development-use
only. See [STAGE4B-INFRASTRUCTURE.md](STAGE4B-INFRASTRUCTURE.md) and
[STAGE4C-VALIDATION.md](STAGE4C-VALIDATION.md).

## 3. Create the offline age recipient

On the offline recovery device only:

```powershell
npm run --silent mainnet:watch-backup -- identity `
  --out D:\offline\zecone\zcash-watch-backup.agekey `
  --confirm CREATE_AGE_IDENTITY
```

- [ ] Store `zcash-watch-backup.agekey` in the operator's encrypted credential
  backup. Never upload, copy to the VPS, paste into chat or commit it.
- [ ] Copy only the printed `recipient` (`age1...`) to the VPS as
  `/etc/zecone/backup-recipient.txt`.
- [ ] On the VPS, pin it `root:10001` mode `0640` so the UID/GID 10001 backup
  job can read it, and record its SHA-256:

```bash
umask 077
printf '%s\n' 'age1...' > /etc/zecone/backup-recipient.txt
chown root:10001 /etc/zecone/backup-recipient.txt
chmod 0640 /etc/zecone/backup-recipient.txt
sha256sum /etc/zecone/backup-recipient.txt
```

- [ ] Require the file to contain exactly one `age1...` line. Change control
  must approve any future recipient rotation.

## 4. Recommended lowest-cost off-host destination

Use a **Backblaze B2** private bucket. Current published pricing checked
22 October 2026: first 10 GB free, then **USD 6.95/TB-month**; Class A/B/C API
calls are free; egress is free up to 3x stored data. Do not create an account or
purchase anything until approved.

Cloudflare R2 is a lower-friction alternative (10 GB free, no egress fee), but
its S3 API does not provide versioning or S3 Object Lock. Use it only as a
second copy, not as the sole retention control.

### B2 setup

1. [ ] Create a Backblaze account in the region nearest the operator. The
   account region is fixed; for an EU VPS choose EU Central (`eu-central-003`)
   unless data-residency review says otherwise.
2. [ ] Create a **private** bucket, for example
   `zecone-watch-backup-<random-suffix>`.
3. [ ] Enable versioning (B2 default). Enable Object Lock only if you accept its
   retention behavior. A bucket-wide 30-day Governance lock also retains the
   daily copies for 30 days; use a shorter lock (for example 7 days) or adjust
   the lifecycle expectation. Do not use Compliance Mode unless the operator
   accepts that it cannot be removed.
4. [ ] Create a bucket-scoped application key with only `listFiles`,
   `readFiles` and `writeFiles`. Do not use the master key. Store the key ID and
   application key in the operator password manager, never in Git.
5. [ ] Record the S3 endpoint, for example
   `https://s3.eu-central-003.backblazeb2.com`, and the bucket name.

### Uploader on the VPS

The VPS has Node and `age`, but no `rclone` or `b2` CLI. Install one only after
approval. This example uses `rclone`'s S3-compatible backend:

```bash
rclone config create zecone-b2 s3 \
  provider=Other \
  access_key_id="$B2_KEY_ID" \
  secret_access_key="$B2_APP_KEY" \
  endpoint="https://s3.eu-central-003.backblazeb2.com" \
  region="eu-central-003"
chmod 600 /root/.config/rclone/rclone.conf
rclone lsf "zecone-b2:zecone-watch-backup-<suffix>"
```

Do not put the key values in shell history if avoidable; use the operator's
secret-injection method. The uploader must not run with the master key.

## 5. Create, upload and verify a backup

The commands below assume the reviewed repository is deployed at `/opt/zecone`
and `/var/lib/zecone/backups` exists with owner/mode `10001:10001 0700`. Both are
separate deployment changes requiring approval. Otherwise run the backup CLI on
the operator workstation and upload from there.

The watch profile must be stopped and must not contain `process.lock`. Do not
stop the whole host or ZecOne for this step.

```bash
umask 077
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="/var/lib/zecone/backups/watch-${stamp}.age"
npm run --silent mainnet:watch-backup -- backup \
  --profile /var/lib/zecone/watch \
  --recipient-file /etc/zecone/backup-recipient.txt \
  --out "$archive" \
  --confirm CREATE_WATCH_BACKUP
```

Then upload only the ciphertext:

```bash
bucket="zecone-watch-backup-<suffix>"
key="daily/$(basename "$archive")"
rclone copyto --immutable "$archive" "zecone-b2:${bucket}/${key}"
local_sha="$(sha256sum "$archive" | cut -d' ' -f1)"
remote_sha="$(rclone cat "zecone-b2:${bucket}/${key}" | sha256sum | cut -d' ' -f1)"
test "$local_sha" = "$remote_sha" && printf 'remote sha256 verified: %s\n' "$remote_sha"
```

- [ ] A failed upload must leave the last successful remote object untouched.
- [ ] Never upload the plaintext profile, `viewing-key.txt`, the age identity or
  the keystore.
- [ ] Retain 7 daily, 4 weekly and 12 monthly successful archives. Use bucket
  lifecycle rules for those prefixes and verify the rules with a disposable
  object. Provider snapshots are not an off-host backup.

## 6. Restore drill on the offline device

Do this monthly and before funding anything.

```powershell
rclone copyto "zecone-b2:<bucket>/monthly/<archive>.age" `
  D:\offline\zecone\incoming\<archive>.age
Get-FileHash D:\offline\zecone\incoming\<archive>.age -Algorithm SHA256

npm run --silent mainnet:watch-backup -- restore `
  --backup D:\offline\zecone\incoming\<archive>.age `
  --identity-file D:\offline\zecone\zcash-watch-backup.agekey `
  --out D:\offline\zecone\restore-drill\watch-<stamp> `
  --confirm RESTORE_WATCH_PROFILE

npm run --silent mainnet:watch-backup -- verify `
  --profile D:\offline\zecone\restore-drill\watch-<stamp>
```

- [ ] Compare restored account, address and birthday with provisioning.
- [ ] Require SQLite integrity `PASS`.
- [ ] Destroy the disposable restored copy and plaintext. Never restore over a
  live profile.

## 7. Scheduling and alerts

- [ ] Run the backup after a clean watch stop, daily at a fixed UTC time;
  weekly on Sunday; monthly on the 1st.
- [ ] Use a systemd timer/service or the existing monitoring system. Run the
  backup as UID/GID `10001`, which owns the watch profile and backup directory
  and can read the group-readable recipient file. Do not run the recurring job
  as root unless a reviewed permission change requires it.
- [ ] Configure `OnFailure=` or an equivalent alert. Include only status, UTC
  time and an opaque job/archive ID. Exclude UFVKs, addresses, transaction IDs,
  paths containing secrets and archive contents.
- [ ] Test one deliberate failure (for example, a disposable wrong bucket name)
  and confirm the alert fires without deleting the last successful archive.

## 8. Final production gate

Do not enable payment acceptance or create a production wallet until all are
true:

- [ ] Ten-block export passes reliably with an approved authenticated source,
  twice on different days.
- [ ] Provider independence is attested or the no-SLA risk is explicitly
  accepted; fallbacks are tested.
- [ ] Pinned age recipient, B2 bucket, uploader, remote SHA-256 verification,
  lifecycle/retention and alert are all active.
- [ ] Offline restore drill passes with matching metadata and SQLite integrity.
- [ ] VPS exporter/watch-binary deployment and permissions are separately
  approved and health-checked; no unapproved restart occurred.
- [ ] Production mainnet UFVK, birthday and controlled owned-note scan are
  separately approved and completed.
- [ ] ZIP-244 authorizing-data/chain-history and full-consensus boundary is
  explicitly accepted or a full verifier is provisioned.
- [ ] The operator records a new, exact, capped authorization. No prior approval
  carries forward.

If any check is missing or ambiguous, stop. Keep ZecOne `READ_ONLY`, paused and
execution-disabled.
