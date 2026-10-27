# Public demo deployment checklist

Nothing has been deployed. Every item below needs the owner's approval before a public URL exists.

## Scope of a public demo
- [ ] Demo mode only (`ZECONE_PAYMENTS_MODE=demo`; live is refused at startup).
- [ ] No spending keys, keystores, passphrases, relayer keys or `.secrets/` / `.state/` on the host or in the image.
- [ ] The Base relayer submitter stays paused; no operator SIGN/BROADCAST tooling on the host.

## Configuration (see `.env.example` and `deploy/demo/.env.example`)
- [ ] `ZECONE_DEMO_SECRET` set to a long random value (the default is public).
- [ ] `ZECONE_PUBLIC_URL` = public web origin; `ZECONE_SIWE_DOMAINS` = exactly the public web/DApp hosts.
- [ ] `ZECONE_ALLOW_HTTP_WEBHOOKS=0` (HTTPS webhooks only).
- [ ] `ZECONE_OPERATOR_TOKEN` empty (operator endpoints disabled).
- [ ] `ZECONE_BASE_URL` on the Vercel web app points at the HTTPS demo API. Authenticated merchant calls remain server-side; public checkout reads are capability-scoped.
- [ ] Leave `ZECONE_CHECKOUT_ADDRESS` unset. Demo mode stores `demo:no-payable-address` and never emits a Zcash address or payment URI.

## Build & verify
- [ ] `npm ci && npm run sdk:build && npm run typecheck && npm run typecheck:web && npm run lint && npm test`
- [ ] `npm run build:web && npm run test:integration`
- [ ] Persistent volume for `ZECONE_PAYMENTS_DB`; WAL files included in backups.
- [ ] Caddy terminates TLS for the demo API and Access Pass backend; Vercel terminates TLS for both frontends.
- [ ] `ZECONE_TRUST_PROXY=1` only in the Compose stack where Caddy is the sole network ingress.
- [ ] Access Pass Vercel contains only static files and the narrow `/api/*` proxy. API key, webhook secret and persistent state stay in the VPS backend.
- [ ] Rate limits are per-process and in memory — run a single API instance or add a shared limiter.

## Smoke test after deploy
- [ ] `/api/v1/health` reports `mode:demo`, `livePayoutEnabled:false`, `zcashBroadcastEnabled:false`, `settlement:disabled`.
- [ ] Homepage quote preview → hosted checkout → completes via demo replay with the "Demo" badge.
- [ ] Dashboard sign-in with a real wallet on Base; API key shown once; payment link opens on a phone.
- [ ] Access Pass: setup → buy → unlock; a forged webhook returns 401.
- [ ] `POST /api/v1/demo/<id>` and `/api/v1/operator/*` return 404 from the internet.

## Messaging
- [ ] Every surface says demo mode; no live merchant usage or new transactions are claimed.
- [ ] Single active checkout limitation stated (docs, store page, API error).
