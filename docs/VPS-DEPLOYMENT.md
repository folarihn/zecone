# Contabo VPS deployment — read-only preparation

This package installs ZecOne in a **paused, read-only state**. It cannot sign, broadcast, create payments, execute refunds, or expose an operator endpoint. Production activation is a later, separately approved operation.

## Deployment shape

The Ubuntu VPS runs one container initially: `zecone-readonly`. It validates mounted public configuration, creates fresh empty submission journals, forces the Base and Solana journals and operator lease into `VPS_READ_ONLY_MODE`, and serves only `/healthz` and `/readyz`. Docker publishes that health port on `127.0.0.1` only.

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

Node.js and Rust are not needed on the host. The image pins Node 24.12.0 and builds the watcher with Rust 1.88, matching the repository requirements.

## Network and firewall

Allow inbound TCP 22 only from the operator's fixed IP or private VPN. Do not open port 3410; it is bound to VPS loopback. There is no public wallet, signer, admin, execution, or refund HTTP route.

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
cp deploy/.env.example deploy/.env
deploy/zecone-vps init
deploy/zecone-vps build
deploy/zecone-vps validate
deploy/zecone-vps start-readonly
deploy/zecone-vps health
deploy/zecone-vps logs
```

`init` creates the state and log directories as container UID/GID 10001 with mode 0700. It creates the configuration directory as root:10001 with mode 0750 and disabled templates as root:10001 with mode 0640, so the non-root container can read configuration without being able to replace it. Check that UID/GID 10001 is unused on the host before installation, or set `ZECONE_CONTAINER_UID` and `ZECONE_CONTAINER_GID` consistently in both the operator environment and Compose configuration. Replace placeholders through an editor over SSH; never pass secret provider URLs as command-line arguments. `validate` performs Compose validation and a network-disabled configuration inspection. BLOCKED provider findings are expected before operator setup; FAIL findings must be resolved.

`start-readonly` refuses `ZECONE_ALLOW_EXECUTION` unless it is `0` or unset. Compose runs a non-root user, read-only root filesystem, all Linux capabilities dropped, no-new-privileges, bounded processes/resources/logs, persistent state, and a graceful 30-second stop.

## Operations

```bash
deploy/zecone-vps health
deploy/zecone-vps logs
deploy/zecone-vps pause INCIDENT_CODE
deploy/zecone-vps stop
```

`pause` is an SSH-local `docker exec`, not a network endpoint. It durably pauses both submission journals and the operator lease. It cannot revoke bytes already signed or submitted; uncertain attempts must be reconciled by exact transaction identity.

Monitor container health, restart count, disk/inodes, SQLite errors, provider disagreement, stale scans/quotes, and `uncertain` journal rows. Export only finite error codes and aggregate metrics. Do not export Zcash transaction IDs, addresses, memos, UFVK data, recipient joins, signed bytes, provider credentials, or order-to-payment correlations.

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

## Current validation limits

Compose schema validation passes locally. The disposable service starts, remains paused, exposes health only, persists journals across restart, and rejects POST/admin paths. The local Docker CLI is installed but its Linux daemon is not running, so the image build and container start are **BLOCKED in this workstation run**. The October 22, 2026 read-only VPS inspection is recorded in `VPS-INSPECTION-2026-10-22.md`; no VPS change or deployment occurred.

