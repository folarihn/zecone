# ZecOne — Submission content

## Short description

ZecOne is a privacy-oriented cross-chain payment system: customers pay with
shielded Zcash, and a trusted, prefunded relayer pays the corresponding ETH to a
merchant on Base — with verified confirmations, replay protection, and explicit
operator approval gates.

## One-line pitch

> Spend shielded ZEC; recipients get ETH on Base.

## What is real, what is simulated

- **Real, verified on mainnet:** the pilot's shielded deposit, Base payout and shielded spend (`EVIDENCE.md`).
- **Real, read-only (built and tested with a synthetic chain; not yet run on mainnet):** monitor mode — the authenticated Zcash watcher feeding the payment API.
- **Demonstrated:** the full merchant integration (onboarding → SDK → hosted/embedded checkout → signed webhook → server-side unlock), in demo mode.
- **Simulated:** demo checkouts (no payable address; completion is a labelled replay of the pilot transactions).
- **Disabled:** live settlement (Base payouts, Zcash broadcast).

See `CHECKLIST.md` for the evidence behind each line.

## Feature summary

- Shielded Zcash **mainnet** spending wallet (unlock, sync, prove, sign, broadcast, reconcile).
- Verified **Base mainnet** payout with a durable settlement journal.
- **Merchant onboarding by wallet signature** (EIP-4361): the Base payout address is proven, then a scoped API key is issued once.
- Merchant **payment API** (`/api/v1/payments`) with scoped hashed keys, idempotency (conflict-checked), expiry, cancellation, receipts, rate limiting, and structured errors.
- **Developer SDK** (`@zecone/sdk`) — server client, webhook verification, browser-safe checkout helpers and an embeddable React `<ZecOneCheckout>`; typed and decimal-safe.
- **Hosted checkout, embedded checkout, iframe embed and payment links** with ZIP-321 QR codes, countdown and live status.
- **Signed webhooks** (HMAC-SHA256) with event ids, replay window, retry/backoff and a test ping.
- **Read-only mainnet monitoring mode**: the existing authenticated watcher (UFVK-only, two providers, authenticated blocks) attributes real deposits, enforces 20 confirmations, handles reorgs and records chain evidence — and never pays out.
- **Single-active-checkout attribution enforced** for real checkouts, and a relayer liquidity guard on every real quote.
- **Safe demo**: simulated checkouts never show a payable address or payment URI.
- **Payment lifecycle** state machine (`CREATED → … → COMPLETED`) with `EXPIRED`/`FAILED`/`MANUAL_REVIEW`.
- **Reference DApp** ("Access Pass"): wallet onboarding, SDK orders, embedded checkout, unlock only after a signature-verified webhook plus an API re-check.
- **Website** (homepage, checkout, docs, explorer, dashboard, security).
- **Base wallet connectivity** (connect, chain detection, switch/add Base, personal_sign).
- Privacy-accurate **trust model** documentation.

## Technical innovation summary

1. **Exact-attribution shielded payments** — payments are bound to a source
   transaction id, never amount/timestamp guessing.
2. **Decimal-safe financial core** — all money is bigint-based fixed-point;
   floating point is banned from the money path.
3. **Fail-closed approval gates** — two single-use approvals (SIGN, BROADCAST)
   bound to exact session digests, with a durable, auditable journal.
4. **Two-provider consensus proxy** — confirmation requires two independent
   lightwalletd operators to agree on height and block hash.
5. **Encrypted signed-artifact at rest** — signed transaction bytes are sealed
   (AES-256-GCM) and never persisted in plaintext.

## Suggested screenshots

1. Homepage hero + verified mainnet transactions.
2. Demo checkout with quote + lifecycle steps and an explicit non-payable simulation label.
3. Example DApp: locked → unlocked content.
4. Explorer with the three mainnet transactions.
5. Security page architecture diagram.
6. Developer docs SDK snippet.

## Deployment instructions

```powershell
npm ci
npm run sdk:build
npm run payments:start       # merchant payment API, demo mode — http://127.0.0.1:4321
npm run build:web
npm run start:web            # website — http://localhost:3000
npm run dapp:start           # reference DApp — http://127.0.0.1:4333
```

Configuration: `.env.example`. Public deployment has **not** been done. The
prepared Vercel + Contabo topology, secret handling and rollback procedure are
documented in `docs/DEMO-DEPLOYMENT.md` and `deploy/demo/README.md`.

### Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `ZECONE_PAYMENTS_PORT` / `HOST` | payment API bind | `4321` / `127.0.0.1` |
| `ZECONE_PAYMENTS_DB` | payment DB path | `.state/payments.sqlite` |
| `ZECONE_DEMO_SECRET` | demo merchant secret | must be fresh and 32+ characters in production |
| `ZECONE_BASE_URL` | SDK/website → payment API | `http://127.0.0.1:4321` |
| `ZECONE_API_KEY` | merchant API key (server-side) | demo key |
| `ACCESS_PASS_PORT` | example DApp bind | `4333` |

**No wallet passphrase, seed, spending key, or signed transaction bytes are
ever placed in environment variables, browser bundles, or logs.** Secrets are
excluded from the frontend build; the demo works without private credentials.

## Deployment safety

- Production build passes (`next build`).
- Health check: `GET /api/v1/health`.
- CORS and security headers set on the payment API.
- No live broadcast credentials in public hosting; live payout is disabled.
- Demo data is explicitly labeled; no fabricated volume or metrics.
- Rollback: redeploy the prior reviewed revision against the preserved demo volumes; never delete state as part of rollback.

## Final checklist

- [x] Mainnet deposit + payout + withdrawal verified and documented.
- [x] Withdrawal journal advanced to `FINALIZED` (20+ confirmations, provider agreement).
- [x] Merchant API, SDK, checkout, DApp, website implemented.
- [x] Signed webhooks + payment lifecycle implemented.
- [x] Base wallet connectivity implemented.
- [x] Security controls preserved; live payout disabled.
- [x] Final local matrix: 634 Node tests, 73 Rust tests (including the normally ignored expensive synthetic proof), 36 wallet UI tests and 9 payment browser tests passed; Windows verifier finished with 0 FAIL.
- [ ] Public deployment (not performed; requires explicit authorization).
