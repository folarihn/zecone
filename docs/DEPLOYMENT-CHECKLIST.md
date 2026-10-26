# Public demo deployment checklist

Nothing has been deployed. Every item below needs the owner's approval before a public URL exists.

## Scope of a public demo
- [ ] Demo mode only (`ZECONE_PAYMENTS_MODE=demo`; live is refused at startup).
- [ ] No spending keys, keystores, passphrases, relayer keys or `.secrets/` / `.state/` on the host or in the image.
- [ ] The Base relayer submitter stays paused; no operator SIGN/BROADCAST tooling on the host.

## Configuration (see `.env.example`)
- [ ] `ZECONE_DEMO_SECRET` set to a long random value (the default is public).
- [ ] `ZECONE_PUBLIC_URL` = public web origin; `ZECONE_SIWE_DOMAINS` = exactly the public web/DApp hosts.
- [ ] `ZECONE_ALLOW_HTTP_WEBHOOKS=0` (HTTPS webhooks only).
- [ ] `ZECONE_OPERATOR_TOKEN` empty (operator endpoints disabled).
- [ ] `ZECONE_BASE_URL` on the web app points at the API over a private network; only the web app is public.
- [ ] Decide whether the demo checkout should show the pilot receiving address (the UI warns "do not send real ZEC"), or set `ZECONE_CHECKOUT_ADDRESS` to a fresh watch-only address.

## Build & verify
- [ ] `npm ci && npm run sdk:build && npm run typecheck && npm run typecheck:web && npm run lint && npm test`
- [ ] `npm run build:web && npm run test:integration`
- [ ] Persistent volume for `ZECONE_PAYMENTS_DB`; WAL files included in backups.
- [ ] TLS terminated in front of the web app and the Access Pass example; `X-Forwarded-Proto` forwarded (session cookies become `Secure`).
- [ ] Rate limits are per-process and in memory — run a single API instance or add a shared limiter.

## Smoke test after deploy
- [ ] `/zecone/api/v1/health` reports `livePayoutEnabled:false`, `zcashBroadcastEnabled:false`.
- [ ] Homepage quote preview → hosted checkout → completes via demo replay with the "Demo" badge.
- [ ] Dashboard sign-in with a real wallet on Base; API key shown once; payment link opens on a phone.
- [ ] Access Pass: setup → buy → unlock; a forged webhook returns 401.
- [ ] `POST /api/v1/demo/<id>` and `/api/v1/operator/*` return 404 from the internet.

## Messaging
- [ ] Every surface says demo mode; no live merchant usage or new transactions are claimed.
- [ ] Single active checkout limitation stated (docs, store page, API error).
