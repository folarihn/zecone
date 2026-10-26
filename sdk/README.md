# @zecone/sdk

Accept shielded Zcash and settle ETH on Base through ZecOne.

| Entry | Runs in | Purpose |
|---|---|---|
| `@zecone/sdk` | server only (holds your API key) | create/retrieve/list/cancel payments, quotes, events, receipts, webhook registration, onboarding helpers |
| `@zecone/sdk/webhooks` | server | `constructEvent(rawBody, signatureHeader, secret)`, `verifyWebhook` |
| `@zecone/sdk/checkout` | browser-safe | `fetchCheckout`, `watchCheckout`, `qrSvg` (needs only the read-only checkout token) |
| `@zecone/sdk/react` | browser | `<ZecOneCheckout apiBaseUrl paymentId checkoutToken theme onCompleted … />` |

```ts
import { ZecOne } from "@zecone/sdk";
const zecone = new ZecOne({ apiKey: process.env.ZECONE_API_KEY!, baseUrl: process.env.ZECONE_BASE_URL });
const payment = await zecone.payments.create({ amountUsd: "12.50", metadata: { orderId }, idempotencyKey: orderId });
// browser gets payment.id + payment.checkoutToken (or redirect to payment.checkoutUrl)
```

Unlock goods only on your server after a verified `payment.completed` webhook (and, ideally, `payments.retrieve`). Browser callbacks are UI hints.

Build: `npm run build` (emits `dist/`). Full guide: `/docs` on the ZecOne site, or `submission/INTEGRATION.md`.
