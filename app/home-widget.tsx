"use client";
// Homepage payment widget: a real quote preview from the ZecOne API and a real
// (demo-mode) payment request when the visitor continues to checkout.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, Loader2 } from "lucide-react";
import { BaseMark, ZcashMark } from "./ui";

type Preview = { zecAmount: string; ethPayout: string; feeZat: string; rateSource: string };
type Health = { livePayoutEnabled: boolean; mode: string } | null;

const PRESETS = ["1.00", "5.00", "20.00"];

// Display-only rounding (the quote itself stays exact to the wei).
const shortEth = (v: string) => {
  const [w, f = ""] = v.split(".");
  return f.length > 8 ? `≈ ${w}.${f.slice(0, 8)}` : v;
};

export default function HomeWidget() {
  const router = useRouter();
  const [amount, setAmount] = useState("5.00");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [health, setHealth] = useState<Health | "down" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/zecone/api/v1/health")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setHealth)
      .catch(() => setHealth("down"));
  }, []);

  useEffect(() => {
    if (!/^\d{1,4}(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) {
      setPreview(null);
      return;
    }
    const c = new AbortController();
    const t = setTimeout(() => {
      fetch(`/zecone/api/v1/quote/preview?amountUsd=${amount}`, { signal: c.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 180);
    return () => {
      c.abort();
      clearTimeout(t);
    };
  }, [amount]);

  const valid = /^\d{1,2}(\.\d{1,2})?$/.test(amount) && Number(amount) > 0 && Number(amount) <= 50;

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountUsd: Number(amount).toFixed(2) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message ?? "Could not create the payment request.");
      router.push(`/pay/${data.payment.id}?t=${data.payment.checkoutToken}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const status =
    health === null ? "Checking service…" : health === "down" ? "Payment API offline" : health.livePayoutEnabled ? "Live" : "Demo mode · live payouts off";

  return (
    <div className="relative">
      <div className="rounded-[28px] border border-line bg-surface p-5 shadow-float sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[14px] font-semibold text-ink">Checkout preview</span>
          <span
            className={`flex items-center gap-1.5 text-[12.5px] font-medium ${health === "down" ? "text-red" : "text-amber"}`}
            data-testid="service-status"
          >
            <span className={`h-1.5 w-1.5 rounded-full ${health === "down" ? "bg-red" : "bg-amber animate-pulse-soft"}`} />
            {status}
          </span>
        </div>

        <div className="mt-4 rounded-2xl bg-canvas p-4">
          <div className="flex items-center justify-between text-[13px] text-muted">
            <span>Customer pays</span>
            <span className="flex items-center gap-1.5 text-gold-deep">
              <ZcashMark size={18} /> Zcash · shielded
            </span>
          </div>
          <div className="mt-2 flex items-baseline justify-between gap-3">
            <label className="flex items-baseline gap-1 text-ink">
              <span className="text-[22px] font-semibold text-muted">$</span>
              <input
                aria-label="Amount in US dollars"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
                className="w-28 bg-transparent text-[34px] font-semibold tracking-tight outline-none"
              />
            </label>
            <div className="text-right">
              <div className="text-[20px] font-semibold tabular-nums text-ink" data-testid="quote-zec">
                {preview ? `${preview.zecAmount} ZEC` : "—"}
              </div>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setAmount(p)}
                className={`rounded-full border px-3 py-1 text-[12.5px] font-medium transition-colors ${
                  amount === p ? "border-ink bg-ink text-white" : "border-line bg-surface text-ink-soft hover:border-ink/30"
                }`}
              >
                ${Number(p)}
              </button>
            ))}
          </div>
        </div>

        <div className="relative z-10 -my-2.5 flex justify-center">
          <span className="grid h-9 w-9 place-items-center rounded-full border border-line bg-surface text-ink shadow-sm">
            <ArrowDown size={16} />
          </span>
        </div>

        <div className="rounded-2xl bg-canvas p-4">
          <div className="flex items-center justify-between text-[13px] text-muted">
            <span>Merchant receives</span>
            <span className="flex items-center gap-1.5 text-blue-deep">
              <BaseMark size={18} /> Base · public
            </span>
          </div>
          <div className="mt-2 text-[22px] font-semibold tabular-nums text-ink" data-testid="quote-eth">
            {preview ? `${shortEth(preview.ethPayout)} ETH` : "—"}
          </div>
        </div>

        <ol className="mt-5 grid gap-2.5 text-[13px]">
          {[
            ["Shielded payment", "Sent to a Zcash address assigned to this order."],
            ["Confirmed", "Attributed by exact transaction; 20 confirmations required."],
            ["Paid out", "The relayer sends ETH to the merchant's verified Base address."],
          ].map(([t, d], i) => (
            <li key={t} className="flex gap-3">
              <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border border-line-strong text-[11px] font-semibold text-ink-soft">
                {i + 1}
              </span>
              <span>
                <span className="font-semibold text-ink">{t}.</span> <span className="text-muted">{d}</span>
              </span>
            </li>
          ))}
        </ol>

        <button
          type="button"
          onClick={pay}
          disabled={!valid || busy || health === "down"}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-full bg-ink py-3.5 text-[15px] font-semibold text-white transition-colors hover:bg-navy disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy && <Loader2 size={16} className="animate-spin" />}
          {busy ? "Creating payment request…" : `Continue to demo checkout`}
        </button>
        {error && <p className="mt-2 text-[12.5px] text-red">{error}</p>}
        <p className="mt-3 text-[12px] leading-relaxed text-muted">
          Demo rate: 1 ZEC = $50.00, fixed — not a market price. Demo checkouts replay recorded mainnet transactions; no
          funds move.
        </p>
      </div>
    </div>
  );
}
