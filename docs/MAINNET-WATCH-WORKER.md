# ZecOne mainnet watch-only worker

**Status:** implemented and locally tested; production activation remains disabled.

The worker turns the existing one-shot authenticated block exporter and native Orchard scanner into a restart-safe read-only loop. It cannot sign, submit, broadcast, refund, or accept an HTTP mutation. The VPS still exposes only `GET /healthz` and `GET /readyz` on loopback.

## Safety model

- `deploy/config/mainnet-watch-worker.json` ships with `enabled: false`.
- Compose also defaults `ZECONE_WATCH_WORKER=0`. Both the reviewed config and the operator environment must be changed deliberately.
- The Zcash settlement policy requires at least 20 confirmations. `exportMinimumConfirmations` defaults to 10 and is pinned into every export manifest, so raw evidence is retained for recent payments before they become settlement-authorized.
- Every exported block must be byte-identical from two declared raw-block operators and agree with two independently declared lightwalletd endpoints.
- The worker retains a full authenticated raw-block corpus from the fresh watch wallet's birthday. Set `startHeight` to the exact imported wallet birthday. A value of `1` is a disabled placeholder and is operationally unsuitable.
- A filesystem lock prevents concurrent cycles. A lock left by an abnormal process exit is not silently stolen; an operator must first prove no worker remains, inspect the checkpoint and corpus, and remove only that lock.
- Checkpoints are fsynced and atomically replaced on the Linux production host only after export, promotion and native scanning all succeed.
- Each restart rechecks the previously accepted height through both lightwalletd providers. A changed hash is `WATCH_REORG_DETECTED` and stops advancement.
- Provider disagreement, corrupt checkpoints, corpus conflicts, stale scans and exhausted retries fail closed.
- Logs and health responses contain only finite error codes and aggregate heights/ages. They omit addresses, transaction IDs, memos, viewing keys, order IDs and payment-to-recipient joins.

The current raw-block verifier checks proof of work, header/target validity, transaction Merkle inclusion and segment continuity. It does not implement full Zcash consensus validation or recompute every ZIP-244 commitment. This remains an explicit capped-pilot trust limitation.

## Required files and configuration

The production operator must create reviewed copies outside Git:

- `/etc/zecone/mainnet-public-probes.json`: two independent lightwalletd operators and two independent raw-block exporters. Provider credentials remain environment references; never put tokens in JSON.
- `/etc/zecone/mainnet-watch-worker.json`: exact wallet birthday as `startHeight`, `minimumConfirmations` of at least 20, `exportMinimumConfirmations` of at least 10, bounded batch/retry/lag settings, and `/var/lib/zecone/watch-profile` as the wallet directory.
- `/var/lib/zecone/watch-profile`: imported UFVK-only profile. It must not contain a seed or spending key.
- `ZECONE_REQUIRED_STATE_FS_UUID`: the dedicated mounted filesystem UUID. The service now refuses startup when it is absent, mismatched, or lacks the exact marker.

The raw providers currently use `ZECONE_TATUM_API_KEY` and `ZECONE_GETBLOCK_URL`. Supply them through the protected service environment on the host. Health output never returns them.

## Pre-activation rehearsal

Run these against a disposable copy and a reviewed image:

```bash
node --experimental-transform-types scripts/mainnet-watch-worker.ts status \
  --config /etc/zecone/mainnet-watch-worker.json

ZECONE_READ_ONLY=1 node --experimental-transform-types \
  scripts/mainnet-watch-worker.ts once \
  --config /etc/zecone/mainnet-watch-worker.json
```

The one-shot run must report `providerAgreement: PASS`, the expected authenticated height, acceptable lag and no error. It performs network reads and writes only watch state; it has no signing or broadcast code.

Before enabling the continuous loop:

1. Confirm the imported address, UFVK fingerprint and birthday on the offline provisioning record.
2. Confirm both endpoint pairs represent independently operated providers.
3. Complete a second-day provider comparison.
4. Estimate raw-block storage from the birthday to the expected demonstration height. Do not activate if the 50 GiB filesystem cannot retain the corpus plus journals and backup staging.
5. Create and restore an encrypted watch-profile backup on a separate machine.
6. Set `enabled: true` in the protected worker config and `ZECONE_WATCH_WORKER=1` in the deployment environment.
7. Rebuild and validate the immutable image before a controlled restart. Do not modify the running container.

## Health and monitoring

`/healthz` and `/readyz` report provider agreement, remote tip, authenticated target and last authenticated heights, both chain and evidence lag, scan age, a finite error code, backup age and verification flags, emergency pause, and permanent false execution/signing/broadcast/refund flags. Thresholds come from the validated worker configuration. They return no payment identifiers or addresses.

When enabled, stale scanning, excessive lag, disagreement or any persisted worker error makes readiness fail with HTTP 503. External monitoring must alert on scan age over 15 minutes, lag over two finalized blocks, any disagreement, disk below 5 GiB, backup age over 24 hours, missing off-host/restore verification, repeated restarts, or a worker error. Metrics must remain aggregate.

## Pause, recovery and rollback

An emergency pause remains durable for Base and Solana submission journals and the operator lease. Stop the watcher by setting `ZECONE_WATCH_WORKER=0` and performing a reviewed container restart; do not delete its checkpoint or corpus.

For disagreement, reorg, corrupt checkpoint, corpus conflict or abandoned lock: keep execution paused; stop the container and prove no worker exists; preserve restricted checkpoint/manifests/log evidence; reconcile the accepted hash independently; restore a verified backup or follow an approved repair; then run one `once` cycle before restarting. Never roll a journal or checkpoint backward without reconciliation.

Rollback uses the previous immutable image and the same state mount. If it cannot read the state schema, keep it stopped and inspect a restored copy in another directory.

## Backup scheduling

`deploy/zecone-vps backup NEW_OUTPUT` creates a locally encrypted snapshot and records `LOCAL_ENCRYPTED_BACKUP_ONLY`. It intentionally leaves off-host and restore-drill verification false:

```bash
ZECONE_BACKUP_RECIPIENT_FILE=/etc/zecone/backup-recipients.txt \
  deploy/zecone-vps backup \
  /srv/zecone-backups/zecone-$(date -u +%Y%m%dT%H%M%SZ).tar.age
```

An operator-controlled systemd timer may call that command. Its `OnFailure` target must notify the actual operations channel. The repository does not invent an off-host destination, uploader credential or alert service. Production backup readiness remains **BLOCKED** until an encrypted artifact is copied to a different machine/account, retention is applied, and `deploy/zecone-vps restore-test` succeeds there.

## Remaining operator blockers

- Fresh mainnet UFVK/watch address and exact birthday.
- Approved independent production providers and protected credentials.
- Storage sizing for the birthday-to-tip raw corpus.
- Second-day live provider agreement evidence.
- Actual off-host backup, retention, alert routing and restore drill.
- An immutable reviewed image digest and clean release commit.
- Production pricing, recipients, funded relayers and a physically isolated signer device.

Mainnet execution now accepts only an externally signed bundle. The online operator and VPS must never receive `--keystore`, `--passphrase-file`, a relayer private key or an approval secret.
