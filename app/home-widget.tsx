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
    health === null
      ? "Checking service…"
      : health === "down"
        ? "Payment API offline"
        : health.livePayoutEnabled
          ? "Live settlement"
          : health.mode === "monitor"
            ? "Mainnet monitoring, payout off"
            : "Demo mode, live payouts off";

  return (
    <div className="rounded-[var(--radius-xl)] border border-line bg-surface p-5 shadow-float sm:p-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-display text-[18px] font-semibold text-ink">Quote a payment</h3>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[13px] font-semibold ${
            health === "down" ? "border-red/25 bg-red-soft text-red" : "border-line-strong bg-canvas text-ink-soft"
          }`}
          data-testid="service-status"
        >
          <span className={`h-1.5 w-1.5 rounded-full ${health === "down" ? "bg-red" : "bg-gold animate-pulse-soft"}`} aria-hidden="true" />
          {status}
        </span>
      </div>

      <div className="mt-5 rounded-[var(--radius-lg)] border border-line bg-canvas p-4 sm:p-5">
        <div className="flex items-center justify-between text-[14px] text-muted">
          <span>Customer pays</span>
          <span className="flex items-center gap-1.5 font-medium text-gold-deep">
            <ZcashMark size={18} /> Zcash, shielded
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-baseline justify-between gap-3">
          <label className="flex items-baseline gap-1 text-ink">
            <span className="font-display text-[26px] font-semibold text-muted">$</span>
            <input
              aria-label="Amount in US dollars"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
              className="w-32 rounded-md bg-transparent font-display text-[40px] font-semibold tracking-[-0.03em] outline-none focus:ring-2 focus:ring-lime"
            />
          </label>
          <div className="font-mono text-[20px] font-medium tabular-nums text-ink" data-testid="quote-zec" aria-live="polite">
            {preview ? `${preview.zecAmount} ZEC` : "…"}
          </div>
        </div>
        <div className="mt-3 flex gap-2" role="group" aria-label="Preset amounts">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setAmount(p)}
              aria-pressed={amount === p}
              className={`min-h-9 rounded-full border px-3.5 text-[14px] font-semibold transition-colors ${
                amount === p ? "border-forest bg-forest text-ivory" : "border-line-strong bg-surface text-ink-soft hover:border-forest/40"
              }`}
            >
              ${Number(p)}
            </button>
          ))}
        </div>
      </div>

      <div className="relative z-10 -my-3 flex justify-center" aria-hidden="true">
        <span className="grid h-9 w-9 place-items-center rounded-full border border-line bg-surface text-ink">
          <ArrowDown size={16} />
        </span>
      </div>

      <div className="rounded-[var(--radius-lg)] border border-line bg-canvas p-4 sm:p-5">
        <div className="flex items-center justify-between text-[14px] text-muted">
          <span>Merchant receives</span>
          <span className="flex items-center gap-1.5 font-medium text-blue-deep">
            <BaseMark size={18} /> Base, public
          </span>
        </div>
        <div className="mt-2 font-mono text-[20px] font-medium tabular-nums text-ink" data-testid="quote-eth">
          {preview ? `${shortEth(preview.ethPayout)} ETH` : "…"}
        </div>
      </div>

      <button
        type="button"
        onClick={pay}
        disabled={!valid || busy || health === "down"}
        className="mt-6 flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-forest text-[16px] font-semibold text-ivory transition-colors hover:bg-navy disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
        {busy ? "Creating payment request…" : `Continue to demo checkout`}
      </button>
      {!valid && amount !== "" && <p className="mt-2 text-[14px] text-muted">Demo checkouts accept amounts from $0.01 to $50.</p>}
      {error && (
        <p className="mt-2 text-[14px] font-medium text-red" role="alert">
          {error}
        </p>
      )}
      <p className="mt-4 text-[13.5px] leading-relaxed text-muted">
        Demo rate: 1 ZEC = $50.00, fixed, not a market price. Demo checkouts are simulated and replay the recorded mainnet pilot;
        no funds move.
      </p>
    </div>
  );
}
