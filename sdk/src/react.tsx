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
"use client";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  CHECKOUT_STEPS,
  formatCountdown,
  phaseOf,
  qrSvg,
  stepIndex,
  watchCheckout,
  type CheckoutView,
} from "./checkout.ts";
import type { ZecOneError } from "./types.ts";

/** Display rounding only (quotes stay exact to the wei). */
function shortAmount(v: string, places = 8): string {
  const [w, f = ""] = v.split(".");
  return f.length > places ? `≈${w}.${f.slice(0, places)}` : v;
}

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
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [skew, setSkew] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);

  const { apiBaseUrl, paymentId, checkoutToken, intervalMs, onStatusChange, onCompleted, onExpired, onFailed, onError } = props;
  useEffect(() => {
    setCheckout(null);
    setError(null);
    return watchCheckout(apiBaseUrl, paymentId, checkoutToken, {
      intervalMs,
      onUpdate: (c) => {
        setError(null);
        setSkew(c.serverTime - Math.floor(Date.now() / 1000));
        setCheckout(c);
        onStatusChange?.(c);
        if (c.state === "COMPLETED") onCompleted?.(c);
        if (c.state === "EXPIRED") onExpired?.(c);
        if (c.state === "FAILED") onFailed?.(c);
      },
      onError: (e) => {
        setError(e.status === 404 ? "This checkout link is invalid." : "Connection lost. Retrying…");
        onError?.(e);
      },
    });
    // Callbacks are intentionally excluded: re-subscribing on every render would restart polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBaseUrl, paymentId, checkoutToken, intervalMs]);

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const phase = phaseOf(checkout?.state ?? null);
  const remaining = checkout?.expiresAt ? checkout.expiresAt - (now + skew) : null;
  const qr = useMemo(() => (checkout?.paymentUri ? qrSvg(checkout.paymentUri) : null), [checkout?.paymentUri]);

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
  if (!checkout) {
    return (
      <div className={props.className} style={s.root} data-zecone-checkout="loading" aria-busy="true">
        <div style={{ ...s.muted, padding: "28px 0", textAlign: "center" }}>{error ?? "Loading checkout…"}</div>
      </div>
    );
  }

  const current = stepIndex(checkout.state);
  const mode = checkout.simulated ? "simulated" : checkout.mode === "monitor" ? "monitor" : "live";
  const modeTone = mode === "live" ? t.success : mode === "monitor" ? t.warning : t.muted;
  return (
    <div className={props.className} style={s.root} data-zecone-checkout={phase} data-state={checkout.state}>
      <div style={s.modeStrip(modeTone, mode === "simulated")}>
        <span style={{ fontWeight: 700 }}>
          {mode === "simulated" ? "Simulated demo" : mode === "monitor" ? "Mainnet monitoring" : "Live checkout"}
        </span>
        <span>
          {mode === "simulated"
            ? "Nothing to pay. No funds move."
            : mode === "monitor"
              ? "Real ZEC is detected. Automatic payout is off."
              : "Payment settles to the merchant on Base."}
        </span>
      </div>
      <div style={s.row}>
        <div>
          <div style={s.label}>Pay {checkout.merchant.name}</div>
          <div style={s.amount}>
            {checkout.quote?.zecAmount ?? "…"} <span style={{ fontSize: 16, color: t.muted, fontWeight: 600 }}>ZEC</span>
          </div>
          <div style={s.muted}>
            ${checkout.amountUsd}, merchant receives {checkout.quote ? shortAmount(checkout.quote.ethPayout) : "…"} ETH on Base
          </div>
        </div>
        <span style={s.badge(checkout.mode === "live" ? t.success : t.warning)}>
          {checkout.simulated ? "Simulated" : checkout.mode === "monitor" ? "Mainnet, payout off" : "Live"}
        </span>
      </div>

      {checkout.description && <div style={{ ...s.muted, marginTop: 6 }}>{checkout.description}</div>}

      {checkout.simulated && phase === "awaiting" && (
        <div data-testid="zecone-example" style={s.example}>
          <div style={{ ...s.label, color: t.text }}>Example payment interface, simulated</div>
          <p style={{ margin: "6px 0 0", fontSize: 14 }}>
            This is a demo checkout, so there is nothing to pay and no address to send to. In a live checkout, the shielded
            Zcash address, the exact amount and a QR code for your wallet appear here.
          </p>
          <p style={{ ...s.muted, margin: "8px 0 0" }}>
            In a few seconds ZecOne replays the recorded mainnet pilot transactions through each step below. No funds move.
            {remaining !== null && remaining > 0 ? ` Quote window: ${formatCountdown(remaining)}.` : ""}
          </p>
        </div>
      )}

      {checkout.mode === "monitor" && phase === "awaiting" && checkout.zcashAddress && (
        <div role="note" style={s.notice(t.warning)}>
          Real Zcash mainnet address. ZecOne will detect and confirm your payment, but automatic payout to the merchant is
          disabled in this build. Only pay if the merchant asked you to.
        </div>
      )}

      {phase === "awaiting" && !checkout.simulated && checkout.zcashAddress && (
        <div style={{ display: "grid", gap: 14, marginTop: 16, gridTemplateColumns: props.compact ? "1fr" : "auto 1fr", alignItems: "center" }}>
          {qr && (
            <svg
              role="img"
              aria-label="Zcash payment QR code"
              viewBox={`0 0 ${qr.size} ${qr.size}`}
              width={props.compact ? 160 : 148}
              height={props.compact ? 160 : 148}
              style={{ background: "#fff", borderRadius: 12, border: `1px solid ${t.border}`, justifySelf: "center" }}
              shapeRendering="crispEdges"
            >
              <path d={qr.path} fill="#102820" />
            </svg>
          )}
          <div style={{ minWidth: 0 }}>
            <div style={s.label}>Send exactly</div>
            <div style={s.field}>
              <span style={{ fontWeight: 700 }}>{checkout.quote?.zecAmount} ZEC</span>
              <button type="button" style={s.link} onClick={() => copy("amount", checkout.quote?.zecAmount ?? "")}>
                {copied === "amount" ? "Copied" : "Copy"}
              </button>
            </div>
            <div style={{ ...s.label, marginTop: 10 }}>To this shielded address</div>
            <div style={{ ...s.field, alignItems: "flex-start" }}>
              <span style={s.mono} data-testid="zecone-address">
                {checkout.zcashAddress}
              </span>
              <button type="button" style={s.link} onClick={() => copy("address", checkout.zcashAddress ?? "")}>
                {copied === "address" ? "Copied" : "Copy"}
              </button>
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
              {checkout.paymentUri && (
                <a href={checkout.paymentUri} style={s.button}>
                  Open in Zcash wallet
                </a>
              )}
              {remaining !== null && (
                <span style={{ ...s.muted, color: remaining < 120 ? t.warning : t.muted }}>
                  Quote expires in {formatCountdown(remaining)}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {!checkout.simulated && checkout.confirmations !== null && checkout.minimumConfirmations !== null && phase !== "awaiting" && (
        <div style={{ ...s.muted, marginTop: 14 }} data-testid="zecone-confirmations">
          Confirmations: {Math.min(checkout.confirmations, checkout.minimumConfirmations)} / {checkout.minimumConfirmations}
          {checkout.state === "ZEC_CONFIRMED" && checkout.settlement === "disabled" ? ". ZEC confirmed; Base payout is disabled in this build." : ""}
        </div>
      )}

      <ol style={s.steps} aria-label="Payment progress">
        {CHECKOUT_STEPS.map((step, i) => {
          const done = phase === "completed" || i < current;
          const active = !done && i === current && (phase === "processing" || phase === "awaiting");
          return (
            <li key={step.key} style={s.step} data-done={done} data-active={active}>
              <span style={s.dot(done ? t.success : active ? t.accent : t.border, done || active, active ? t.accentText : t.background)}>{done ? "✓" : i + 1}</span>
              <span style={{ color: done || active ? t.text : t.muted, fontWeight: active ? 650 : 500 }}>
                {step.label}
                {active && phase === "processing" ? "…" : ""}
              </span>
            </li>
          );
        })}
      </ol>

      {phase === "completed" && (
        <div role="status" style={s.notice(t.success)}>
          {checkout.simulated
            ? "Simulated payment complete: a replay of recorded mainnet pilot transactions. No funds moved for this checkout."
            : "Payment complete."}
          {checkout.payoutExplorerUrl && (
            <>
              {" "}
              <a href={checkout.payoutExplorerUrl} target="_blank" rel="noreferrer" style={{ color: "inherit", fontWeight: 650 }}>
                {checkout.simulated ? "View the recorded Base payout ↗" : "View Base payout ↗"}
              </a>
            </>
          )}
        </div>
      )}
      {phase === "expired" && (
        <div role="status" style={s.notice(t.danger)}>
          This payment request expired before a payment arrived. Do not send ZEC to it. Ask the merchant for a new link.
        </div>
      )}
      {phase === "failed" && (
        <div role="status" style={s.notice(t.danger)}>
          This payment failed. The merchant has been notified.
        </div>
      )}
      {phase === "review" && (
        <div role="status" style={s.notice(t.warning)}>
          Your payment is under manual review (for example, an amount mismatch). The merchant will follow up.
        </div>
      )}
      {error && <div style={{ ...s.muted, marginTop: 10, color: t.warning }}>{error}</div>}
      <div style={{ ...s.muted, marginTop: 16, paddingTop: 12, borderTop: `1px solid ${t.border}`, fontSize: 12.5 }}>
        Shielded on Zcash, public on Base, settled by a trusted ZecOne relayer.
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
