// @zecone/sdk/react: embeddable ZecOne Checkout for React / Next.js DApps.
//
//   <ZecOneCheckout
//     apiBaseUrl="https://api.zecone.example"
//     paymentId={payment.id}
//     checkoutToken={payment.checkoutToken}   // read-only capability, browser-safe
//     onCompleted={() => router.refresh()}    // UI hint only; verify server-side
//   />
//
// The component never sees an API key and cannot change a payment. Treat
// `onCompleted` as a prompt to ask YOUR backend, which must confirm settlement
// from a verified webhook or `zecone.payments.retrieve()` before unlocking value.
// Every status shown comes from presentCheckout(), which validates the view and
// fails closed; there is no control here that marks anything paid.
"use client";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  CHECKOUT_STEPS,
  fetchWatcherHealth,
  formatCountdown,
  presentCheckout,
  presentStatus,
  qrSvg,
  stepIndex,
  watchCheckout,
  type CheckoutPresentation,
  type CheckoutTone,
  type CheckoutView,
} from "./checkout.ts";
import type { ZecOneError } from "./types.ts";

/** Display rounding only (quotes stay exact to the wei). */
function shortAmount(v: string, places = 8): string {
  const [w, f = ""] = v.split(".");
  return f.length > places ? `≈${w}.${f.slice(0, places)}` : v;
}

const TERMINAL = new Set(["COMPLETED", "SIMULATED_COMPLETE", "EXPIRED", "FAILED", "INVALID_LINK"]);
const WATCHER_POLL_MS = 30_000;

export interface ZecOneTheme {
  background?: string;
  surface?: string;
  text?: string;
  muted?: string;
  border?: string;
  accent?: string;
  accentText?: string;
  success?: string;
  warning?: string;
  danger?: string;
  radius?: number;
  fontFamily?: string;
}

// ZecOne brand: deep forest, warm ivory, chartreuse signal, Zcash gold.
export const LIGHT_THEME: Required<ZecOneTheme> = {
  background: "#fdfcf7",
  surface: "#f6f5ed",
  text: "#102820",
  muted: "#52675d",
  border: "#e2e1d3",
  accent: "#102820",
  accentText: "#f6f5ed",
  success: "#22704a",
  warning: "#93600c",
  danger: "#ad3426",
  radius: 20,
  fontFamily: "var(--font-body, Manrope), 'Segoe UI', system-ui, -apple-system, sans-serif",
};

const DISPLAY_FONT = "var(--font-heading, 'Space Grotesk'), var(--font-body, Manrope), 'Segoe UI', system-ui, sans-serif";
const MONO_FONT = "var(--font-code, 'IBM Plex Mono'), ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace";

export const DARK_THEME: Required<ZecOneTheme> = {
  ...LIGHT_THEME,
  background: "#18382c",
  surface: "#102820",
  text: "#f6f5ed",
  muted: "#a9b8af",
  border: "#2d4d40",
  accent: "#d7f276",
  accentText: "#102820",
  success: "#9fd67a",
  warning: "#e8b547",
  danger: "#f08a7a",
};

export interface ZecOneCheckoutProps {
  apiBaseUrl: string;
  paymentId: string;
  checkoutToken: string;
  theme?: ZecOneTheme | "light" | "dark";
  /** Poll interval (ms). */
  intervalMs?: number;
  compact?: boolean;
  onStatusChange?: (checkout: CheckoutView) => void;
  /** UI hint only. Confirm settlement on your server before granting access. */
  onCompleted?: (checkout: CheckoutView) => void;
  onExpired?: (checkout: CheckoutView) => void;
  onFailed?: (checkout: CheckoutView) => void;
  onError?: (error: ZecOneError) => void;
  className?: string;
}

export function ZecOneCheckout(props: ZecOneCheckoutProps) {
  const t: Required<ZecOneTheme> = useMemo(() => {
    if (props.theme === "dark") return DARK_THEME;
    if (props.theme === "light" || !props.theme) return LIGHT_THEME;
    return { ...LIGHT_THEME, ...props.theme };
  }, [props.theme]);
  const [checkout, setCheckout] = useState<CheckoutView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set when the link itself is refused (wrong or missing token, unknown id).
  const [linkInvalid, setLinkInvalid] = useState(false);
  // An error arrived after the last verified update: hide payment details until re-verified.
  const [stale, setStale] = useState(false);
  const [watcher, setWatcher] = useState<{ ready: boolean } | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [skew, setSkew] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);

  const { apiBaseUrl, paymentId, checkoutToken, intervalMs, onStatusChange, onCompleted, onExpired, onFailed, onError } = props;
  useEffect(() => {
    setCheckout(null);
    setError(null);
    setLinkInvalid(false);
    setStale(false);
    let stop = () => {};
    stop = watchCheckout(apiBaseUrl, paymentId, checkoutToken, {
      intervalMs,
      onUpdate: (c) => {
        const local = Math.floor(Date.now() / 1000);
        const serverTime = Number.isSafeInteger(c.serverTime) ? c.serverTime : local;
        setError(null);
        setStale(false);
        setSkew(serverTime - local);
        setCheckout(c);
        onStatusChange?.(c);
        // Callbacks follow the verified presentation, never the raw state alone.
        const p = presentCheckout(c, { now: serverTime, expectedId: paymentId });
        if (p.status === "COMPLETED" || p.status === "SIMULATED_COMPLETE") onCompleted?.(c);
        if (p.status === "EXPIRED") onExpired?.(c);
        if (p.status === "FAILED") onFailed?.(c);
      },
      onError: (e) => {
        if (e.status === 400 || e.status === 401 || e.status === 403 || e.status === 404) {
          // The token is wrong or the checkout does not exist: stop and never show cached details.
          setLinkInvalid(true);
          setCheckout(null);
          stop();
        } else {
          setStale(true);
          setError("Connection lost. Payment details are hidden until this checkout is verified again. Retrying…");
        }
        onError?.(e);
      },
    });
    return () => stop();
    // Callbacks are intentionally excluded: re-subscribing on every render would restart polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBaseUrl, paymentId, checkoutToken, intervalMs]);

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const p: CheckoutPresentation = linkInvalid
    ? presentStatus("INVALID_LINK")
    : !checkout
      ? presentStatus("LOADING")
      : presentCheckout(checkout, { now: now + skew, expectedId: paymentId, watcher, stale });

  // Real checkouts only: follow the public watcher health so a paused or
  // disagreeing provider set hides the payment request.
  const followWatcher = (p.mode === "mainnet" || p.mode === "live") && !TERMINAL.has(p.status);
  useEffect(() => {
    if (!followWatcher) return;
    const controller = new AbortController();
    const check = () => void fetchWatcherHealth(apiBaseUrl, { signal: controller.signal }).then((h) => !controller.signal.aborted && setWatcher(h));
    check();
    const id = setInterval(check, WATCHER_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, [apiBaseUrl, followWatcher]);

  const qr = useMemo(() => (p.payment ? qrSvg(p.payment.uri) : null), [p.payment?.uri]);

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(null), 1400);
    } catch {
      /* clipboard unavailable */
    }
  };

  const s = styles(t);
  const toneColor = (tone: CheckoutTone) =>
    tone === "success" ? t.success : tone === "danger" ? t.danger : tone === "warning" ? t.warning : tone === "info" ? t.text : t.muted;
  const statusBanner = (
    <div role="status" data-testid="zecone-status" data-status={p.status} style={s.notice(toneColor(p.tone))}>
      <strong style={{ letterSpacing: "0.04em" }}>{p.statusLabel}</strong>
      <span> — {p.statusDetail}</span>
      {p.issues.includes("completed_without_finalized_receipt") && (
        <span> The payment service reported completion without a finalized Base receipt, so it is not shown as paid.</span>
      )}
      {p.issues.includes("quote_expired_locally") && <span> The quote window has closed.</span>}
    </div>
  );

  if (p.status === "LOADING" || p.status === "INVALID_LINK") {
    return (
      <div className={props.className} style={s.root} data-zecone-checkout={p.phase} data-status={p.status} aria-busy={p.status === "LOADING"}>
        {p.status === "LOADING" ? (
          <div style={{ ...s.muted, padding: "28px 0", textAlign: "center" }}>{error ?? "Loading checkout…"}</div>
        ) : (
          statusBanner
        )}
      </div>
    );
  }

  // A view that failed validation shows nothing from it: no merchant, amount or address.
  if (p.status === "UNVERIFIED" && p.mode === "unknown") {
    return (
      <div className={props.className} style={s.root} data-zecone-checkout={p.phase} data-status={p.status}>
        {statusBanner}
      </div>
    );
  }

  const c = checkout!;
  const simulated = p.mode === "simulated";
  const pilot = p.mode === "mainnet" && c.settlement === "operator-approved";
  const completed = p.status === "COMPLETED" || p.status === "SIMULATED_COMPLETE";
  // Never advance the progress list to "Completed" without a verified completion.
  const current = completed ? CHECKOUT_STEPS.length : Math.min(stepIndex(c.state), CHECKOUT_STEPS.length - 2);
  const modeTone = simulated ? t.muted : p.mode === "live" ? t.success : t.warning;
  const pay = p.payment;
  return (
    <div className={props.className} style={s.root} data-zecone-checkout={p.phase} data-state={c.state} data-status={p.status} data-mode={p.mode}>
      <div style={s.modeStrip(modeTone, simulated)} data-testid="zecone-mode">
        <span style={{ fontWeight: 700, letterSpacing: "0.04em" }}>{p.modeLabel}</span>
        <span>{p.modeDetail}</span>
      </div>
      <div style={s.row}>
        <div style={{ minWidth: 0 }}>
          <div style={s.label}>Pay {c.merchant.name}</div>
          <div style={s.amount}>
            {simulated || !pay ? (c.quote?.zecAmount ?? "…") : pay.zecAmount} <span style={{ fontSize: 16, color: t.muted, fontWeight: 600 }}>ZEC</span>
          </div>
          <div style={s.muted}>
            {pilot
              ? `$${c.amountUsd}; the merchant's ETH on Base is priced live at settlement`
              : <>${c.amountUsd}, merchant receives {c.quote ? shortAmount(c.quote.ethPayout) : "…"} ETH on Base</>}
          </div>
        </div>
        <span style={s.badge(modeTone)}>{simulated ? "Simulated" : p.mode === "live" ? "Live" : pilot ? "Mainnet pilot" : "Mainnet, payout off"}</span>
      </div>

      {c.description && <div style={{ ...s.muted, marginTop: 6 }}>{c.description}</div>}

      {simulated && p.status === "SIMULATED" && p.phase === "awaiting" && (
        <div data-testid="zecone-example" style={s.example}>
          <div style={{ ...s.label, color: t.text }}>Example payment interface, simulated</div>
          <p style={{ margin: "6px 0 0", fontSize: 14 }}>
            This is a demo checkout, so there is nothing to pay and no address to send to. In a real checkout, the shielded
            Zcash address, the exact amount and a QR code for your wallet appear here.
          </p>
          <p style={{ ...s.muted, margin: "8px 0 0" }}>
            In a few seconds ZecOne replays the recorded mainnet pilot transactions through each step below. No funds move.
          </p>
        </div>
      )}

      {statusBanner}

      {pay && (
        <div data-testid="zecone-payment-request" style={{ marginTop: 16 }}>
          <div role="note" style={{ ...s.notice(t.warning), marginTop: 0 }}>
            {pilot
              ? `Restricted pilot. Only a payment sent from the pilot's integrated ZecOne wallet before the deadline is eligible for settlement; after ${c.minimumConfirmations ?? "the required"} confirmations the operator reviews and approves the Base payout. A payment from any other wallet is held for manual review, with no guaranteed payout or fixed price.`
              : "Real Zcash mainnet payment. Send exactly the amount shown, once. ZecOne observes it read-only; automatic payout is off."}{" "}
            This website is not a wallet and will never ask for your keys or seed.
          </div>
          <div style={{ display: "grid", gap: 14, marginTop: 14, gridTemplateColumns: props.compact ? "1fr" : "repeat(auto-fit, minmax(148px, auto))", alignItems: "center" }}>
            {qr && (
              <svg
                role="img"
                aria-label="Zcash payment QR code"
                viewBox={`0 0 ${qr.size} ${qr.size}`}
                width={props.compact ? 160 : 148}
                height={props.compact ? 160 : 148}
                style={{ background: "#fff", borderRadius: 12, border: `1px solid ${t.border}`, justifySelf: "center" }}
                shapeRendering="crispEdges"
                data-testid="zecone-qr"
              >
                <path d={qr.path} fill="#102820" />
              </svg>
            )}
            <div style={{ minWidth: 0 }}>
              <div style={s.label}>Send exactly</div>
              <div style={s.field}>
                <span style={{ fontWeight: 700 }} data-testid="zecone-amount">
                  {pay.zecAmount} ZEC
                </span>
                <button type="button" style={s.link} aria-label="Copy amount" onClick={() => copy("amount", pay.zecAmount)}>
                  {copied === "amount" ? "Copied" : "Copy"}
                </button>
              </div>
              <div style={{ ...s.muted, fontSize: 12.5, marginTop: 2 }}>{pay.zecAmountZat} zatoshis</div>
              <div style={{ ...s.label, marginTop: 10 }}>To this shielded address</div>
              <div style={{ ...s.field, alignItems: "flex-start" }}>
                <span style={s.mono} data-testid="zecone-address">
                  {pay.address}
                </span>
                <button type="button" style={s.link} aria-label="Copy address" onClick={() => copy("address", pay.address)}>
                  {copied === "address" ? "Copied" : "Copy"}
                </button>
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
                <a href={pay.uri} style={s.button} data-testid="zecone-uri">
                  Open in Zcash wallet
                </a>
                <span data-testid="zecone-expiry" style={{ ...s.muted, color: pay.secondsLeft < 120 ? t.warning : t.muted }}>
                  Quote expires in {formatCountdown(pay.secondsLeft)}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {p.confirmations && (
        <div style={{ marginTop: 14 }} data-testid="zecone-confirmations">
          <div style={s.muted}>
            Confirmations: {p.confirmations.current} / {p.confirmations.required}
          </div>
          <div
            role="progressbar"
            aria-label="Zcash confirmations"
            aria-valuemin={0}
            aria-valuemax={p.confirmations.required}
            aria-valuenow={p.confirmations.current}
            style={{ height: 6, borderRadius: 999, background: t.border, marginTop: 6, overflow: "hidden" }}
          >
            <div style={{ height: "100%", width: `${(100 * p.confirmations.current) / p.confirmations.required}%`, background: t.success }} />
          </div>
        </div>
      )}

      <ol style={s.steps} aria-label="Payment progress">
        {CHECKOUT_STEPS.map((step, i) => {
          const done = completed || i < current;
          const active = !done && i === current && (p.phase === "processing" || p.phase === "awaiting");
          return (
            <li key={step.key} style={s.step} data-done={done} data-active={active}>
              <span style={s.dot(done ? t.success : active ? t.accent : t.border, done || active, active ? t.accentText : t.background)}>{done ? "✓" : i + 1}</span>
              <span style={{ color: done || active ? t.text : t.muted, fontWeight: active ? 650 : 500 }}>
                {step.label}
                {active && p.phase === "processing" ? "…" : ""}
              </span>
            </li>
          );
        })}
      </ol>

      {p.receipt && (
        <div data-testid="zecone-receipt" style={s.notice(p.receipt.recorded ? t.muted : t.success)}>
          {p.receipt.recorded ? "Recorded pilot payout (replay, not for this checkout): " : "Finalized Base payout: "}
          <a href={p.receipt.explorerUrl} target="_blank" rel="noreferrer" style={{ color: "inherit", fontWeight: 650 }}>
            {p.receipt.recorded ? "View the recorded Base payout ↗" : "View Base payout ↗"}
          </a>
          <div style={{ ...s.mono, marginTop: 4 }}>{p.receipt.txHash}</div>
        </div>
      )}
      {error && <div style={{ ...s.muted, marginTop: 10, color: t.warning }}>{error}</div>}
      <div style={{ ...s.muted, marginTop: 16, paddingTop: 12, borderTop: `1px solid ${t.border}`, fontSize: 12.5 }}>
        {simulated
          ? "Simulated demo. No funds move and no payout is made for this checkout."
          : "Shielded on Zcash, public on Base, settled by a trusted ZecOne relayer. This page cannot sign, send or complete a payment."}
      </div>
    </div>
  );
}

function styles(t: Required<ZecOneTheme>) {
  return {
    root: {
      background: t.background,
      color: t.text,
      border: `1px solid ${t.border}`,
      borderRadius: t.radius,
      padding: 22,
      fontFamily: t.fontFamily,
      fontSize: 15,
      lineHeight: 1.5,
      boxSizing: "border-box",
      width: "100%",
    } as CSSProperties,
    row: { display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" } as CSSProperties,
    label: { fontSize: 13.5, fontWeight: 650, color: t.muted } as CSSProperties,
    amount: { fontFamily: DISPLAY_FONT, fontSize: 34, fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1.1, marginTop: 4 } as CSSProperties,
    muted: { color: t.muted, fontSize: 14 } as CSSProperties,
    mono: {
      fontFamily: MONO_FONT,
      fontSize: 13,
      wordBreak: "break-all",
      lineHeight: 1.45,
    } as CSSProperties,
    field: {
      display: "flex",
      justifyContent: "space-between",
      gap: 10,
      alignItems: "center",
      background: t.surface,
      border: `1px solid ${t.border}`,
      borderRadius: 12,
      padding: "10px 12px",
      marginTop: 4,
    } as CSSProperties,
    link: {
      background: "none",
      border: 0,
      color: t.text,
      fontWeight: 650,
      fontSize: 13.5,
      cursor: "pointer",
      padding: 0,
      flexShrink: 0,
      textDecoration: "underline",
      textUnderlineOffset: 3,
    } as CSSProperties,
    button: {
      display: "inline-block",
      background: t.accent,
      color: t.accentText,
      borderRadius: 999,
      padding: "10px 16px",
      fontWeight: 650,
      fontSize: 14,
      textDecoration: "none",
    } as CSSProperties,
    steps: { listStyle: "none", padding: 0, margin: "20px 0 0", display: "grid", gap: 10 } as CSSProperties,
    step: { display: "flex", gap: 12, alignItems: "center", fontSize: 14.5 } as CSSProperties,
    dot: (c: string, filled: boolean, ink: string) =>
      ({
        display: "inline-grid",
        placeItems: "center",
        width: 24,
        height: 24,
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 700,
        fontFamily: MONO_FONT,
        background: filled ? c : "transparent",
        color: filled ? ink : t.muted,
        border: `1.5px solid ${c}`,
        flexShrink: 0,
      }) as CSSProperties,
    badge: (c: string) =>
      ({
        fontSize: 12.5,
        fontWeight: 700,
        color: c,
        border: `1px solid ${c}`,
        borderRadius: 999,
        padding: "3px 10px",
        flexShrink: 0,
        whiteSpace: "nowrap",
      }) as CSSProperties,
    modeStrip: (c: string, dashed: boolean) =>
      ({
        display: "flex",
        flexWrap: "wrap",
        gap: "2px 10px",
        alignItems: "baseline",
        margin: "-22px -22px 18px",
        padding: "10px 22px",
        borderBottom: `1px ${dashed ? "dashed" : "solid"} ${c}`,
        borderRadius: `${t.radius}px ${t.radius}px 0 0`,
        background: t.surface,
        color: c,
        fontSize: 13.5,
      }) as CSSProperties,
    example: {
      marginTop: 16,
      border: `1.5px dashed ${t.muted}`,
      borderRadius: 14,
      padding: "14px 16px",
      background: t.surface,
    } as CSSProperties,
    notice: (c: string) =>
      ({
        marginTop: 14,
        border: `1px solid ${c}`,
        color: c,
        borderRadius: 12,
        padding: "12px 14px",
        fontSize: 14,
        background: t.surface,
      }) as CSSProperties,
  };
}

export default ZecOneCheckout;
