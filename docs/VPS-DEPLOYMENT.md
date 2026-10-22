# Contabo VPS deployment — read-only preparation

This package installs ZecOne in a **paused, read-only state**. It cannot sign, broadcast, create payments, execute refunds, or expose an operator endpoint. Production activation is a later, separately approved operation.

## Deployment shape

The Ubuntu VPS runs one container initially: `zecone-readonly`. It validates mounted public configuration, creates fresh empty submission journals, forces the Base and Solana journals and operator lease into `VPS_READ_ONLY_MODE`, and serves only `/healthz` and `/readyz`. The container uses the host network namespace but binds health to `127.0.0.1` only. The dedicated Docker daemon has no bridge, published ports, iptables management, forwarding, or masquerading, so TCP 3410 is never publicly reachable.

The image contains the Node service code and the compiled watch-only Zcash scanner. The initial service does not schedule scans or execute orders. Operators invoke read-only configuration checks and controlled watch scans over SSH after provider and UFVK setup. No production spending key, seed, signer passphrase, backup identity, or refund key belongs on the VPS.

Persistent paths are:

- `/var/lib/zecone`: new production control, submission, watch, and financial journal state.
- `/etc/zecone`: root-owned configuration mounted read-only into the container.
- `/var/log/zecone`: reserved application log directory. Container stdout uses Docker's bounded `local` log driver.
- `/tmp`: 64 MiB in-memory, `noexec`, `nosuid`, and `nodev`.

Historical development journals must never be copied into `/var/lib/zecone`. First boot refuses a non-empty uninitialized state directory. The deployment marker is created before the fresh paused databases.

## VPS sizing

Use Ubuntu 24.04 LTS x86-64. A practical pilot minimum is 2 vCPU, 4 GiB RAM, and 40 GiB free SSD after the OS and Docker images. The recommended low-cost configuration is 4 vCPU, 8 GiB RAM, and at least 80 GiB available storage. The running container is capped at 2 vCPU and 2 GiB RAM. Building the Rust image on the VPS needs more temporary disk and memory; building in CI or on a trusted workstation and deploying a pinned image digest is preferable.

Zcash wallet/cache growth depends on wallet birthday and chain activity. Treat 40 GiB as an initial allocation rather than a permanent bound. Alert below 15 GiB free and stop new scans/execution below 5 GiB. The health service reports `LOW_DISK` and returns 503 below the configured hard floor.

Host packages:

- Docker Engine and Docker Compose plugin from Docker's signed Ubuntu repository.
- `ca-certificates`, `curl`, `sqlite3`, `age`, `jq`, `ufw`, and `unattended-upgrades`.
- `openssh-server`, configured for keys only.

Node.js and Rust are not needed on the host. The image pins Node 24.12.0 and builds the watcher with Rust 1.89, the minimum version accepted by the current locked dependency graph.

## Dedicated Docker daemon

ZecOne uses its own systemd-managed daemon from `deploy/systemd/zecone-docker.service`, not the host's normal Docker service. The normal `docker.service`, `docker.socket`, and `containerd.service` remain disabled and inactive. The dedicated unit conflicts with them, exposes only a root-owned Unix socket at `/run/zecone-docker/docker.sock`, and starts dockerd with `--bridge=none`, `--iptables=false`, `--ip6tables=false`, `--ip-forward=false`, `--ip-masq=false`, and `--userland-proxy=false`.

Install and start it only after confirming the normal Docker units are inactive:

```bash
sudo install -o root -g root -m 0644 deploy/systemd/zecone-docker.service /etc/systemd/system/zecone-docker.service
sudo systemctl daemon-reload
sudo systemctl enable --now zecone-docker.service
sudo systemctl status zecone-docker.service --no-pager
sudo DOCKER_HOST=unix:///run/zecone-docker/docker.sock docker info
sudo DOCKER_HOST=unix:///run/zecone-docker/docker.sock docker network ls
ip link show type bridge
sysctl net.ipv4.ip_forward net.ipv6.conf.all.forwarding
```

Expected daemon state is data root `/var/lib/docker`, overlay2 storage, no `docker0` or `br-*` interface, IP forwarding `0`, and no Docker iptables rules. The socket is mode `0600`; do not enable a TCP listener. The unit reuses the existing `/var/lib/docker` store so the exact validated image remains available, and `RequiresMountsFor=/var/lib/zecone` keeps the dedicated state filesystem ordered before daemon startup.

`deploy/zecone-vps` automatically selects `/run/zecone-docker/docker.sock` when `DOCKER_HOST` is unset and that socket exists. For raw `docker` commands, export the socket explicitly:

```bash
export DOCKER_HOST=unix:///run/zecone-docker/docker.sock
```

The container uses `network_mode: host` because the daemon must not create a bridge or port-publishing iptables rules. The service itself binds only `127.0.0.1:3410`. This means the container shares the host network namespace and could reach host loopback services; it has no credentials or writable host storage, and its root filesystem remains read-only. If strict network-namespace separation is required, stop and request a separately reviewed bridge/proxy design instead of silently changing the daemon.

## Network and firewall

Allow inbound TCP 22 only from the operator's fixed IP or private VPN. Do not open port 3410; it is bound to VPS loopback. There is no Docker bridge, published port, public wallet, signer, admin, execution, or refund HTTP route. Do not add UFW or nftables rules for ZecOne.

The container needs outbound DNS and HTTPS/TLS access for configured Base/Solana JSON-RPC and Zcash lightwalletd gRPC providers. Permit TCP 443 to approved provider hosts, DNS to the VPS resolver, and host NTP. Docker registry access is needed only while pulling/building. Provider URLs containing API credentials live in the mode-0600 configuration directory and must not enter logs, shell history, Git, or support tickets.

Before installation, inspect without changing the VPS:

```bash
uname -a
cat /etc/os-release
nproc
free -h
df -hT
ss -lntup
systemctl --type=service --state=running
docker ps --format '{{.Names}}\t{{.Ports}}\t{{.Status}}'
docker compose ls
pm2 list 2>/dev/null || true
sudo ufw status verbose
```

Look for ports, container names, volumes, CPU/memory pressure, and disk paths already used by other applications. Do not stop or reconfigure them. ZecOne uses project name `zecone`, loopback port 3410, and its own runtime directory; change the loopback port in `.env` if it conflicts.

## Read-only installation

Clone a reviewed commit into its own directory. Do not place credentials in the clone.

```bash
sudo install -o root -g root -m 0644 deploy/systemd/zecone-docker.service /etc/systemd/system/zecone-docker.service
sudo systemctl daemon-reload
sudo systemctl enable --now zecone-docker.service
cp deploy/.env.example deploy/.env
deploy/zecone-vps init
deploy/zecone-vps build
deploy/zecone-vps validate
deploy/zecone-vps start-readonly
deploy/zecone-vps health
deploy/zecone-vps logs
```

Set `ZECONE_IMAGE_TAG` in `deploy/.env` to the exact validated image tag. Do not deploy an unpinned `local` image or assume the tag from an earlier build.

`init` creates the state and log directories as container UID/GID 10001 with mode 0700. It creates the configuration directory as root:10001 with mode 0750 and disabled templates as root:10001 with mode 0640, so the non-root container can read configuration without being able to replace it. Check that UID/GID 10001 is unused on the host before installation, or set `ZECONE_CONTAINER_UID` and `ZECONE_CONTAINER_GID` consistently in both the operator environment and Compose configuration. Replace placeholders through an editor over SSH; never pass secret provider URLs as command-line arguments. `validate` performs Compose validation and a network-disabled configuration inspection. BLOCKED provider findings are expected before operator setup; FAIL findings must be resolved.

`start-readonly` refuses `ZECONE_ALLOW_EXECUTION` unless it is `0` or unset. Compose runs a non-root user, read-only root filesystem, all Linux capabilities dropped, no-new-privileges, bounded processes/resources/logs, persistent state, host networking with a loopback-only listener, and a graceful 30-second stop. It does not publish a port or create a Docker bridge.

## Operations

```bash
deploy/zecone-vps health
deploy/zecone-vps logs
deploy/zecone-vps pause INCIDENT_CODE
deploy/zecone-vps stop
```

`pause` is an SSH-local `docker exec`, not a network endpoint. It durably pauses both submission journals and the operator lease. It cannot revoke bytes already signed or submitted; uncertain attempts must be reconciled by exact transaction identity.

Check the dedicated daemon with `systemctl status zecone-docker.service`, `journalctl -u zecone-docker.service`, `docker info`, and `docker ps`. Monitor container health, restart count, disk/inodes, SQLite errors, provider disagreement, stale scans/quotes, and `uncertain` journal rows. Export only finite error codes and aggregate metrics. Do not export Zcash transaction IDs, addresses, memos, UFVK data, recipient joins, signed bytes, provider credentials, or order-to-payment correlations.

## Encrypted backup and restore verification

Create an age recipient on the offline backup/operator device. Put only its public recipient line in a mode-0600 VPS file and set `ZECONE_BACKUP_RECIPIENT_FILE`. The private age identity stays off the VPS.

```bash
export ZECONE_BACKUP_RECIPIENT_FILE=/etc/zecone/backup-recipients.txt
deploy/zecone-vps backup /srv/zecone-backups/zecone-$(date -u +%Y%m%dT%H%M%SZ).tar.age
```

The command uses SQLite's online `.backup`, copies non-database state and the watch directory, creates a tar stream, and encrypts it directly to the offline recipient. Copy the encrypted file off-host and apply retention. A backup is not accepted until restored in a disposable directory on the offline PC:

```bash
export ZECONE_BACKUP_IDENTITY_FILE=/secure/offline/zecone-backup-identity.txt
deploy/zecone-vps restore-test /path/to/zecone-backup.tar.age
```

Restore testing checks every SQLite database with `PRAGMA integrity_check` and never writes active state. A real restore requires a stopped service, an empty new state directory, operator review, and reconciliation of every claimed/signed/uncertain submission before execution can ever be armed.

## Current validation status — 2026-10-22

Compose schema validation passes locally. The disposable service starts, remains paused, exposes health only, persists journals across restart, and rejects POST/admin paths.

### Stage 1 — isolated image and disposable runtime (PASS)

- `zecone-readonly:stage1-1.89` was built with Rust 1.89 inside a 2 CPU / 4 GiB systemd scope. The Rust release build took 5m25s and peaked at 2.1 GiB. The 1.56 GB image ID is `sha256:b31c0c1c59c1306768929557ac62feb410c02ada55fd5831a664972a323a6270`.
- The isolated daemon had no bridge, forwarding, masquerading, or iptables management. It was stopped afterward; no isolated socket, container, build process, or daemon remained, and normal `docker`/`containerd` remained inactive.
- A temporary container ran read-only, non-root, capability-free, network-isolated, and resource-capped. Health reported `READ_ONLY` with all execution/signing/broadcast/refund controls false, operator paused, and disk `PASS`. POST health and operator paths were rejected, journals survived restart, and missing-mount/non-empty-state cases failed closed.
- A disposable encrypted `age` backup restored with SQLite integrity checks. No production backup identity, recipient, or off-host destination was created.
- The dedicated 49 GiB `/var/lib/zecone` mount, UUID, marker, ownership, and missing-mount rejection were validated. No listener was opened on 3410, and existing Nginx, Redis, Hermes, PM2, and UFW state was preserved.

### Stage 2 — controlled read-only deployment (RUNNING)

- `zecone-docker.service` is enabled and active. It exposes only `/run/zecone-docker/docker.sock` mode `0600`, uses `/var/lib/docker`, and runs with no bridge, Docker iptables rules, forwarding, masquerading, or userland proxy. Normal `docker.service`, `docker.socket`, and `containerd.service` remain disabled and inactive.
- `zecone-readonly-1` is running with the exact validated image. It uses host networking but binds only `127.0.0.1:3410`; there are no published ports, no `docker0`/`br-*` bridge, and no public Docker API. The health endpoint is reachable only from the VPS loopback.
- The container is non-root UID/GID `10001`, read-only, capability-free, `no-new-privileges`, 128 PID limit, 2 GiB memory, 2 CPUs, bounded `local` logs, and `restart: unless-stopped`. At postflight it used about 81 MiB RAM and 8 PIDs.
- `/healthz` and `/readyz` report `READ_ONLY`, execution/signing/broadcast/refunds false, operator paused, disk `PASS`, and `OPERATOR_SETUP_REQUIRED`. POST `/healthz` returns 405 and `/operator` returns 404.
- A controlled stop/start completed with `SIGTERM`; journal inodes and sizes were unchanged, and the service returned healthy. Container restart count remained 0. Compose `init` was removed because the image already runs `tini` as PID 1, avoiding a double-init warning.
- `validate` reports expected `BLOCKED` provider and authorization findings for the disabled placeholder profiles. No provider endpoint, UFVK, key, signer, recipient, or production backup identity was added.
- `backup` failed closed because no recipient file is configured and created no output. The `ZECONE_ALLOW_EXECUTION=1` guard refused to start. Shared Nginx, Redis, Hermes, and PM2 PIDs/restart counts and the 16-rule UFW policy were unchanged.

The deployment has not been reboot-tested, and automatic failure-restart behavior has not been forced. Production provider configuration, production backups, and any execution remain blocked. The workstation Docker daemon remains unavailable, so this validation used the VPS only. Mainnet execution remains disabled.

The October 22, 2026 initial read-only inspection and its validation update are recorded in `VPS-INSPECTION-2026-10-22.md`.

