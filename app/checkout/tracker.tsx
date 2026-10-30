"use client";
import { useEffect, useRef, useState } from "react";
import type { UnifiedCheckout } from "../../services/wallet/checkouts";
import { SELECTION_KEY, restoreSelection } from "./selection";
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
    [revealing, setRevealing] = useState(false),
    [selectionExpires, setSelectionExpires] = useState(0),
    [privateDetails, setPrivateDetails] = useState<{
      key: string;
      paymentTx: string | null;
    } | null>(null);
  const selectionMeta = useRef({ scope: "", expires: 0 });
  const inspectionEpoch = useRef(0);
  useEffect(() => {
    if (!selectionExpires) return;
    const timer = setTimeout(
      () => {
        inspectionEpoch.current++;
        setRows([]);
        setSelected("");
        setRequest(null);
        setPrivateDetails(null);
        try {
          sessionStorage.removeItem(SELECTION_KEY);
        } catch {}
        setError(
          "Your checkout session expired. Pair locally again. No payment was retried.",
        );
      },
      Math.max(0, selectionExpires - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [selectionExpires]);
  useEffect(() => {
    inspectionEpoch.current++;
    setRequest(null);
    setPrivateDetails(null);
  }, [selected]);
  useEffect(() => {
    if (!request && !privateDetails) return;
    const timer = setTimeout(() => {
      setRequest(null);
      setPrivateDetails(null);
    }, 60000);
    return () => clearTimeout(timer);
  }, [request, privateDetails]);
  useEffect(() => {
    let active = true;
    try {
      localStorage.removeItem("zecone.checkout.selection");
    } catch {}
    const load = async () => {
      try {
        const r = await fetch("/api/checkouts", { cache: "no-store" });
        const b = await r.json();
        const expired =
          typeof b.selectionExpires === "number" &&
          b.selectionExpires <= Date.now();
        if (active && (r.status === 401 || r.status === 403 || expired)) {
          inspectionEpoch.current++;
          setRows([]);
          setSelected("");
          setRequest(null);
          setPrivateDetails(null);
          selectionMeta.current = { scope: "", expires: 0 };
          setSelectionExpires(0);
          try {
            sessionStorage.removeItem(SELECTION_KEY);
          } catch {}
        }
        if (!r.ok || expired || !Array.isArray(b.checkouts))
          throw Error("Checkout journals unavailable. No payment was retried.");
        if (active) {
          setRows(b.checkouts);
          const scope =
              typeof b.selectionScope === "string" ? b.selectionScope : "",
            expires =
              typeof b.selectionExpires === "number" ? b.selectionExpires : 0;
          selectionMeta.current = { scope, expires };
          setSelectionExpires(expires);
          let stored = "";
          try {
            stored = restoreSelection(
              sessionStorage.getItem(SELECTION_KEY),
              scope,
              expires,
              b.checkouts.map((r: UnifiedCheckout) => r.key),
            );
            if (!stored) sessionStorage.removeItem(SELECTION_KEY);
          } catch {}
          setSelected((prev) =>
            b.checkouts.some((r: UnifiedCheckout) => r.key === prev)
              ? prev
              : stored || "",
          );
          setError("");
        }
      } catch (e) {
        if (active)
          setError("Checkout journals unavailable. No payment was retried.");
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
              setRequest(null);
              setPrivateDetails(null);
              try {
                const m = selectionMeta.current;
                if (m.scope && m.expires > Date.now())
                  sessionStorage.setItem(
                    SELECTION_KEY,
                    JSON.stringify({
                      scope: m.scope,
                      expires: m.expires,
                      key: e.target.value,
                    }),
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
              <p className="muted">
                Private local inspection can link shielded funding to a public
                destination. The trusted operator can already correlate both. Do
                not share this view. Revealed details clear after one minute.
              </p>
              <button
                className="secondary"
                disabled={revealing}
                onClick={async () => {
                  setRevealing(true);
                  const epoch = inspectionEpoch.current;
                  setError("");
                  setPrivateDetails(null);
                  try {
                    const s = await (
                      await fetch("/api/session", { cache: "no-store" })
                    ).json();
                    const response = await fetch("/api/checkouts/inspect", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "X-ZecOne-CSRF": s.csrf,
                      },
                      body: JSON.stringify({
                        id: row.id,
                        kind: row.kind,
                        reveal: true,
                        acceptPrivacy: true,
                      }),
                      cache: "no-store",
                    });
                    const b = await response.json();
                    if (!response.ok) throw Error("Inspection unavailable");
                    if (epoch !== inspectionEpoch.current) return;
                    setPrivateDetails({
                      key: row.key,
                      paymentTx: b.paymentTx ?? null,
                    });
                  } catch {
                    setError(
                      "Private inspection unavailable. Verify this session or ask the local operator; no payment was retried.",
                    );
                  } finally {
                    setRevealing(false);
                  }
                }}
              >
                Inspect private payment reference locally
              </button>
              {privateDetails?.key === row.key && (
                <p className="mono break">
                  {privateDetails.paymentTx ?? "No payment reference available"}
                </p>
              )}
              {row.state === "PAYMENT_REQUEST" && (
                <div>
                  <button
                    className="secondary"
                    disabled={revealing}
                    onClick={async () => {
                      if (revealing) return;
                      setRevealing(true);
                      const epoch = inspectionEpoch.current;
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
                        if (epoch === inspectionEpoch.current)
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
