"use client";
// Demo store: the ZecOne website acting as a merchant. Creating an order calls
// the real payment API from the server (/api/checkout). The embedded checkout
// below is the same component DApps install from @zecone/sdk/react. Completion
// comes only from the payment API's demo observer — there is no button for it.
import { useState } from "react";
import Link from "next/link";
import { ExternalLink, Loader2, RotateCcw } from "lucide-react";
import CheckoutPanel from "../components/checkout-panel";
import { Container } from "../ui";

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

  return (
    <main>
      <Container className="py-12 sm:py-16">
        <div className="max-w-2xl">
          <h1 className="text-[40px] font-semibold tracking-tight text-ink sm:text-[48px]">Demo store</h1>
          <p className="mt-3 text-[16px] leading-relaxed text-muted">
            Buy something with shielded ZEC and watch the order settle. This store is a ZecOne merchant like any other: it
            creates the payment on its server and embeds the checkout component on this page.
          </p>
        </div>

        <div className="mt-10 grid items-start gap-8 lg:grid-cols-[0.9fr_1.1fr]">
          <section aria-labelledby="pick" className="rounded-3xl border border-line bg-surface p-6 shadow-card sm:p-7">
            <h2 id="pick" className="text-[17px] font-semibold text-ink">
              Choose an item
            </h2>
            <div className="mt-4 grid gap-2.5" role="radiogroup" aria-label="Products">
              {PRODUCTS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={selected === p.id}
                  disabled={!!payment}
                  onClick={() => setSelected(p.id)}
                  className={`flex items-center justify-between rounded-2xl border px-4 py-3.5 text-left transition-colors disabled:cursor-not-allowed ${
                    selected === p.id ? "border-ink bg-canvas" : "border-line hover:border-ink/30"
                  }`}
                >
                  <span>
                    <span className="block text-[15px] font-semibold text-ink">{p.name}</span>
                    <span className="block text-[13px] text-muted">{p.detail}</span>
                  </span>
                  <span className="text-[16px] font-semibold tabular-nums text-ink">${p.price}</span>
                </button>
              ))}
            </div>
            {!payment ? (
              <button
                type="button"
                onClick={buy}
                disabled={busy}
                className="mt-6 flex w-full items-center justify-center gap-2 rounded-full bg-ink py-3.5 text-[15px] font-semibold text-white transition-colors hover:bg-navy disabled:opacity-60"
              >
                {busy && <Loader2 size={16} className="animate-spin" />}
                {busy ? "Creating order…" : `Pay $${product.price} with ZEC`}
              </button>
            ) : (
              <div className="mt-6 space-y-3">
                <a
                  href={hostedPath!}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-center gap-2 rounded-full border border-line-strong py-3 text-[14px] font-semibold text-ink hover:bg-canvas"
                >
                  Open the hosted checkout page <ExternalLink size={14} />
                </a>
                <button
                  type="button"
                  onClick={() => {
                    setPayment(null);
                    setState(null);
                  }}
                  disabled={!!state && !["COMPLETED", "EXPIRED", "FAILED"].includes(state)}
                  className="flex w-full items-center justify-center gap-2 rounded-full py-2.5 text-[13.5px] font-medium text-ink-soft hover:text-ink disabled:opacity-40"
                >
                  <RotateCcw size={14} /> Start a new order
                </button>
              </div>
            )}
            {error && (
              <p className="mt-3 text-[13px] leading-relaxed text-red" role="alert">
                {error}
              </p>
            )}
            <p className="mt-5 text-[12.5px] leading-relaxed text-muted">
              Demo orders are simulated: no Zcash address is shown and there is nothing to pay. After a few seconds ZecOne
              replays its recorded mainnet pilot transactions so you can see every step.
            </p>
          </section>

          <section aria-label="Checkout">
            {payment ? (
              <CheckoutPanel paymentId={payment.id} checkoutToken={payment.checkoutToken} onStatusChange={(c) => setState(c.state)} />
            ) : (
              <div className="rounded-3xl border border-dashed border-line-strong p-10 text-center">
                <p className="mx-auto max-w-sm text-[14.5px] leading-relaxed text-muted">
                  Your checkout appears here: the exact ZEC amount, a countdown and live progress through to the Base
                  payout. In this demo the payment step is simulated.
                </p>
              </div>
            )}
            {state === "COMPLETED" && (
              <p className="mt-4 text-[13.5px] leading-relaxed text-muted">
                Done. A real merchant would now receive a signed <code className="text-ink">payment.completed</code> webhook
                and unlock the order on its server. See it end to end in the{" "}
                <Link href="/docs#example" className="font-semibold text-blue-deep hover:underline">
                  Access Pass example DApp
                </Link>
                .
              </p>
            )}
          </section>
        </div>
      </Container>
    </main>
  );
}
