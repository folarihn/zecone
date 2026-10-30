# External DApp integration — gap report (26 October 2026)

Audit of the state left by the previous agent (uncommitted on top of `df6409b`), followed by what was built in this pass. Classification: **WORKING AND TESTED**, **IMPLEMENTED BUT UNVERIFIED**, **DEMO ONLY**, **BLOCKED**.

## What existed before this pass

| Area | Finding |
|---|---|
| `services/payments` | Durable SQLite store, state machine, demo quote engine, HMAC webhook signing. **No merchant onboarding** — only a hard-coded demo merchant. API scopes were stored but never checked. `canAllocate()` / `assertNotDuplicate()` were stubs, so the advertised single-active-checkout restriction was **not enforced**. No quote expiry processing. Idempotency was not atomic and ignored body changes. Webhook registration claimed to return the secret "once" but never returned it (merchants could not verify signatures). Failed webhook deliveries were marked `delivered_at`. |
| Demo completion | `POST /api/v1/demo/:id` was **unauthenticated**; the website and the example DApp exposed a "Complete (demo replay)" button that drove it — i.e. payment success triggered from a frontend button. |
| `sdk/` | Server client with create/retrieve/quote/events; webhook verify helper. No list/receipt/cancel, no retries, no browser guard, no browser-safe checkout module, no React component. |
| `examples/access-pass` | Used the demo key and the unauthenticated completion route. Entitlement was checked server-side (good) but never received a webhook; no merchant wallet connection. |
| `app/checkout`, `app/api/*` | Website proxied payments with the demo key and exposed completion via `POST /api/checkout/:id`. Explorer could read any demo payment by id. |
| UI | New light design system started; homepage rewritten; legacy dark CSS was **not scoped** (unlayered `h1`, `button`, `input`… rules overrode Tailwind on every page); the wallet moved from `/` to `/wallet`, breaking the local launcher (`Launch-ZecOne.cmd`), pairing links and wallet UI tests that open `/`. |

Typecheck, web typecheck and production build passed; lint failed on `app/globals.css` formatting.

## What was built

| Capability | Status | Where / how verified |
|---|---|---|
| Merchant onboarding via EIP-4361 (server-composed single-use message, 10-min expiry, domain allowlist, EOA recovery; ERC-1271/6492 when `ZECONE_BASE_RPC_URL` set) | WORKING AND TESTED (EOA). Smart-wallet path IMPLEMENTED BUT UNVERIFIED | `services/payments/siwe.ts`; `tests/payments-integration.test.ts` (forged, replayed, tampered, foreign-domain, wrong-chain, expired); browser test with a real-signature test wallet |
| Scoped API keys (hashed), wallet-verified dashboard sessions, key rotation/revocation, payout-address change requiring a signature from the new wallet | WORKING AND TESTED | api.ts, store.ts; integration + browser tests |
| Payments API: create (idempotent, conflict on changed body, atomic), quote, status, events/SSE, list, cancel, receipt, expiry sweeper, recipient bound to verified address, safe structured errors, rate limits, no CORS on authenticated routes | WORKING AND TESTED | `tests/payments-integration.test.ts`, `tests/sdk.test.ts` |
| Relayer liquidity guard (operator-supplied snapshot vs. open payouts) | WORKING AND TESTED (bookkeeping only — not an on-chain balance read) | liquidity.ts |
| Signed webhooks: secret returned once, event ids, retries with backoff on network/408/429/5xx, final on other 4xx, test ping, delivery log | WORKING AND TESTED | webhooks.ts |
| Demo mode: server-side observer replays recorded mainnet evidence step by step (`evidence: "recorded-mainnet-replay"`); unauthenticated completion route removed; operator replay requires loopback + `ZECONE_OPERATOR_TOKEN` | DEMO ONLY (by design), TESTED | demo.ts |
| `@zecone/sdk` 0.2: server client (create/retrieve/list/quote/events/receipt/cancel/waitForTerminal, retries with idempotency keys, browser guard), `webhooks.constructEvent`, `onboarding`, `@zecone/sdk/checkout` (browser-safe), `@zecone/sdk/react` (`<ZecOneCheckout>`) | WORKING AND TESTED (consumed in-repo; not published to npm) | `tests/sdk.test.ts`, used by the website and the example |
| Hosted checkout `/pay/:id?t=…`, iframe embed `/embed/:id?t=…` (postMessage), payment links with QR (ZIP-321 URI) | WORKING AND TESTED | browser tests |
| Access Pass example: wallet connect + chain switch, onboarding, SDK orders, embedded/hosted checkout, signature-verified webhook + API re-check before unlock, order bound to buyer cookie | WORKING AND TESTED (demo mode) | `tests/integration/zecone-e2e.spec.ts` |
| Live deposit attribution entry point `attributeDeposit()` (exclusive holder, exact txid, amount check → MANUAL_REVIEW, duplicate txid refusal, unattributed log, confirmation threshold) | IMPLEMENTED, unit-TESTED with synthetic observations; **not wired to the live watcher** | attribution.ts |
| Single active checkout per receiving address | WORKING AND TESTED (enforced; concurrent creates → exactly one wins) | store.ts `allocations` |
| Per-order diversified addresses | BLOCKED for this deadline — see below | — |
| Live mode | Disabled: `createPaymentsApp` throws, the server exits 1 if `ZECONE_PAYMENTS_MODE=live` | tested |

## Update — 26 October 2026 (second pass): watcher integration and demo safety

| Capability | Status | Evidence |
|---|---|---|
| Three operating modes: `demo` (simulated), `monitor` (real deposits, read-only), `live` (refused) | WORKING AND TESTED | `tests/watch-bridge.test.ts` |
| Watcher → payment API (`services/payments/watch-bridge.ts`): reuses `MainnetWatchScanner` (Rust `observe-mainnet`, UFVK-only, two providers, authenticated block corpus), the settlement path's `verifyOwnedNote` and the watch worker's process lock; adds only bookkeeping | WORKING AND TESTED against a synthetic chain driven through the real scanner; **not yet run against live mainnet** (needs the operator's watch wallet, provider keys and block corpus) | `tests/watch-bridge.test.ts` |
| Attribution: UFVK receiver match + exclusive allocation + note mined after the allocation tip + one note/txid per payment; amount is a non-attributing check (mismatch → MANUAL_REVIEW) | WORKING AND TESTED | same |
| Confirmation threshold (≥20, from the watch policy), chain evidence (txid, height, block hash, tip, ownership digest, payment digest, both providers) recorded on the payment | WORKING AND TESTED | same |
| Reorganisation (checkpoint hash change / vanished note → MANUAL_REVIEW), provider failure (fail closed, checkouts pause), restart from durable checkpoint, idempotent re-scans | WORKING AND TESTED | same |
| Status to the checkout: public token-scoped SSE (`/api/v1/checkout/:id/events`) with polling fallback; signed webhooks for every transition | WORKING AND TESTED | browser suite + `public checkout SSE` test |
| Monitor mode never pays out: payments stop at `ZEC_CONFIRMED` with `settlement: "disabled"`; payments service imports no signer/submitter/broadcast code (static test) | WORKING AND TESTED | same |
| Demo safety: demo checkouts carry `simulated: true`, have **no address and no payment URI**, show a labelled "Example payment interface"; replayed evidence cannot attach to real payments and real evidence cannot attach to demo payments | WORKING AND TESTED | unit + browser tests |

## Per-order diversified addresses — investigation

Feasible in principle with the existing stack: `zcash_keys` UFVKs can derive unified addresses at arbitrary diversifier indices, every such address decrypts with the same incoming viewing key, and the keystore already validates ownership with `decrypt_diversifiers` (`services/zcash-mainnet-spend/src/keystore.rs`). Wallet recovery and spending are unaffected because all diversified addresses belong to the same seed/UFVK.

Second-pass finding: the Rust `observe-mainnet` output already reports each decrypted note's receiving `address` (from the wallet database), and the bridge attributes by that field — so per-order addresses would plug into the same code path.

What is missing: (1) a Rust command that derives and persists `address ↔ diversifier index ↔ payment` without exposing spending material to the API process; (2) the watch-only scanner (`services/zcash-watch`) must report the receiving diversifier (or address) per decrypted note, which it does not today; (3) live verification on mainnet, which needs a new funded payment — out of scope ("do not move any ZEC or ETH"). Shipping (1)–(2) without (3) would claim concurrency that has not been verified, so the single-active-checkout restriction stays and is documented in the API (`checkout_busy`), the docs, and the UI.

## Remaining blockers

- Monitor mode has not been exercised against live mainnet: it needs the operator's UFVK watch wallet, the two provider credentials and the authenticated block corpus on the operator machine (see `submission/INTEGRATION.md`, "Monitor mode").
- Quotes use a fixed demo rate; no live price authority is wired into the merchant API.
- Smart-contract-wallet signature verification needs a Base RPC and is untested.
- `@zecone/sdk` is consumed as a local package; it is not published to npm.
- Hosted/embedded checkout needs the ZecOne web app and payment API reachable from customers; nothing is deployed publicly (awaiting approval).
