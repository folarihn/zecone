"use client";
import { useEffect, useState } from "react";
import type { UnifiedCheckout } from "../../services/wallet/checkouts";
const steps = [
  "USER_REVIEW",
  "PAYMENT_REQUEST",
  "PAYMENT_CONFIRMATIONS",
  "DESTINATION_EXECUTION",
  "COMPLETED",
];
const labels: Record<string, string> = {
  USER_REVIEW: "User review",
  PAYMENT_REQUEST: "Payment request",
  PAYMENT_CONFIRMATIONS: "Zcash confirmations",
  DESTINATION_EXECUTION: "Destination execution",
  AWAITING_SOLANA_AUTHORIZATION: "Awaiting Solana authorization",
  COMPLETED: "Completed",
  RECOVERY_REQUIRED: "Recovery required",
  PAYMENT_EXPIRED: "Payment expired",
  EXECUTION_FAILED: "Execution failed",
  REFUND_AWAITING_AUTHORIZATION: "Refund awaiting authorization",
};
export default function CheckoutTracker({
  open,
}: {
  open: (kind: string) => void;
}) {
  const [rows, setRows] = useState<UnifiedCheckout[]>([]),
    [error, setError] = useState(""),
    [selected, setSelected] = useState(""),
    [loading, setLoading] = useState(true),
    [request, setRequest] = useState<{ id: string; address: string } | null>(
      null,
    ),
    [revealing, setRevealing] = useState(false);
  useEffect(() => {
    let active = true;
    try {
      setSelected(localStorage.getItem("zecone.checkout.selection") ?? "");
    } catch {}
    const load = async () => {
      try {
        const r = await fetch("/api/checkouts", { cache: "no-store" });
        const b = await r.json();
        if (!r.ok || !Array.isArray(b.checkouts))
          throw Error("Checkout journals unavailable. No payment was retried.");
        if (active) {
          setRows(b.checkouts);
          setError("");
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const row = rows.find((r) => r.key === selected) ?? rows[0];
  return (
    <section className="checkout-tracker" aria-label="Unified checkout tracker">
      <div className="section-heading">
        <div>
          <p className="eyebrow">SHIELDED ZEC CHECKOUT</p>
          <h2>One place to follow every payment</h2>
        </div>
        <span className="badge">Testnet settlement</span>
      </div>
      <p className="muted">
        Simulated pricing · trusted prefunded relayer. Public destination
        delivery. No trustless bridge or live refunds.
      </p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p role="status">Reading saved checkout journals…</p>
      ) : !rows.length && !error ? (
        <div className="empty-state">
          <h3>No saved checkouts</h3>
          <p>
            Choose an NFT mint, supported listing or swap. Review its exact
            terms before any payment.
          </p>
        </div>
      ) : null}
      {!!rows.length && (
        <>
          <label htmlFor="checkout-selection">Saved checkout</label>
          <select
            id="checkout-selection"
            value={row?.key ?? ""}
            onChange={(e) => {
              setSelected(e.target.value);
              try {
                localStorage.setItem(
                  "zecone.checkout.selection",
                  e.target.value,
                );
              } catch {}
            }}
          >
            {rows.map((r) => (
              <option key={r.key} value={r.key}>
                {r.kind} · {r.id.slice(0, 8)} · {labels[r.state]}
              </option>
            ))}
          </select>
          {row && (
            <article className="checkout-record">
              <h3>{labels[row.state] ?? "Review required"}</h3>
              <p className="mono break">{row.id}</p>
              <ol className="checkout-steps" aria-label="Checkout progress">
                {steps.map((s, i) => (
                  <li
                    key={s}
                    aria-current={row.state === s ? "step" : undefined}
                    className={steps.indexOf(row.state) >= i ? "reached" : ""}
                  >
                    <span>{i + 1}</span>
                    {labels[s]}
                  </li>
                ))}
              </ol>
              <details>
                <summary>Transaction details, fees and references</summary>
                <dl className="review-list">
                  <div>
                    <dt>Action / destination</dt>
                    <dd>
                      {row.kind} · {row.networkName}
                      {row.chainId === null ? "" : ` (${row.chainId})`}
                    </dd>
                  </div>
                  <div>
                    <dt>Source</dt>
                    <dd>Shielded TAZ · Zcash testnet</dd>
                  </div>
                  <div>
                    <dt>Receiving wallet</dt>
                    <dd className="mono break">{row.recipient}</dd>
                  </div>
                  <div>
                    <dt>Quoted payment</dt>
                    <dd>
                      {row.zatoshis === null
                        ? "See original signed terms"
                        : `${row.zatoshis} zatoshis`}
                    </dd>
                  </div>
                  <div>
                    <dt>Quote deadline</dt>
                    <dd>{new Date(row.expiry * 1000).toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Payment address</dt>
                    <dd className="mono break">
                      {row.paymentAddress ??
                        "Not allocated; open the original terms"}
                    </dd>
                  </div>
                  {row.fee?.feeZatoshis && (
                    <div>
                      <dt>Native fee ceiling</dt>
                      <dd>{row.fee.feeZatoshis} zatoshis</dd>
                    </div>
                  )}
                  <div>
                    <dt>Payment confirmations</dt>
                    <dd>
                      {row.confirmations} / {row.requiredConfirmations}
                    </dd>
                  </div>
                  {row.asset && (
                    <div>
                      <dt>Destination contract</dt>
                      <dd className="mono break">
                        {row.asset}
                        {row.tokenId ? ` / #${row.tokenId}` : ""}
                      </dd>
                    </div>
                  )}
                  {row.minOut && (
                    <div>
                      <dt>Minimum output / slippage</dt>
                      <dd>
                        {row.minOut} base units / {row.slippageBps} bps
                      </dd>
                    </div>
                  )}
                  {row.paymentTx && (
                    <div>
                      <dt>Zcash transaction</dt>
                      <dd className="mono break">{row.paymentTx}</dd>
                    </div>
                  )}
                  {row.destinationTx && (
                    <div>
                      <dt>Destination transaction</dt>
                      <dd className="mono break">{row.destinationTx}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Result verification</dt>
                    <dd>
                      {row.resultVerified
                        ? "Verified by settlement adapter"
                        : "Not yet verified"}
                    </dd>
                  </div>
                </dl>
              </details>
              {row.state === "PAYMENT_REQUEST" && (
                <div>
                  <button
                    className="secondary"
                    disabled={revealing}
                    onClick={async () => {
                      if (revealing) return;
                      setRevealing(true);
                      setError("");
                      try {
                        const session = await (
                          await fetch("/api/session", { cache: "no-store" })
                        ).json();
                        const response = await fetch(
                          "/api/checkouts/payment-request",
                          {
                            method: "POST",
                            headers: {
                              "Content-Type": "application/json",
                              "X-ZecOne-CSRF": session.csrf,
                            },
                            body: JSON.stringify({
                              id: row.id,
                              kind: row.kind,
                              reveal: true,
                            }),
                          },
                        );
                        const body = await response.json();
                        if (!response.ok)
                          throw Error(
                            body.error ?? "Payment address unavailable",
                          );
                        setRequest({ id: row.key, address: body.address });
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setRevealing(false);
                      }
                    }}
                  >
                    Inspect this payment address locally
                  </button>
                  <p className="muted">
                    Use the original review controls for payment. Do not send a
                    second payment to this address.
                  </p>
                  {request?.id === row.key && (
                    <p className="mono break">{request.address}</p>
                  )}
                </div>
              )}
              {row.recovery && (
                <p className="notice" role="status">
                  {row.recovery} Live refunds disabled. Do not pay again.
                </p>
              )}
              {row.state === "PAYMENT_EXPIRED" && (
                <p className="notice">
                  Quote expired. If you submitted a payment, reconcile its saved
                  reference before doing anything else.
                </p>
              )}
              <button className="secondary" onClick={() => open(row.kind)}>
                Open original review and recovery controls
              </button>
            </article>
          )}
        </>
      )}
    </section>
  );
}
