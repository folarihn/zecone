"use client";
// Demo store: the ZecOne website acting as a merchant. Creating an order calls
// the real payment API from the server (/api/checkout). The embedded checkout
// below is the same component DApps install from @zecone/sdk/react. Completion
// comes only from the payment API's demo observer; there is no button for it.
import { useState } from "react";
import Link from "next/link";
import { Check, ExternalLink, Loader2, RotateCcw } from "lucide-react";
import CheckoutPanel from "../components/checkout-panel";
import { Callout, Container, ModeBadge, PageHeader } from "../ui";

const PRODUCTS = [
  { id: "access-pass", name: "Access Pass", detail: "30 days of members-only content", price: "1.00" },
  { id: "support-tip", name: "Tip the builder", detail: "A one-off thank-you", price: "2.50" },
  { id: "pro-month", name: "Pro plan", detail: "One month, billed once", price: "5.00" },
];

type Created = { id: string; checkoutToken: string; checkoutUrl: string };

export default function DemoStore() {
  const [selected, setSelected] = useState(PRODUCTS[0].id);
  const [payment, setPayment] = useState<Created | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<string | null>(null);

  async function buy() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product: selected }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message ?? "Could not create the order.");
      setPayment(data.payment);
      setState(data.payment.state);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const product = PRODUCTS.find((p) => p.id === selected)!;
  const hostedPath = payment ? `/pay/${payment.id}?t=${payment.checkoutToken}` : null;

  const stage = !payment ? 0 : state === "COMPLETED" ? 2 : 1;
  const ended = !!state && ["EXPIRED", "FAILED"].includes(state);

  return (
    <main>
      <PageHeader
        crumbs={[{ label: "Home", href: "/" }, { label: "Payments", href: "/payments" }, { label: "Demo checkout" }]}
        title="Demo store"
        lead="Buy something with shielded ZEC and watch the order settle. This store is a ZecOne merchant like any other: it creates the payment on its server and embeds the checkout component on this page."
        aside={<ModeBadge mode="demo" />}
      />
      <Container className="py-10 sm:py-14">
        <ol aria-label="Checkout progress" className="mb-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-[14.5px]">
          {["Choose an item", "Pay", "Receipt"].map((label, i) => (
            <li key={label} className={`flex items-center gap-2 ${i <= stage ? "text-ink" : "text-muted"}`} aria-current={i === stage ? "step" : undefined}>
              <span
                aria-hidden="true"
                className={`grid h-7 w-7 place-items-center rounded-full border font-mono text-[13px] ${
                  i < stage ? "border-forest bg-forest text-lime" : i === stage ? "border-forest text-ink" : "border-line-strong"
                }`}
              >
                {i < stage ? <Check size={14} /> : i + 1}
              </span>
              <span className={i === stage ? "font-semibold" : ""}>{label}</span>
            </li>
          ))}
        </ol>

        <div className="grid items-start gap-8 lg:grid-cols-[0.85fr_1.15fr]">
          <section aria-labelledby="pick" className="rounded-[var(--radius-xl)] border border-line bg-surface p-6 shadow-card sm:p-7">
            <h2 id="pick" className="zc-h3 text-ink">
              Choose an item
            </h2>
            <div className="mt-5 grid gap-2.5" role="radiogroup" aria-label="Products">
              {PRODUCTS.map((p) => {
                const on = selected === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={!!payment}
                    onClick={() => setSelected(p.id)}
                    className={`flex items-center gap-4 rounded-[var(--radius-lg)] border px-4 py-4 text-left transition-colors disabled:cursor-not-allowed ${
                      on ? "border-forest bg-canvas ring-1 ring-forest" : "border-line hover:border-forest/40"
                    } ${payment && !on ? "opacity-50" : ""}`}
                  >
                    <span
                      aria-hidden="true"
                      className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 ${on ? "border-forest" : "border-line-strong"}`}
                    >
                      {on && <span className="h-2.5 w-2.5 rounded-full bg-forest" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[16px] font-semibold text-ink">{p.name}</span>
                      <span className="block text-[14px] text-muted">{p.detail}</span>
                    </span>
                    <span className="font-display text-[20px] font-semibold tabular-nums text-ink">${p.price}</span>
                  </button>
                );
              })}
            </div>

            <dl className="mt-6 grid gap-2 border-t border-line pt-5 text-[15px]">
              <div className="flex justify-between">
                <dt className="text-muted">Total</dt>
                <dd className="font-display text-[22px] font-semibold tabular-nums text-ink">${product.price}</dd>
              </div>
              <div className="flex justify-between text-[14px]">
                <dt className="text-muted">You pay in</dt>
                <dd className="text-ink-soft">Shielded ZEC at the demo rate</dd>
              </div>
            </dl>

            {!payment ? (
              <button
                type="button"
                onClick={buy}
                disabled={busy}
                className="mt-6 flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-forest text-[16px] font-semibold text-ivory transition-colors hover:bg-navy disabled:opacity-60"
              >
                {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
                {busy ? "Creating order…" : `Pay $${product.price} with ZEC`}
              </button>
            ) : (
              <div className="mt-6 grid gap-2">
                <a
                  href={hostedPath!}
                  target="_blank"
                  rel="noreferrer"
                  className="flex min-h-11 items-center justify-center gap-2 rounded-full border border-line-strong text-[15px] font-semibold text-ink hover:border-forest/40"
                >
                  Open the hosted checkout page <ExternalLink size={14} aria-hidden="true" />
                </a>
                <button
                  type="button"
                  onClick={() => {
                    setPayment(null);
                    setState(null);
                  }}
                  disabled={!!state && !["COMPLETED", "EXPIRED", "FAILED"].includes(state)}
                  className="flex min-h-11 w-full items-center justify-center gap-2 rounded-full text-[15px] font-semibold text-ink-soft hover:text-ink disabled:opacity-40"
                >
                  <RotateCcw size={14} aria-hidden="true" /> Start a new order
                </button>
              </div>
            )}
            {error && (
              <Callout tone="danger" title="The order was not created" className="mt-4">
                {error}
              </Callout>
            )}
            <p className="mt-5 text-[14px] leading-relaxed text-muted">
              Demo orders are simulated: no Zcash address is shown and there is nothing to pay. After a few seconds ZecOne replays
              its recorded mainnet pilot transactions so you can see every step.
            </p>
          </section>

          <section aria-label="Checkout" className="lg:sticky lg:top-24">
            {payment ? (
              <CheckoutPanel paymentId={payment.id} checkoutToken={payment.checkoutToken} onStatusChange={(c) => setState(c.state)} />
            ) : (
              <div className="rounded-[var(--radius-xl)] border border-dashed border-line-strong bg-canvas p-8 sm:p-10">
                <p className="font-display text-[18px] font-semibold text-ink">Your checkout appears here</p>
                <p className="mt-2 max-w-md text-[15px] leading-relaxed text-muted">
                  The exact ZEC amount, the quote window and live progress through to the Base payout. In this demo the payment
                  step is simulated.
                </p>
                <ul className="mt-6 grid gap-3" aria-hidden="true">
                  {["Payment request created", "Shielded payment detected", "ZEC confirmed", "ETH payout on Base", "Completed"].map((t) => (
                    <li key={t} className="flex items-center gap-3 text-[14.5px] text-muted">
                      <span className="h-5 w-5 rounded-full border-2 border-line-strong" />
                      {t}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {state === "COMPLETED" && (
              <Callout tone="success" title="Receipt" className="mt-4">
                A real merchant would now receive a signed <code className="font-mono text-[14px] text-ink">payment.completed</code> webhook
                and unlock the order on its server. See it end to end in the{" "}
                <Link href="/docs#example" className="font-semibold text-ink underline underline-offset-4">
                  Access Pass example DApp
                </Link>
                .
              </Callout>
            )}
            {ended && (
              <Callout tone="warning" className="mt-4">
                This order ended without a payment. Start a new order to try again.
              </Callout>
            )}
          </section>
        </div>
      </Container>
    </main>
  );
}
