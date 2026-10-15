"use client";
import { useEffect, useRef, useState } from "react";
import { useClock, reviewExpired } from "../checkout/clock";
import CheckoutTerms from "../checkout/terms";
const amount = (v: string, d = 8) => {
  const n = BigInt(v),
    base = 10n ** BigInt(d);
  return `${n / base}.${(n % base).toString().padStart(d, "0").replace(/0+$/, "") || "0"}`;
};
export default function PurchasePanel({ id }: { id?: string }) {
  const clock = useClock(),
    inFlight = useRef(false);
  const [rows, setRows] = useState<any[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [review, setReview] = useState<any>(null);
  const csrf = useRef(""),
    dialog = useRef<HTMLDialogElement>(null);
  async function api(path: string, body?: unknown) {
    if (!csrf.current) {
      const s = await (
        await fetch("/api/session", { cache: "no-store" })
      ).json();
      csrf.current = s.csrf || "";
    }
    const r = await fetch(`/api/purchases/${path}`, {
      method: body ? "POST" : "GET",
      headers: body
        ? { "Content-Type": "application/json", "X-ZecOne-CSRF": csrf.current }
        : {},
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const v = await r.json();
    if (!r.ok) throw Error(v.error || "Purchase status unavailable");
    return v;
  }
  async function refresh() {
    try {
      const r = await api("list");
      setRows(r.purchases);
      setError("");
    } catch (e: any) {
      setError(e.message);
    }
  }
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (review) dialog.current?.showModal();
  }, [review]);
  async function fee(row: any) {
    setBusy(true);
    setError("");
    try {
      setReview(await api("fee", { id: row.id }));
    } catch (e: any) {
      setError(e.message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function pay() {
    if (!review || inFlight.current || reviewExpired(review, Date.now()))
      return;
    inFlight.current = true;
    setBusy(true);
    try {
      await api("pay", {
        id: review.id,
        quoteId: review.fee.id,
        approved: true,
      });
      setReview(null);
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  const selected = rows.filter((r) => !id || r.id === id);
  return (
    <section aria-label="Marketplace purchases">
      <h2>Marketplace purchases</h2>
      <p className="muted">
        Shielded Testnet ZEC payment · prefunded testnet purchase · direct NFT
        delivery
      </p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {!selected.length && (
        <p>
          No marketplace purchase has been approved. Start from the independent
          marketplace.
        </p>
      )}
      {selected.map((r) => (
        <article
          className="panel"
          key={r.id}
          style={{ padding: 20, marginBottom: 16 }}
        >
          <div className="eyebrow">SEPOLIA STUDIO · NFT #{r.tokenId}</div>
          <h3>{r.status}</h3>
          <p>
            {r.networkName ?? "Base Sepolia"} · chain {r.chainId ?? 84532}
          </p>
          {r.status === "Completed" && (
            <details>
              <summary>Historical approved terms</summary>
              <p>
                Historical record only. This does not create a new quote or
                payment.
              </p>
              <CheckoutTerms terms={r} />
            </details>
          )}
          <p className="mono break">{r.origin}</p>
          <dl className="review-list">
            <div>
              <dt>Collection / token</dt>
              <dd className="mono break">
                {r.nft} / {r.tokenId}
              </dd>
            </div>
            <div>
              <dt>Recipient</dt>
              <dd className="mono break">{r.recipient}</dd>
            </div>
            <div>
              <dt>NFT price</dt>
              <dd>{amount(r.price, 18)} test ETH</dd>
            </div>
            <div>
              <dt>Shielded payment</dt>
              <dd>{amount(r.zatoshis)} TAZ + native network fee</dd>
            </div>
            <div>
              <dt>Quote expiry</dt>
              <dd>{new Date(r.expiry * 1000).toLocaleString()}</dd>
            </div>
            <div>
              <dt>Payment confirmations</dt>
              <dd>
                {r.confirmations} / {r.requiredConfirmations}
              </dd>
            </div>
            <div>
              <dt>Ownership</dt>
              <dd>
                {r.ownerVerified
                  ? "Verified: this NFT belongs to your EVM account"
                  : "Not yet verified"}
              </dd>
            </div>
          </dl>
          {r.baseTx && (
            <a
              className="text-link break"
              href={`${r.explorer ?? "https://sepolia.basescan.org"}/tx/${r.baseTx}`}
              target="_blank"
              rel="noreferrer"
            >
              View purchase transaction
            </a>
          )}
          {r.manualRecovery && (
            <div className="notice">
              <strong>Manual recovery required</strong>
              <p>{r.refundPolicy}</p>
              <p>
                {r.recoveries?.map((x: any) => x.reason).join(", ") ||
                  "Interrupted local operation; reconcile before any further action."}
              </p>
              <p className="break">
                Saved refund destination: {r.refundDestination}
              </p>
            </div>
          )}
          {["awaiting", "quoted"].includes(r.stage) &&
            r.status === "Awaiting payment" && (
              <button
                className="primary"
                disabled={busy}
                onClick={() => fee(r)}
              >
                Review Zcash fee
              </button>
            )}
          {r.stage === "review" && (
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api("recheck", { id: r.id });
                  await refresh();
                } catch (e: any) {
                  setError(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Recheck saved purchase
            </button>
          )}
        </article>
      ))}
      {review && (
        <dialog
          ref={dialog}
          onCancel={() => setReview(null)}
          aria-labelledby="purchase-payment-title"
        >
          <h2 id="purchase-payment-title">Authorize shielded payment</h2>
          <p>
            Pay for Sepolia Studio NFT #{review.tokenId} on{" "}
            {review.networkName ?? "Base Sepolia"}. NFT delivery is public. The
            trusted provider can correlate this payment with the purchase.
          </p>
          <dl>
            <dt>Collection</dt>
            <dd className="mono break">{review.nft}</dd>
            <dt>Seller</dt>
            <dd className="mono break">{review.seller}</dd>
          </dl>
          <CheckoutTerms terms={review} />
          <div className="approval-actions">
            <button disabled={busy} onClick={() => setReview(null)}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={busy || reviewExpired(review, clock)}
              onClick={pay}
            >
              {busy ? "Authorizing…" : "Approve & pay test ZEC"}
            </button>
          </div>
        </dialog>
      )}
    </section>
  );
}
