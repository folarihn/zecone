# Supervised operator loop (restricted pilot)

The pilot's operator machine runs three things that must stay together: the SSH
loopback tunnel to the VPS operator listener, the read-only authenticated watch
worker, and the operator sync that pushes observations and the verified
heartbeat. `npm run operator:supervise` keeps them together. It never signs or
broadcasts and never relaxes a check; when anything is wrong the pilot stays
paused (no fresh heartbeat means no new real checkout).

```powershell
npm run operator:supervise -- --config D:\zecone-mainnet\operator\operator-supervisor.json
```

The config holds paths only:

```json
{
  "sshTarget": "root@<vps>",
  "localPort": 14322,
  "remotePort": 4322,
  "watchWorkerConfig": "D:/zecone-mainnet/operator/watch-worker.json",
  "tokenFile": "D:/zecone-mainnet/operator/operator-token.txt",
  "mirror": "D:/zecone-mainnet/operator-mirror.sqlite",
  "checkoutAddressFile": "D:/zecone-mainnet/operator/checkout-address.txt",
  "walletJournal": "D:/zecone-mainnet/zcash-spend-sessions.sqlite",
  "providerEndpointFile": "<protected>/zcash-rpc-secondary-url.txt",
  "alertLog": "D:/zecone-mainnet/operator/alerts.log",
  "cycleSeconds": 120
}
```

## One cycle

1. **Tunnel.** Exactly one `ssh -N -L` process. After it exits the supervisor
   raises `TUNNEL_DOWN` and restarts it with exponential backoff (1 s to 60 s).
   Sync is skipped while the tunnel is down.
2. **Locks.** Both watch locks are checked: `watch-worker/worker.lock` (JSON
   PID, held by the worker and by the sync's watch bridge) and the watch
   binary's `<wallet>/process.lock` (bare PID). An abandoned lock is recovered
   only when its recorded PID does not exist and no watch binary, worker or
   sync process is running; the lock is first copied to
   `<state>/recovery-evidence/` with a `.recovery.json` note, the copy is
   verified, then the lock is removed (`LOCK_RECOVERED`). A live PID (even a
   reused one), a process holding the profile or an unreadable lock is refused
   (`LOCK_RECOVERY_REFUSED`), left untouched, and the cycle stops.
3. **Worker.** One `mainnet-watch-worker once` run as a fresh process.
4. **Sync.** One `operator-sync --once` run as a fresh process, after the
   worker, so the two never contend for the watch wallet. A deposit is reported
   as an order's payment only with the integrated wallet journal's proof that
   the exact transaction was signed and broadcast before the payment deadline.
5. **Health.** `HEARTBEAT_STALE` when the API's verified heartbeat is older than
   900 s (or missing); `SCAN_STALE` when the last wallet scan is older than
   1800 s (or missing).

Each failure names its stage: `probe`, `export` or `scan` (worker), `sync`, or
`lock`. A stage failing three cycles in a row raises `STAGE_FAILING` with its
code. Alerts are appended as JSON lines to `alertLog`; point external alerting
at that file. A second supervisor refuses to start (`operator-supervisor.lock`).

## Secrets

The raw-block provider endpoint is read from its protected file and passed to
the worker child only as `ZECONE_GETBLOCK_URL` in its environment. The operator
token is read by the sync from its file. No secret appears in a process
argument, and every logged or alerted line is scrubbed of the endpoint value.

## What it does not do

It does not create checkouts or quotes, unlock the spend wallet, sign or
broadcast, or approve a payout. Those remain the separate interactive SIGN and
BROADCAST approvals.
