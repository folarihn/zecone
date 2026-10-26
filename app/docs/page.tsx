import type { Metadata } from "next";
import CodeBlock from "./code-block";
import { Container } from "../ui";

export const metadata: Metadata = { title: "Integration guide — ZecOne" };

const NAV = [
  ["quickstart", "Quickstart"],
  ["onboarding", "Merchant onboarding"],
  ["create", "Create a payment"],
  ["hosted", "Hosted checkout & links"],
  ["embedded", "Embedded checkout"],
  ["webhooks", "Webhooks"],
  ["fulfil", "Unlocking orders safely"],
  ["receipts", "Status & receipts"],
  ["reference", "API reference"],
  ["errors", "Errors & idempotency"],
  ["modes", "Demo, monitor & live"],
  ["limits", "Attribution & limits"],
  ["example", "Example DApp"],
  ["local", "Run locally"],
];

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-line pt-10">
      <h2 className="text-[24px] font-semibold tracking-tight text-ink">{title}</h2>
      <div className="mt-4 space-y-4 text-[15px] leading-relaxed text-ink-soft [&_code]:rounded [&_code]:bg-surface [&_code]:px-1 [&_code]:text-[13.5px] [&_code]:text-ink">
        {children}
      </div>
    </section>
  );
}

const ENDPOINTS: [string, string, string, string][] = [
  ["POST", "/api/v1/merchants/challenge", "public", "Get an EIP-4361 message for a Base address."],
  ["POST", "/api/v1/merchants/verify", "public", "Submit the signature; returns merchant, API key (once) and session."],
  ["GET", "/api/v1/merchant", "key", "Your merchant profile and key ids."],
  ["POST", "/api/v1/merchant/keys", "session", "Rotate the API key (optionally revoke others)."],
  ["POST", "/api/v1/merchant/payout-address", "session", "Change payout address with a signature from the new wallet."],
  ["POST", "/api/v1/payments", "payments:create", "Create a payment. Supports Idempotency-Key."],
  ["GET", "/api/v1/payments", "payments:read", "Your payments, newest first (limit, offset, state)."],
  ["GET", "/api/v1/payments/:id", "payments:read", "One payment."],
  ["GET", "/api/v1/payments/:id/quote", "payments:read", "Its quote and whether it expired."],
  ["GET", "/api/v1/payments/:id/events", "payments:read", "Lifecycle events; add ?stream=1 for SSE."],
  ["GET", "/api/v1/payments/:id/receipt", "payments:read", "Receipt for a COMPLETED payment."],
  ["POST", "/api/v1/payments/:id/cancel", "payments:cancel", "Cancel an unpaid payment."],
  ["POST", "/api/v1/webhooks", "webhooks:manage", "Set your endpoint; returns the signing secret once."],
  ["POST", "/api/v1/webhooks/test", "webhooks:manage", "Send a signed webhook.ping now."],
  ["GET", "/api/v1/checkout/:id?token=", "checkout token", "Customer-safe status view (CORS-enabled)."],
  ["GET", "/api/v1/quote/preview?amountUsd=", "public", "Indicative quote (demo rate)."],
  ["GET", "/api/v1/health", "public", "Mode and safety flags."],
];

export default function Docs() {
  return (
    <main>
      <Container className="py-12 sm:py-16">
        <h1 className="max-w-3xl text-[40px] font-semibold leading-tight tracking-tight text-ink sm:text-[48px]">
          Accept shielded ZEC in your DApp
        </h1>
        <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-muted">
          Your server creates a payment with <code className="text-ink">@zecone/sdk</code>, your customer pays on a hosted or
          embedded checkout, and your server unlocks the order when a signed webhook confirms settlement. Amounts are decimal
          strings end to end — there is no floating-point money anywhere in the path.
        </p>

        <div className="mt-12 grid gap-10 lg:grid-cols-[220px_1fr]">
          <nav aria-label="On this page" className="hidden lg:block">
            <ul className="sticky top-24 space-y-0.5 text-[14px]">
              {NAV.map(([id, label]) => (
                <li key={id}>
                  <a href={`#${id}`} className="block rounded-lg px-3 py-1.5 text-muted transition-colors hover:bg-surface hover:text-ink">
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="min-w-0 max-w-3xl space-y-12">
            <Section id="quickstart" title="Quickstart">
              <p>
                1. Sign in on the <a href="/dashboard" className="font-semibold text-blue-deep hover:underline">merchant dashboard</a>{" "}
                with the Base wallet that should receive payouts and copy your API key. 2. Install the SDK in your server
                project. 3. Create a payment and send the customer to its checkout.
              </p>
              <CodeBlock title="terminal" code={`npm install ./path/to/zecone/sdk   # @zecone/sdk (local package for the hackathon build)`} />
              <CodeBlock
                title=".env (server only)"
                code={`ZECONE_API_KEY=zk_…_sk_…        # from the dashboard, shown once
ZECONE_BASE_URL=http://127.0.0.1:4321
ZECONE_WEBHOOK_SECRET=whsec_…   # from the webhook settings, shown once`}
              />
            </Section>

            <Section id="onboarding" title="Merchant onboarding">
              <p>
                A merchant account is created only after an <strong>EIP-4361 (Sign-In with Ethereum)</strong> signature from the
                payout wallet. ZecOne writes the whole message — domain, URI, chain, a single-use nonce and a 10-minute expiry —
                stores it, and verifies that the returned signature recovers to the claimed address. A bare address never yields a
                credential. Smart-contract wallets are verified through ERC-1271/6492 when the server has a Base RPC configured.
              </p>
              <p>
                The dashboard does this for you. To onboard from your own app, relay the two public calls from your backend and
                keep the returned API key server-side:
              </p>
              <CodeBlock
                title="onboard.ts (server)"
                code={`import { ZecOne } from "@zecone/sdk";

const base = process.env.ZECONE_BASE_URL!;
// 1) Ask ZecOne for the exact message the wallet must sign.
const challenge = await ZecOne.onboarding.challenge(base, {
  address, chainId: 8453, domain: "shop.example", uri: "https://shop.example/setup",
});
// 2) Browser: signature = await wallet.signMessage(challenge.message)
// 3) Verify. apiKey is returned once, only when the account is created.
const { merchant, apiKey } = await ZecOne.onboarding.verify(base, { message: challenge.message, signature });`}
              />
              <p>
                Payments always pay out to the verified address. Changing it requires a new signature from the new wallet,
                made from a signed-in dashboard session.
              </p>
            </Section>

            <Section id="create" title="Create a payment">
              <CodeBlock
                title="app/api/orders/route.ts (Next.js)"
                code={`import { ZecOne } from "@zecone/sdk";

const zecone = new ZecOne({ apiKey: process.env.ZECONE_API_KEY!, baseUrl: process.env.ZECONE_BASE_URL });

export async function POST() {
  const orderId = crypto.randomUUID();
  const payment = await zecone.payments.create({
    amountUsd: "12.50",
    description: "Pixel Pass · lifetime",
    metadata: { orderId },          // never shown to the customer
    idempotencyKey: orderId,        // safe to retry
  });
  // Save payment.id against your order, then give the browser ONLY these:
  return Response.json({
    paymentId: payment.id,
    checkoutToken: payment.checkoutToken, // read-only capability
    checkoutUrl: payment.checkoutUrl,     // hosted page
  });
}`}
              />
              <p>
                The response includes the exact quote (<code>quote.zecAmount</code>, <code>quote.ethPayout</code>), a 15-minute{" "}
                <code>expiresAt</code> and — on real (monitor/live) checkouts only — the shielded address and a ZIP-321{" "}
                <code>paymentUri</code> for QR codes. Demo payments have <code>simulated: true</code> and no address. The SDK refuses to
                run in a browser because it holds your secret key.
              </p>
            </Section>

            <Section id="hosted" title="Hosted checkout & payment links">
              <p>
                Redirect the customer to <code>payment.checkoutUrl</code>, or create a link from the dashboard and share it. The
                hosted page shows the amount, a countdown and live progress (server-sent events with polling fallback), plus
                the address and QR code on real checkouts. It works on mobile.
              </p>
              <p>
                For an <code>&lt;iframe&gt;</code>, use <code>/embed/&lt;id&gt;?t=&lt;checkoutToken&gt;</code>. It posts{" "}
                <code>{`{ source: "zecone-checkout", type, paymentId, state }`}</code> to the parent window.
              </p>
              <CodeBlock
                title="iframe"
                code={`<iframe src="https://zecone.example/embed/pay_…?t=…" width="420" height="640" style="border:0"></iframe>
<script>
  window.addEventListener("message", (e) => {
    if (e.data?.source !== "zecone-checkout") return;
    if (e.data.type === "completed") fetch("/api/orders/" + e.data.paymentId); // ask YOUR server
  });
</script>`}
              />
            </Section>

            <Section id="embedded" title="Embedded checkout (React / Next.js)">
              <CodeBlock
                title="components/pay.tsx"
                code={`"use client";
import { ZecOneCheckout } from "@zecone/sdk/react";

export function Pay({ paymentId, checkoutToken }: { paymentId: string; checkoutToken: string }) {
  return (
    <ZecOneCheckout
      apiBaseUrl={process.env.NEXT_PUBLIC_ZECONE_URL!}
      paymentId={paymentId}
      checkoutToken={checkoutToken}
      theme={{ accent: "#5b3df5", radius: 12 }}   // or "light" | "dark"
      onStatusChange={(c) => console.log(c.state)}
      onCompleted={() => location.assign("/orders/thanks")} // then confirm on your server
      onExpired={() => alert("Quote expired — create a new order.")}
    />
  );
}`}
              />
              <p>
                It handles loading, awaiting payment, processing, completed, expired, failed and manual-review states. It never
                receives your API key and cannot change a payment. <code>@zecone/sdk/checkout</code> exposes the same polling and
                QR helpers without React.
              </p>
            </Section>

            <Section id="webhooks" title="Webhooks">
              <p>
                Register an HTTPS endpoint in the dashboard. Each event is signed with HMAC-SHA256 over{" "}
                <code>timestamp.rawBody</code> and sent in <code>X-ZecOne-Signature: t=…,v1=…</code>. Events older than five minutes
                are rejected. Delivery is at-least-once: network errors, timeouts, 408, 429 and 5xx are retried with exponential
                backoff (up to 8 attempts); other 4xx responses stop retries. De-duplicate on <code>event.id</code>.
              </p>
              <CodeBlock
                title="app/api/zecone/webhook/route.ts"
                code={`import { constructEvent } from "@zecone/sdk/webhooks";

export async function POST(req: Request) {
  const raw = await req.text(); // the RAW body — do not JSON.parse first
  let event;
  try {
    event = constructEvent(raw, req.headers.get("x-zecone-signature"), process.env.ZECONE_WEBHOOK_SECRET!);
  } catch {
    return new Response("bad signature", { status: 401 });
  }
  if (await alreadyProcessed(event.id)) return new Response("ok");
  if (event.type === "payment.completed") await markOrderPaid(event.payment!.id);
  return new Response("ok");
}`}
              />
              <p>
                Events: <code>payment.created</code>, <code>payment.awaiting_payment</code>, <code>payment.detected</code>,{" "}
                <code>payment.verifying</code>, <code>payment.zec_confirmed</code>, <code>payment.payout_submitted</code>,{" "}
                <code>payment.payout_confirmed</code>, <code>payment.completed</code>, <code>payment.expired</code>,{" "}
                <code>payment.failed</code>, <code>payment.manual_review</code> and <code>webhook.ping</code>.
              </p>
            </Section>

            <Section id="fulfil" title="Unlocking orders safely">
              <p>
                Never unlock goods because the browser says the payment finished — checkout callbacks and iframe messages are UI
                hints. Unlock on your server after a verified <code>payment.completed</code> webhook, and (recommended) re-read the
                payment with <code>zecone.payments.retrieve(id)</code> to confirm <code>state === "COMPLETED"</code> and that the
                amount and <code>metadata.orderId</code> match your order.
              </p>
            </Section>

            <Section id="receipts" title="Status & receipts">
              <CodeBlock
                title="server"
                code={`const p = await zecone.payments.retrieve(id);          // state, quote, payoutTxHash…
const events = await zecone.payments.events(id);       // full audit trail
const receipt = await zecone.payments.receipt(id);     // COMPLETED only
// receipt.payout.explorerUrl → https://basescan.org/tx/0x…`}
              />
              <p>
                Lifecycle: <code>CREATED → QUOTED → AWAITING_PAYMENT → PAYMENT_DETECTED → VERIFYING → ZEC_CONFIRMED →
                PAYOUT_PENDING → PAYOUT_SUBMITTED → PAYOUT_CONFIRMED → COMPLETED</code>, plus <code>EXPIRED</code>,{" "}
                <code>FAILED</code> and <code>MANUAL_REVIEW</code>. Demo receipts carry{" "}
                <code>evidenceKind: &quot;recorded-mainnet-replay&quot;</code>.
              </p>
            </Section>

            <Section id="reference" title="API reference">
              <p>
                Authenticate with <code>Authorization: Bearer &lt;key&gt;</code>. Authenticated endpoints send no CORS headers —
                call them from your server.
              </p>
              <div className="overflow-hidden rounded-2xl border border-line bg-surface">
                <table className="w-full text-left text-[13px]">
                  <thead className="bg-canvas text-ink">
                    <tr>
                      <th className="px-3 py-2 font-semibold">Endpoint</th>
                      <th className="hidden px-3 py-2 font-semibold sm:table-cell">Auth</th>
                      <th className="hidden px-3 py-2 font-semibold md:table-cell">Purpose</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ENDPOINTS.map(([m, p, a, d]) => (
                      <tr key={m + p} className="border-t border-line align-top">
                        <td className="px-3 py-2">
                          <span className={`mr-2 font-mono text-[11px] font-bold ${m === "GET" ? "text-blue-deep" : "text-gold-deep"}`}>{m}</span>
                          <span className="break-all font-mono text-[12px] text-ink">{p}</span>
                        </td>
                        <td className="hidden px-3 py-2 text-muted sm:table-cell">{a}</td>
                        <td className="hidden px-3 py-2 text-muted md:table-cell">{d}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>

            <Section id="errors" title="Errors & idempotency">
              <p>
                Errors are JSON: <code>{`{ "error": { "code", "message", "details"? } }`}</code>; the SDK throws{" "}
                <code>ZecOneError</code> with <code>code</code> and <code>status</code>. Common codes: <code>unauthorized</code>,{" "}
                <code>insufficient_scope</code>, <code>invalid_amount</code>, <code>recipient_not_verified</code>,{" "}
                <code>idempotency_conflict</code>, <code>checkout_busy</code> (with <code>Retry-After</code>),{" "}
                <code>insufficient_liquidity</code>, <code>not_completed</code>, <code>rate_limited</code>.
              </p>
              <p>
                Send an <code>Idempotency-Key</code> (the SDK generates one per call and reuses it on retries). Repeating a key with
                the same body returns the original payment; a different body returns <code>409 idempotency_conflict</code>.
              </p>
            </Section>

            <Section id="modes" title="Demo, monitor & live">
              <p>
                <strong>Demo</strong> (default): checkouts are simulated. No payable address or payment URI is ever shown; after a
                few seconds a server-side observer replays the recorded mainnet pilot transactions. Every event, webhook and
                receipt says <code>evidence: &quot;recorded-mainnet-replay&quot;</code> / <code>simulated: true</code>.
              </p>
              <p>
                <strong>Monitor</strong> (operator-authorized): checkouts show the real receiving address. The payment API reads the
                authenticated mainnet watcher (UFVK-only wallet, two independent providers, authenticated block corpus) and moves
                payments through <code>payment.detected</code> → <code>payment.zec_confirmed</code> with chain evidence (txid,
                height, confirmations, tip, ownership digest). It never triggers a payout: <code>settlement: &quot;disabled&quot;</code>.
              </p>
              <p>
                <strong>Live settlement</strong> is disabled in this build. Base payouts stay behind the operator&apos;s separate SIGN
                and BROADCAST approvals, liquidity checks and the paused submitter.
              </p>
            </Section>

            <Section id="limits" title="Attribution & current limits">
              <p>
                In monitor mode ZecOne attributes a shielded note to an order only if the watcher decrypted it for the receiving
                address, the order held the <strong>exclusive allocation</strong> of that address, and the note was mined after
                the allocation — never by amount or timing alone. All real checkouts share one receiving address, so{" "}
                <strong>only one real checkout can be awaiting payment at a time</strong>; others get <code>checkout_busy</code>.
                Per-order diversified addresses would remove this limit and are not enabled yet.
              </p>
              <p>
                A wrong amount goes to <code>MANUAL_REVIEW</code>; a source transaction can fund only one order; payments are
                quoted at a fixed demo rate in this build; and a quote is only issued if the relayer&apos;s configured balance
                covers it and all open payouts.
              </p>
              <p>No browser action can complete a payment in any mode.</p>
            </Section>

            <Section id="example" title="Example DApp: Access Pass">
              <p>
                <code>examples/access-pass</code> is a separate merchant app: it onboards with a Base wallet signature, keeps its API
                key and webhook secret on its server, creates payments through the SDK, embeds the checkout, and unlocks content
                only after a verified <code>payment.completed</code> webhook plus a server-side status check.
              </p>
            </Section>

            <Section id="local" title="Run locally">
              <CodeBlock
                title="terminal"
                code={`npm ci
npm run sdk:build
npm run payments:start      # API on http://127.0.0.1:4321 (demo mode)
npm run dev                 # this site on http://localhost:3000
npm run dapp:start          # Access Pass example on http://127.0.0.1:4333`}
              />
            </Section>
          </div>
        </div>
      </Container>
    </main>
  );
}
