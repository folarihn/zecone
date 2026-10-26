# Integrating ZecOne into a DApp

Status in this build: **demo mode** by default. Everything below runs end to end locally; demo payments are **simulated** — no payable address is shown, and they complete through a server-side replay of the recorded mainnet pilot transactions (labelled `recorded-mainnet-replay`, `simulated: true`). An operator can switch the API to **monitor mode** to observe real deposits read-only (below). Live Base payouts and Zcash broadcast are disabled in every mode.

## 1. Merchant onboarding (wallet ownership)

1. Open the ZecOne dashboard (`/dashboard`) and connect the Base wallet that should receive payouts. The page switches the wallet to Base (8453) or Base Sepolia (84532), adding the chain if needed.
2. Sign the EIP-4361 message. ZecOne composed it server-side with your domain, a single-use nonce and a 10-minute expiry; it authorizes no transaction.
3. ZecOne verifies the signature recovers to that address, creates the merchant with that address as the **verified payout address**, and shows your secret API key **once**.
4. Store the key in your server environment (`ZECONE_API_KEY`). Register your webhook URL in the dashboard and store its signing secret (`ZECONE_WEBHOOK_SECRET`).

Programmatic onboarding (what `examples/access-pass` does): relay `ZecOne.onboarding.challenge()` / `.verify()` from your backend and keep the returned key server-side.

Rules enforced by the API: a credential is never issued for a bare address; payments can only pay out to the verified address; changing it needs a new signature from the new wallet within a dashboard session; keys are hashed, scoped and rotatable.

## 2. Create payments (server)

```ts
import { ZecOne } from "@zecone/sdk";
const zecone = new ZecOne({ apiKey: process.env.ZECONE_API_KEY!, baseUrl: process.env.ZECONE_BASE_URL });

const payment = await zecone.payments.create({
  amountUsd: "12.50",
  description: "Pixel Pass · lifetime",
  metadata: { orderId },
  idempotencyKey: orderId,
});
// → payment.id, payment.checkoutToken (browser-safe), payment.checkoutUrl, payment.quote, payment.paymentUri
```

## 3. Show checkout (browser)

- **Hosted:** redirect to `payment.checkoutUrl` or share a payment link from the dashboard (QR included).
- **Embedded (React/Next.js):** `<ZecOneCheckout apiBaseUrl=… paymentId=… checkoutToken=… theme=… onCompleted=… />` from `@zecone/sdk/react`.
- **Iframe:** `<iframe src="https://<zecone>/embed/<id>?t=<checkoutToken>">`, listening for `{ source: "zecone-checkout" }` messages.

The checkout token is read-only. Nothing in the browser can complete a payment.

## 4. Fulfil on a verified event (server)

```ts
import { constructEvent } from "@zecone/sdk/webhooks";
export async function POST(req: Request) {
  const raw = await req.text();
  const event = constructEvent(raw, req.headers.get("x-zecone-signature"), process.env.ZECONE_WEBHOOK_SECRET!);
  if (event.type === "payment.completed") {
    const p = await zecone.payments.retrieve(event.payment!.id); // defence in depth
    if (p.state === "COMPLETED" && p.metadata?.orderId === myOrder.id) await unlock(myOrder);
  }
  return new Response("ok");
}
```

Webhooks are HMAC-SHA256 over `timestamp.rawBody`, rejected after 5 minutes, retried with backoff on network errors/408/429/5xx (8 attempts), at-least-once — de-duplicate on `event.id`.

## 5. Receipts and status

`payments.retrieve`, `payments.events`, `payments.receipt` (COMPLETED only), `payments.list`, `payments.cancel`.

## Limits to design around

- **One checkout awaiting payment at a time** (shared receiving address, exclusive allocation). Others get `409 checkout_busy` with `Retry-After`.
- Quotes expire after 15 minutes; amounts are exact — a mismatch goes to `MANUAL_REVIEW`.
- Fixed demo rate (1 ZEC = $50) in this build.

## Monitor mode (real deposits, read-only, operator machine)

Monitor mode shows the real receiving address and attributes real shielded deposits using the existing authenticated watcher. It never pays out: payments stop at `ZEC_CONFIRMED` with `settlement: "disabled"`. Prerequisites (operator only): the UFVK watch wallet, the two provider endpoints, a populated authenticated block corpus from `scripts/mainnet-watch-worker.ts`, and the watcher binary (`cargo build --manifest-path services/zcash-watch/Cargo.toml`).

```powershell
$env:ZECONE_PAYMENTS_MODE = "monitor"
$env:ZECONE_MONITOR_AUTHORIZED = "I_UNDERSTAND_NO_AUTOMATIC_PAYOUT"
$env:ZECONE_WATCH_WORKER_CONFIG = "C:\path\to\mainnet-watch-worker.json"
$env:ZECONE_DEMO_MERCHANT = "0"
npm run payments:start
```

Real checkouts are refused (`503 watcher_not_ready`) until the watcher has a fresh verified snapshot; only one real checkout can await payment at a time (`409 checkout_busy`). Only send ZEC you are prepared to have manually reconciled — nothing is paid out automatically.

## Run the reference integration

```powershell
npm ci
npm run sdk:build
npm run payments:start      # API     http://127.0.0.1:4321
npm run build:web
npm run start:web           # ZecOne  http://localhost:3000  (use `npm run dev` while developing)
npm run dapp:start          # Access Pass http://127.0.0.1:4333
```

Open the Access Pass page, connect a Base wallet, sign, buy, and watch the content unlock after the verified webhook. Automated version: `npm run build:web && npm run test:integration`.

## Troubleshooting (Windows)

- `scripts\verify-windows.ps1` runs its own isolated instances (ports 4381/3081/4383, temporary database) and the browser suite uses 4391/3091/4393, so they never collide with services you are running. It reports what is listening on 3000/3210/4321/4333 and flags ZecOne services started from older code; `-StopStaleZecOne` stops only those.
- A service that cannot bind its port exits with a clear message naming the variable to change (`ZECONE_PAYMENTS_PORT`, `ACCESS_PASS_PORT`).
- The website reads `ZECONE_BASE_URL` at request time, so one production build works against any API address.
- After pulling new code, restart `payments:start`, `dev` and `dapp:start` — an API started from older code returns no quote preview and rejects the website's payment requests.
- Logs from each verification run are saved in `.state\verify-windows\<timestamp>\`.
