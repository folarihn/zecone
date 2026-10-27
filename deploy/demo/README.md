# Public demo deployment (non-financial)

This stack is intentionally separate from `deploy/compose.yaml`, which packages
the read-only mainnet watcher. It runs only the simulated Payment API and the
secret-bearing Access Pass backend. It contains no Zcash viewing/spending keys,
Base relayer key, submitter, broadcaster, or live settlement configuration.

## Topology

- Vercel project 1: repository root, the Next.js website.
- Contabo: `payments` and `access-pass` on an internal Docker network; Caddy is
  the only published service and terminates HTTPS.
- Vercel project 2: `examples/access-pass`, the static Access Pass UI plus its
  narrow `/api/*` proxy. The proxy points to `ACCESS_PASS_BACKEND_URL` on Caddy.
- Named volumes persist the SQLite demo database, Access Pass state, and Caddy
  certificates. The local real wallet and watcher are never mounted.

## Prepare (no deployment)

1. Create `.secrets/deployment/demo.env` locally with:

   `node --experimental-transform-types scripts/generate-demo-deployment-env.ts`

   The generator refuses to overwrite an existing file and prints only a
   fingerprint. Transfer this file through the operator's approved secret
   channel to `/opt/zecone-demo/secrets/demo.env`; set owner-only permissions.
2. Copy `deploy/demo/.env.example` to `deploy/demo/.env` on the VPS and replace
   every example domain. DNS for both API names must resolve to the VPS before
   Caddy starts.
3. Set the website Vercel environment:
   `ZECONE_BASE_URL=https://<payment-api-domain>` and `ZECONE_API_KEY` from the
   protected demo environment. The key is server-only.
4. Set the Access Pass Vercel environment:
   `ACCESS_PASS_PUBLIC_URL=https://<access-pass-vercel-domain>` and
   `ACCESS_PASS_BACKEND_URL=https://<access-pass-api-domain>`. Set matching
   values in the VPS compose environment. Never put `ZECONE_API_KEY` in the
   Access Pass Vercel project; its VPS backend owns that key.

## Operator-reviewed launch

From the checked-out release commit on the VPS, after explicit approval:

```powershell
docker compose --project-directory deploy/demo -f deploy/demo/compose.yaml config
docker compose --project-directory deploy/demo -f deploy/demo/compose.yaml build --pull
docker compose --project-directory deploy/demo -f deploy/demo/compose.yaml up -d
docker compose --project-directory deploy/demo -f deploy/demo/compose.yaml ps
```

Confirm both public HTTPS health endpoints and assert the payment health body has
`mode: "demo"`, `livePayoutEnabled: false`, `zcashBroadcastEnabled: false`, and
`settlement: "disabled"`. Then run hosted and embedded checkout smoke tests.

## Operations and rollback

- Docker `restart: unless-stopped` supervises services. Health checks gate
  dependencies. JSON Caddy access logs and container logs use bounded local
  rotation. Application endpoints retain their own rate limits; forwarded
  client IPs are used only because the API is reachable solely through Caddy.
- Back up the named volumes before upgrades. For SQLite consistency, stop the
  `payments` container briefly and copy the complete volume (database plus WAL
  files), then restart and verify health. Treat the Access Pass state file as a
  secret because it contains an API key and webhook secret.
- Roll back by checking out the prior reviewed commit/image, rebuilding, and
  running `up -d` against the same named volumes. Never delete volumes as part
  of rollback. Restore a database only from a verified, quiesced backup.
- To stop public service without destroying state: `docker compose
  --project-directory deploy/demo -f deploy/demo/compose.yaml down`.

No command in this document is authorization to deploy. VPS access, DNS changes,
Vercel publication, and production environment writes each require explicit
operator approval.
