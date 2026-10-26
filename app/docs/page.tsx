import type { Metadata } from "next";
import CodeBlock from "./code-block";
import DocsNav, { type DocsGroup } from "./docs-nav";
import { Callout, Container, PageHeader } from "../ui";

export const metadata: Metadata = { title: "Integration guide | ZecOne Developers" };

const GROUPS: DocsGroup[] = [
  { label: "Get started", items: [["quickstart", "Quickstart"], ["onboarding", "Merchant onboarding"]] },
  {
    label: "Accept payments",
    items: [
      ["create", "Create a payment"],
      ["hosted", "Hosted checkout and links"],
      ["embedded", "Embedded checkout"],
      ["webhooks", "Webhooks"],
      ["fulfil", "Unlocking orders safely"],
      ["receipts", "Status and receipts"],
    ],
  },
  {
    label: "Reference",
    items: [
      ["reference", "API reference"],
      ["errors", "Errors and idempotency"],
      ["modes", "Demo, monitor and live"],
      ["limits", "Attribution and limits"],
    ],
  },
  { label: "Examples", items: [["example", "Example DApp"], ["local", "Run locally"]] },
];

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-24">
      <h2 id={`${id}-h`} className="zc-h2 text-ink">
        <a href={`#${id}`} className="group inline-flex items-baseline gap-2 rounded">
          {title}
          <span aria-hidden="true" className="text-[0.6em] text-sage opacity-0 transition-opacity group-hover:opacity-100">
            #
          </span>
        </a>
      </h2>
      <div className="mt-5 space-y-5 text-[16.5px] leading-[1.7] text-ink-soft [&_:not(pre)>code]:rounded-md [&_:not(pre)>code]:bg-ink/[0.06] [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.86em] [&_:not(pre)>code]:text-ink [&_strong]:text-ink">
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
      <PageHeader
        crumbs={[{ label: "Home", href: "/" }, { label: "Developers" }]}
        title="Accept shielded ZEC in your DApp"
        lead={
          <>
            Your server creates a payment with <code className="rounded bg-ink/5 px-1.5 py-0.5 font-mono text-[0.9em]">@zecone/sdk</code>, your
            customer pays on a hosted or embedded checkout, and your server unlocks the order when a signed webhook confirms
            settlement. Amounts are decimal strings end to end; there is no floating-point money anywhere in the path.
          </>
        }
      />
      <Container className="py-10 sm:py-12">
        <div className="grid gap-10 lg:grid-cols-[250px_minmax(0,1fr)] xl:gap-14">
          <DocsNav groups={GROUPS} />
          <div className="docs-body min-w-0 max-w-[760px] space-y-14">
            <Section id="quickstart" title="Quickstart">
              <p>
                Three steps take you from nothing to a working checkout.
              </p>
              <ol className="grid gap-3 [counter-reset:step]">
                {[
                  <>
                    Sign in on the{" "}
                    <a href="/dashboard" className="font-semibold text-ink underline underline-offset-4">
                      merchant dashboard
                    </a>{" "}
                    with the Base wallet that should receive payouts and copy your API key.
                  </>,
                  <>Install the SDK in your server project.</>,
                  <>Create a payment and send the customer to its checkout.</>,
                ].map((item, i) => (
                  <li key={i} className="grid grid-cols-[32px_1fr] gap-3">
                    <span className="grid h-8 w-8 place-items-center rounded-full bg-forest font-mono text-[14px] text-lime">{i + 1}</span>
                    <span className="pt-0.5">{item}</span>
                  </li>
                ))}
              </ol>
              <CodeBlock title="Install" lang="shell" code={`npm install ./path/to/zecone/sdk   # @zecone/sdk (local package for the hackathon build)`} />
              <CodeBlock
                title=".env (server only)"
                lang="shell"
                code={`ZECONE_API_KEY=zk_…_sk_…        # from the dashboard, shown once
ZECONE_BASE_URL=http://127.0.0.1:4321
ZECONE_WEBHOOK_SECRET=whsec_…   # from the webhook settings, shown once`}
              />
              <Callout tone="danger" title="Keep secrets on your server">
                Your API key and webhook secret must never appear in browser code, a public repository or a client bundle. The
                browser only ever needs the payment id and its read-only checkout token.
              </Callout>
            </Section>

            <Section id="onboarding" title="Merchant onboarding">
              <p>
                A merchant account is created only after an <strong>EIP-4361 (Sign-In with Ethereum)</strong> signature from the
                payout wallet. ZecOne writes the whole message (domain, URI, chain, a single-use nonce and a 10-minute expiry),
                stores it, and verifies that the returned signature recovers to the claimed address. A bare address never yields a
                credential. Smart-contract wallets are verified through ERC-1271/6492 when the server has a Base RPC configured.
              </p>
              <p>
                The dashboard does this for you. To onboard from your own app, relay the two public calls from your backend and
                keep the returned API key server-side:
              </p>
              <CodeBlock
                title="onboard.ts (server)"
                lang="ts"
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
                lang="ts"
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
                <code>expiresAt</code> and, on real (monitor or live) checkouts only, the shielded address and a ZIP-321{" "}
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
                title="iframe embed"
                lang="html"
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
                lang="tsx"
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
      onExpired={() => alert("Quote expired. Create a new order.")}
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
                lang="ts"
                code={`import { constructEvent } from "@zecone/sdk/webhooks";

export async function POST(req: Request) {
  const raw = await req.text(); // the RAW body; do not JSON.parse first
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
              <Callout tone="danger" title="Never trust the browser">
                Checkout callbacks and iframe messages are UI hints. Never unlock goods because the browser says the payment
                finished.
              </Callout>
              <p>
                Unlock on your server after a verified <code>payment.completed</code> webhook, and (recommended) re-read the
                payment with <code>zecone.payments.retrieve(id)</code> to confirm <code>state === "COMPLETED"</code> and that the
                amount and <code>metadata.orderId</code> match your order.
              </p>
            </Section>

            <Section id="receipts" title="Status & receipts">
              <CodeBlock
                title="Read status and receipts (server)"
                lang="ts"
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
                Authenticate with <code>Authorization: Bearer &lt;key&gt;</code>. Authenticated endpoints send no CORS headers;
                call them from your server.
              </p>
              <ul className="divide-y divide-line overflow-hidden rounded-[var(--radius-lg)] border border-line bg-surface">
                {ENDPOINTS.map(([m, p, a, d]) => (
                  <li key={m + p} className="grid gap-1.5 px-4 py-3.5 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] sm:gap-4">
                    <span className="flex min-w-0 items-start gap-2.5">
                      <span
                        className={`mt-0.5 w-12 shrink-0 rounded-md py-0.5 text-center font-mono text-[12px] font-medium ${
                          m === "GET" ? "bg-blue-soft text-blue-deep" : "bg-gold-soft text-gold-deep"
                        }`}
                      >
                        {m}
                      </span>
                      <span className="min-w-0 break-all font-mono text-[14px] text-ink">{p}</span>
                    </span>
                    <span className="text-[15px] leading-snug text-muted">
                      {d} <span className="whitespace-nowrap text-[13.5px] text-ink-soft">Auth: {a}</span>
                    </span>
                  </li>
                ))}
              </ul>
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
                payments through <code>payment.detected</code> to <code>payment.zec_confirmed</code> with chain evidence (txid,
                height, confirmations, tip, ownership digest). It never triggers a payout: <code>settlement: &quot;disabled&quot;</code>.
              </p>
              <Callout tone="warning" title="Live settlement is disabled in this build">
                Base payouts stay behind the operator&apos;s separate SIGN and BROADCAST approvals, liquidity checks and the paused
                submitter.
              </Callout>
            </Section>

            <Section id="limits" title="Attribution & current limits">
              <p>
                In monitor mode ZecOne attributes a shielded note to an order only if the watcher decrypted it for the receiving
                address, the order held the <strong>exclusive allocation</strong> of that address, and the note was mined after
                the allocation, never by amount or timing alone. All real checkouts share one receiving address, so{" "}
                <strong>only one real checkout can be awaiting payment at a time</strong>; others get <code>checkout_busy</code>.
                Per-order diversified addresses would remove this limit and are not enabled yet.
              </p>
              <p>
                A wrong amount goes to <code>MANUAL_REVIEW</code>; a source transaction can fund only one order; payments are
                quoted at a fixed demo rate in this build; and a quote is only issued if the relayer&apos;s configured balance
                covers it and all open payouts.
              </p>
              <Callout title="No browser action can complete a payment in any mode." />
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
                title="Start the three local services"
                lang="shell"
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
