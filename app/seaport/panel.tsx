"use client";
import { useEffect, useRef, useState } from "react";
import OpenSeaPanel from "../opensea/panel";
import { useClock, reviewExpired } from "../checkout/clock";
import CheckoutTerms from "../checkout/terms";
const units = (v: string, d = 18) => {
  const n = BigInt(v),
    b = 10n ** BigInt(d);
  return `${n / b}.${(n % b).toString().padStart(d, "0").replace(/0+$/, "") || "0"}`;
};
export default function SeaportPanel() {
  const clock = useClock(),
    inFlight = useRef(false);
  const [catalog, setCatalog] = useState<any>(null),
    [rows, setRows] = useState<any[]>([]),
    [review, setReview] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const csrf = useRef(""),
    dialog = useRef<HTMLDialogElement>(null);
  async function api(path: string, body?: unknown) {
    if (!csrf.current)
      csrf.current = (
        await (await fetch("/api/session", { cache: "no-store" })).json()
      ).csrf;
    const r = await fetch(`/api/seaport/${path}`, {
      method: body ? "POST" : "GET",
      headers: body
        ? { "Content-Type": "application/json", "X-ZecOne-CSRF": csrf.current }
        : {},
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const j = await r.json();
    if (!r.ok) throw Error(j.error || "Seaport request unavailable");
    return j;
  }
  async function refresh() {
    try {
      const j = await api("list");
      if (!Array.isArray(j.purchases))
        throw Error("Seaport status unavailable");
      setRows(j.purchases);
    } catch (e: any) {
      setError(e.message);
    }
  }
  useEffect(() => {
    void api("catalog")
      .then(setCatalog)
      .catch((e) => setError(e.message));
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (review) dialog.current?.showModal();
    else dialog.current?.close();
  }, [review]);
  async function act(fn: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function cancel() {
    if (review?.type === "quote") await api("cancel", { id: review.data.id });
    setReview(null);
    await refresh();
  }
  return (
    <section className="swap-panel" aria-label="Seaport purchases">
      <OpenSeaPanel />
      <h2>Seaport test listings</h2>
      <p className="notice">
        Controlled seller-signed listings on Seaport 1.6 · Base Sepolia. These
        are not OpenSea API listings. ZecOne is not affiliated with OpenSea.
      </p>
      <p className="muted">
        Simulated rate: 1 TAZ = 0.02 test ETH. The provider pays ETH; NFT
        ownership is public. A listing may sell or expire while Zcash confirms.
        Failed paid orders need manual recovery.
      </p>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {!catalog ? (
        <p>Checking genuine Seaport deployment and listing availability…</p>
      ) : (
        <p>{catalog.apiStatus}</p>
      )}
      {catalog?.listings?.map((l: any) => (
        <article className="purchase-card" key={l.orderHash}>
          <h3>Sepolia Studio · Token #{l.tokenId}</h3>
          <p>
            Base Sepolia · Controlled Seaport test listing ·{" "}
            {l.available
              ? "Available at last check"
              : "Unavailable at last check"}
          </p>
          <p>
            Collection: <code>{l.nft}</code>
          </p>
          <p>
            Seller: <code>{l.seller}</code>
          </p>
          <p>
            Total consideration: {units(l.price)} test ETH · Included test fee:{" "}
            {units(l.feeAmount)} ETH
          </p>
          <p>
            Seaport {l.protocolVersion}: <code>{l.protocol}</code>
          </p>
          <p>Expires: {new Date(Number(l.expiry) * 1000).toLocaleString()}</p>
          <button
            className="primary"
            disabled={busy || !l.available || !!review}
            onClick={() =>
              void act(async () => {
                const q = await api("quote", {
                  chainId: l.chainId,
                  orderHash: l.orderHash,
                });
                setReview({ type: "quote", data: q });
                await refresh();
              })
            }
          >
            Review Seaport purchase
          </button>
        </article>
      ))}
      <button
        disabled={busy}
        onClick={() =>
          void act(async () => {
            setCatalog(await api("catalog"));
            await refresh();
          })
        }
      >
        Refresh listing and ownership
      </button>
      <div className="purchase-list">
        {rows.map((r) => (
          <article className="purchase-card" key={r.id}>
            <h3>{r.status}</h3>
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
            <p>
              Base Sepolia · Seaport 1.6 · Token #{r.tokenId} · {r.id}
            </p>
            <p>
              Collection: <code>{r.nft}</code>
            </p>
            <p>
              Recipient: <code>{r.recipient}</code>
            </p>
            <p>
              Shielded payment: {units(r.zatoshis, 8)} TAZ + native fee ·
              Confirmations: {r.confirmations} / 10
            </p>
            <p>
              Order: <code>{r.orderHash}</code>
            </p>
            {r.ownerVerified && (
              <p>
                Verified NFT delivery to your wallet at the fulfillment block.
              </p>
            )}
            {r.baseTx && (
              <a
                href={`https://sepolia.basescan.org/tx/${r.baseTx}`}
                target="_blank"
                rel="noreferrer"
              >
                View Seaport fulfillment
              </a>
            )}
            {r.manualRecovery && (
              <p role="status">
                Manual recovery required. No refund has been sent. Do not pay
                again.
              </p>
            )}
            {r.stage === "draft" && r.status === "Awaiting quote approval" && (
              <button
                disabled={busy}
                onClick={() => setReview({ type: "quote", data: r })}
              >
                Review saved Seaport quote
              </button>
            )}
            {["awaiting", "quoted"].includes(r.stage) &&
              r.status === "Awaiting payment" && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(async () =>
                      setReview({
                        type: "payment",
                        data: await api("fee", { id: r.id }),
                      }),
                    )
                  }
                >
                  Review shielded Seaport payment
                </button>
              )}
            {r.stage === "review" && (
              <button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api("recheck", { id: r.id });
                    await refresh();
                  })
                }
              >
                Recheck saved Seaport purchase
              </button>
            )}
          </article>
        ))}
      </div>
      <dialog
        ref={dialog}
        aria-labelledby="seaport-review-title"
        onCancel={(e) => {
          e.preventDefault();
          if (!busy) void act(cancel);
        }}
      >
        {review && (
          <>
            <h2 id="seaport-review-title">
              {review.type === "quote"
                ? "Approve exact Seaport purchase"
                : "Approve shielded Seaport payment"}
            </h2>
            <p>Controlled Seaport test listing · Base Sepolia · chain 84532</p>
            <dl>
              <dt>Collection / token</dt>
              <dd>
                <code>{review.data.nft}</code> / {review.data.tokenId}
              </dd>
              <dt>Recipient</dt>
              <dd>
                <code>{review.data.recipient}</code>
              </dd>
              <dt>Seller</dt>
              <dd>
                <code>{review.data.seller}</code>
              </dd>
              <dt>Seaport 1.6</dt>
              <dd>
                <code>{review.data.protocol}</code>
              </dd>
              <dt>Order hash</dt>
              <dd>
                <code>{review.data.orderHash}</code>
              </dd>
              <dt>Seller price</dt>
              <dd>{units(review.data.sellerAmount)} test ETH</dd>
              <dt>Controlled test fee</dt>
              <dd>
                {units(review.data.feeAmount)} ETH to{" "}
                <code>{review.data.feeRecipient}</code>
              </dd>
              <dt>Total consideration</dt>
              <dd>{units(review.data.price)} test ETH</dd>
              <dt>Estimated destination fee</dt>
              <dd>{units(review.data.estimatedFee)} test ETH</dd>
              <dt>Gas ceiling</dt>
              <dd>{units(review.data.gasBudget)} test ETH</dd>
              <dt>Shielded payment</dt>
              <dd>
                {units(review.data.zatoshis, 8)} TAZ, simulated rate and fixed
                gas reserve
              </dd>
              <dt>Approval expiry</dt>
              <dd>{new Date(review.data.expiry * 1000).toLocaleString()}</dd>
              <dt>Approval route</dt>
              <dd>
                Direct seller approval to Seaport; no conduits, tips or partial
                fills.
              </dd>
              {review.type === "payment" && (
                <>
                  <dt>Native Zcash fee ceiling</dt>
                  <dd>{units(review.data.fee.feeZatoshis, 8)} TAZ</dd>
                  <dt>Total shielded debit</dt>
                  <dd>{units(review.data.fee.totalZatoshis, 8)} TAZ</dd>
                </>
              )}
            </dl>
            <CheckoutTerms terms={review.data} />
            <button disabled={busy} onClick={() => void act(cancel)}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={busy || reviewExpired(review.data, clock)}
              onClick={() =>
                void act(async () => {
                  const r = review;
                  if (r.type === "quote")
                    await api("approve", { id: r.data.id, approved: true });
                  else
                    await api("pay", {
                      id: r.data.id,
                      quoteId: r.data.fee.id,
                      approved: true,
                    });
                  setReview(null);
                  await refresh();
                })
              }
            >
              {review.type === "quote"
                ? "Approve exact Seaport intent"
                : "Send shielded Seaport payment"}
            </button>
          </>
        )}
      </dialog>
    </section>
  );
}
