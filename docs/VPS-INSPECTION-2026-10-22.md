# Shared Contabo VPS inspection — 2026-10-22

This is a sanitized read-only inspection of the authorized Contabo host at ZecOne commit `25f0070`. It records no endpoint, credential, environment value, private key, application data, or provider secret. No host file, package, process, firewall rule, container store, or service was changed during the initial inspection.

The approved Stage 1 validation that followed is recorded separately below. The original observations remain as inspected; later installation and build state is described in the validation update.

## Decision

The VPS has enough compute, memory, and root-disk capacity for ZecOne's paused pilot service. Coexistence is **conditionally suitable** after Docker Engine/Compose and `age` are installed, bind-mount ownership is prepared, and ZecOne receives a bounded state filesystem. Port 3410 and the `zecone` Compose namespace are currently unused.

The host is not a strong security boundary from the existing applications. Several PM2 workloads run as root, so compromise of one can read future ZecOne configuration and state regardless of Unix mode bits. The ZecOne container itself mounts only its own config/state/log paths and cannot reach Hermes storage through the proposed Compose definition. Production secrets and all spending keys must remain off-host. Use a separate VPS if the existing root workloads are outside the same trust boundary.

## Stage 1 validation update — 2026-10-22

The separately authorized Stage 1 preparation was completed after the initial inspection. No ZecOne application service or production container was started.

- Docker Engine `29.9.2`, containerd `2.4.2`, Compose `5.6.1`, buildx `0.38.1`, and `age` `1.1.1` were installed. Normal `docker` and `containerd` units remain **inactive**, no normal Docker socket exists, and no production Docker daemon was started.
- The dedicated state filesystem is a 49 GiB loop-backed ext4 mount at `/var/lib/zecone`, with 49 GiB free and ownership `10001:10001` mode `0700`. The mount source UUID, `blkid` UUID, and filesystem marker matched. A non-mounted path was rejected fail-closed by both the operator script and the service.
- Image `zecone-readonly:stage1-1.89` built successfully with Rust `1.89` in an isolated Docker daemon constrained to a 2 CPU / 4 GiB systemd scope. The Rust release build took 5m25s; peak memory was 2.1 GiB; the image is 1.56 GB with ID `sha256:b31c0c1c59c1306768929557ac62feb410c02ada55fd5831a664972a323a6270`.
- The isolated daemon used no bridge, forwarding, masquerading, or iptables management. It was stopped after validation; no isolated socket, container, build process, or daemon remains.
- A disposable container test used a temporary config/state/log tree, not `/var/lib/zecone`. It ran as UID/GID `10001`, with a read-only root, all capabilities dropped, `no-new-privileges`, 128 PIDs, 2 GiB memory, 2 CPUs, and network `none`. Health reported `READ_ONLY`, execution/signing/broadcast/refunds unavailable, operator paused, and disk `PASS`. `POST /healthz` returned `405`; `/operator` returned `404`. Journals persisted across restart. Missing-marker and non-empty uninitialized state tests failed closed.
- A disposable `age` backup and SQLite restore verification passed. The temporary backup identity and encrypted artifact were deleted. No production recipient, off-host destination, or backup identity was created.
- Nginx PID `1071`, Redis PID `317768`, Hermes PID `1050`, Hermes Telegram PID `337574`, and Hermes development proof PID `247496` remained unchanged. PM2 online process PIDs were unchanged. The UFW rule count remained unchanged, and no listener appeared on 3410.
- Root filesystem usage is 114 GiB used / 80 GiB available (including 6.5 GiB of Docker build/image state). `/var/lib/zecone` contains only the filesystem marker and `lost+found`; `/etc/zecone` contains the read-only templates and `/var/log/zecone` is empty.

## Observed host state

- Ubuntu 24.04.4 LTS, x86-64, kernel 6.8.0-147; uptime was 3 days 7 hours.
- 6 logical AMD EPYC CPUs; load averages were 0.08, 0.10, and 0.09.
- 11 GiB RAM, 9.6 GiB available, no swap.
- Root filesystem: 193 GiB total, 57 GiB used, 137 GiB available; inode use 3%.
- Hermes development data is a separate 12 GiB loop-backed ext4 filesystem with 4.1 GiB free. ZecOne must not use that filesystem.
- At the initial inspection Docker Engine and Docker Compose were absent. Podman 4.9.3 was present. Docker Engine and Compose were installed later for Stage 1; see the validation update.
- Node 22.22.2, npm 10.9.7, Rust 1.75, Cargo 1.75, Git 2.43, curl, jq, and sqlite3 are present. Host Node/Rust versions do not affect the container build, which pins Node 24.12.0 and Rust 1.89.
- At the initial inspection `age` was absent. `age` 1.1.1 was installed later; see the validation update. No restic, Borg, Borgmatic, Duplicity, or rclone command was found.
- No application backup timer was found. Only the standard package-database backup timer matched. Provider-managed Contabo snapshots could not be verified from the guest.
- UFW is active with default inbound deny and outbound allow. SSH, HTTP, HTTPS, and port 3000 are allowed publicly for IPv4 and IPv6. ZecOne does not need a new inbound rule because 3410 is loopback-only.
- Port 3410 is free. Nginx owns public ports 80/443. SSH owns 22. Redis is loopback-only on 6379. Existing applications use loopback ports 3000, 8642-8643, and 8787-8793.
- Hermes, Hermes Telegram, and one Hermes development proof are active systemd units. Their combined observed memory was about 480 MiB. Each production Hermes unit has a 2 GiB memory cap, 1 CPU quota, and 128-task cap; the development proof has a 1 GiB cap and 0.75 CPU quota.
- PM2 has eight online processes/modules using roughly 1.0 GiB combined at inspection time and several stopped entries. These root-owned PM2 apps have no demonstrated aggregate cgroup cap.
- Two Hermes development proof units and the network wait-online unit were already failed. The active Hermes units were healthy; no service was restarted.
- At the initial inspection `/opt/zecone`, `/srv/zecone`, `/var/lib/zecone`, `/etc/zecone`, Docker `zecone` resources, and the `zecone` Compose project did not exist. Stage 1 later created the staging source tree, mounted `/var/lib/zecone`, and initialized `/etc/zecone` and `/var/log/zecone`; no production container or application state was created.
- UID and GID 10001 are unused. The host uses cgroup v2, which supports the planned CPU, memory, and PID controls once Docker is installed.

## Conflict and isolation assessment

The Compose project name is explicitly `zecone`; the service is `readonly`; and it uses bind mounts dedicated to ZecOne. There is no current container, volume, network, path, or port collision. Nginx remains untouched. The container is capped at 2 CPUs, 2 GiB memory, 128 PIDs, and a 64 MiB tmpfs; its root filesystem is read-only, all capabilities are dropped, and logs are bounded to five 10 MiB files.

CPU, memory, PID, and log limits protect Hermes from the ZecOne container. Disk starvation is not fully prevented by Compose because the persistent state bind mount has no byte quota. Before scanner activation, place `/var/lib/zecone` on a dedicated fixed-size filesystem or enforce a filesystem/project quota. Allocate 40 GiB minimum and preferably 50-60 GiB, retain at least 40 GiB free on the root filesystem, alert below 15 GiB free, and fail closed below 5 GiB.

The inspection found a local setup defect: `zecone-vps init` previously created root-only bind mounts that UID 10001 could neither read nor write. The operator script now assigns state/log ownership to 10001:10001 and root-owned configuration to root:10001 with read-only group access. This change affects only future operator invocation; nothing was run on the VPS.

## Required installation after approval

Install Docker Engine from Docker's signed Ubuntu repository with the Compose and Buildx plugins. Install `age`; keep the already installed `ca-certificates`, `curl`, `jq`, `sqlite3`, UFW, OpenSSH, and unattended upgrades. Do not install host Node or Rust for ZecOne. Verify that UID/GID 10001 is unused before initialization:

```bash
getent passwd 10001 || true
getent group 10001 || true
docker --version
docker compose version
age --version
```

An operator-approved installation should follow Docker's current Ubuntu repository instructions, then install these package names:

```bash
sudo apt-get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin age
```

Do not add a firewall rule for 3410. Consider restricting SSH to the operator's fixed address or VPN and review why public port 3000 is allowed; those are separate host changes requiring explicit approval.

## Exact deployment sequence after approval

Use a reviewed source checkout at `/opt/zecone/app`; configure host paths outside the checkout. The following commands are the approval-stage sequence and were not executed:

```bash
sudo install -d -o root -g root -m 0755 /opt/zecone /opt/zecone/app
cd /opt/zecone/app
git fetch --all --prune
git checkout --detach <reviewed-commit>
cp deploy/.env.example deploy/.env
sed -i 's#^ZECONE_STATE_DIR=.*#ZECONE_STATE_DIR=/var/lib/zecone#' deploy/.env
sed -i 's#^ZECONE_LOG_DIR=.*#ZECONE_LOG_DIR=/var/log/zecone#' deploy/.env
sed -i 's#^ZECONE_CONFIG_DIR=.*#ZECONE_CONFIG_DIR=/etc/zecone#' deploy/.env
deploy/zecone-vps init
docker compose --project-directory deploy -f deploy/compose.yaml config --quiet
deploy/zecone-vps build
deploy/zecone-vps validate
deploy/zecone-vps start-readonly
deploy/zecone-vps health
docker inspect zecone-readonly-1 --format '{{json .State.Health}}'
docker stats --no-stream zecone-readonly-1
ss -ltnp 'sport = :3410'
curl --fail http://127.0.0.1:3410/readyz
```

Prefer building in trusted CI or on a trusted workstation and deploying an image pinned by digest. A VPS build is acceptable for the pilot only after Docker installation and with Hermes monitored, because Rust compilation can temporarily consume more CPU, memory, and disk than the runtime limits.

## Health, monitoring, backup, and rollback

Health checks must confirm `READ_ONLY`, execution/signing/broadcast/refunds unavailable, operator pause active, provider/network checks fail closed, and disk above thresholds. Monitor container health/restarts, root and ZecOne filesystem bytes/inodes, SQLite errors, provider disagreement, stale scans/quotes, and uncertain journal rows. Keep cross-chain identifiers, addresses, UFVK data, signed bytes, and provider credentials out of metrics.

Create an offline `age` identity and place only its public recipient on the VPS. Schedule `deploy/zecone-vps backup` to an encrypted off-host destination and regularly run `restore-test` on the offline operator computer. Existing host backups are insufficiently evidenced; do not rely on them.

Rollback for the initial read-only deployment is:

```bash
cd /opt/zecone/app
deploy/zecone-vps pause DEPLOYMENT_ROLLBACK
deploy/zecone-vps stop
docker compose --project-directory deploy -f deploy/compose.yaml ps
```

Stopping ZecOne does not touch Nginx, PM2, Redis, Hermes, its loop device, or any existing systemd unit. Preserve `/var/lib/zecone` and encrypted backups until journal reconciliation is complete. Do not delete state during rollback.

## Readiness gate

The isolated image build and disposable runtime/backup tests now **PASS** on the VPS. The host is ready for an operator-approved **read-only deployment**, but no production container has been started. Automatic deployment, public exposure, and mainnet execution remain blocked. Production backups remain blocked until an approved public `age` recipient and real off-host destination are configured. Production configuration still requires operator-provided provider endpoints and UFVK data, and mainnet signing remains off-host and disabled.
