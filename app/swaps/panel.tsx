"use client";
import { useEffect, useRef, useState } from "react";
import CheckoutTerms from "../checkout/terms";
const units = (v: string, d = 18) => {
  const n = BigInt(v),
    b = 10n ** BigInt(d);
  return `${n / b}.${(n % b).toString().padStart(d, "0").replace(/0+$/, "") || "0"}`;
};
export default function SwapPanel() {
  const [assets, setAssets] = useState<any>(null),
    [rows, setRows] = useState<any[]>([]),
    [amount, setAmount] = useState("0.0001"),
    [slippage, setSlippage] = useState("100"),
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
    const r = await fetch(`/api/swaps/${path}`, {
      method: body ? "POST" : "GET",
      headers: body
        ? { "Content-Type": "application/json", "X-ZecOne-CSRF": csrf.current }
        : {},
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const j = await r.json();
    if (!r.ok) throw Error(j.error || "Swap request unavailable");
    return j;
  }
  async function refresh() {
    try {
      const list = await api("list");
      if (!Array.isArray(list.swaps)) throw Error("Swap status unavailable");
      setRows(list.swaps);
    } catch (e: any) {
      setError(e.message);
    }
  }
  useEffect(() => {
    void api("assets")
      .then(setAssets)
      .catch((e) => setError(e.message));
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (review) dialog.current?.showModal();
    else dialog.current?.close();
  }, [review]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (review?.type === "quote") await api("cancel", { id: review.data.id });
    setReview(null);
    await refresh();
  }
  return (
    <section className="swap-panel" aria-label="Token purchases">
      <h2>Buy test tokens</h2>
      <p className="muted">
        Shielded Testnet ZEC payment · actual AMM swap · public token ownership
      </p>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      <p className="notice">
        Simulated conversion: 1 TAZ = 0.02 test ETH. Your provider supplies ETH
        to a controlled test pool. Output can change while Zcash confirms.
        Manual recovery only.
      </p>
      <label>
        Destination network
        <select
          aria-label="Destination network"
          value="84532"
          onChange={() => {}}
        >
          <option value="84532">Base Sepolia</option>
          <option disabled>Ethereum Sepolia — swap not verified</option>
          <option disabled>Robinhood Testnet — swap not verified</option>
        </select>
      </label>
      {assets?.available ? (
        <>
          <label>
            Output token
            <select aria-label="Output token">
              <option value={assets.tokens[0].address}>
                ZTEST — allowlisted test token
              </option>
            </select>
          </label>
          <p>
            Token contract: <code>{assets.tokens[0].address}</code>
          </p>
          <p>
            Verified token balance at last refresh:{" "}
            {units(assets.tokens[0].balance)} ZTEST
          </p>
          <label>
            Purchase input (test ETH)
            <input
              aria-label="Purchase input (test ETH)"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <label>
            Slippage limit (basis points)
            <input
              aria-label="Slippage limit (basis points)"
              type="number"
              min="1"
              max="300"
              value={slippage}
              onChange={(e) => setSlippage(e.target.value)}
            />
          </label>
          <p className="muted">
            100 basis points = 1%. Maximum input: 0.0002 test ETH. You pay the
            reviewed ZEC amount and native Zcash fee.
          </p>
          <button
            className="primary"
            disabled={busy || !!review}
            onClick={() =>
              void act(async () => {
                const q = await api("quote", {
                  chainId: 84532,
                  token: assets.tokens[0].address,
                  amount,
                  slippageBps: Number(slippage),
                });
                setReview({ type: "quote", data: q });
                await refresh();
              })
            }
          >
            Get AMM quote
          </button>
        </>
      ) : (
        <p>
          Swap infrastructure is{" "}
          {assets ? "not deployed or verified" : "being checked"}. No token
          purchase is enabled.
        </p>
      )}
      <button
        disabled={busy}
        onClick={() =>
          void act(async () => {
            setAssets(await api("assets"));
            await refresh();
          })
        }
      >
        Refresh token balance
      </button>
      <div className="purchase-list">
        {rows.map((r) => (
          <article key={r.id} className="purchase-card">
            <h3>{r.status}</h3>
            {r.status === 'Completed' && <details><summary>Historical approved terms</summary><p>Historical record only. This does not create a new quote or payment.</p><CheckoutTerms terms={r}/></details>}
            <p>Base Sepolia · ZTEST · {r.id}</p>
            <p>
              Input: {units(r.amountIn)} test ETH · Minimum: {units(r.minOut)}{" "}
              ZTEST
            </p>
            <p>
              Payment: {units(r.zatoshis, 8)} TAZ + native fee · Confirmations:{" "}
              {r.confirmations} / 10
            </p>
            <p>
              Recipient: <code>{r.recipient}</code>
            </p>
            {r.receiptVerified && r.receipt ? (
              <p>
                Verified delivery: {units(r.receipt.amountOut)} ZTEST.
                Historical receipt balance: {units(r.receipt.balanceBefore)} →{" "}
                {units(r.receipt.balanceAfter)} ZTEST.
              </p>
            ) : null}
            {r.baseTx && (
              <a
                href={`https://sepolia.basescan.org/tx/${r.baseTx}`}
                target="_blank"
                rel="noreferrer"
              >
                View swap transaction
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
                Review saved quote
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
                  Review shielded payment
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
                Recheck saved swap
              </button>
            )}
          </article>
        ))}
      </div>
      <dialog
        ref={dialog}
        aria-labelledby="swap-review-title"
        onCancel={(e) => {
          e.preventDefault();
          if (!busy) void act(cancel);
        }}
      >
        {review && (
          <>
            <h2 id="swap-review-title">
              {review.type === "quote"
                ? "Approve exact token swap"
                : "Approve shielded swap payment"}
            </h2>
            <p>Base Sepolia · chain 84532</p>
            <dl>
              <dt>Recipient</dt>
              <dd>
                <code>{review.data.recipient}</code>
              </dd>
              <dt>Output token</dt>
              <dd>
                <code>{review.data.token}</code> · 18 decimals
              </dd>
              <dt>Router</dt>
              <dd>
                <code>{review.data.router}</code>
              </dd>
              <dt>Route</dt>
              <dd>{review.data.route.join(" → ")}</dd>
              <dt>Input</dt>
              <dd>{units(review.data.amountIn)} test ETH</dd>
              <dt>Expected output</dt>
              <dd>{units(review.data.expectedOut)} ZTEST</dd>
              <dt>Minimum received</dt>
              <dd>{units(review.data.minOut)} ZTEST</dd>
              <dt>Slippage</dt>
              <dd>{review.data.slippageBps} bps</dd>
              <dt>Quote reference block</dt>
              <dd>{review.data.referenceBlock}</dd>
              <dt>Execution deadline</dt>
              <dd>{new Date(review.data.expiry * 1000).toLocaleString()}</dd>
              <dt>ZEC price</dt>
              <dd>
                {units(review.data.zatoshis, 8)} TAZ (simulated rate; fixed gas
                reserve included)
              </dd>
              {review.type === "quote" ? (
                <>
                  <dt>Price impact including pool fee</dt>
                  <dd>{review.data.impactBps} bps</dd>
                  <dt>Estimated destination fee</dt>
                  <dd>{units(review.data.estimatedFee)} test ETH</dd>
                  <dt>Destination gas ceiling</dt>
                  <dd>{units(review.data.gasBudget)} test ETH</dd>
                </>
              ) : (
                <>
                  <dt>Native Zcash fee ceiling</dt>
                  <dd>{units(review.data.fee.feeZatoshis, 8)} TAZ</dd>
                  <dt>Total debit</dt>
                  <dd>{units(review.data.fee.totalZatoshis, 8)} TAZ</dd>
                </>
              )}
            </dl>
            <CheckoutTerms terms={review.data}/>
            <button disabled={busy} onClick={() => void act(cancel)}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={busy}
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
                ? "Approve exact swap intent"
                : "Send shielded payment"}
            </button>
          </>
        )}
      </dialog>
    </section>
  );
}
