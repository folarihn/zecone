"use client";
import { useEffect, useRef, useState } from "react";
type Quote = {
  id: string;
  digest: string;
  expires: number;
  terms: {
    network: string;
    nft: string;
    tokenId: string;
    recipient: string;
    priceWei: string;
    zatoshis: string;
    gasBudgetWei: string;
    estimatedFeeWei: string;
    slippageBps: number;
  };
};
export default function CheckoutHandoff({
  requestId,
  origin,
  invoke,
}: {
  requestId: string;
  origin: string;
  invoke: (path: string, body: unknown) => Promise<any>;
}) {
  const [quote, setQuote] = useState<Quote | null>(null),
    [reviewed, setReviewed] = useState(false),
    [handoff, setHandoff] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function run(action: "quote" | "review" | "create") {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (action !== "quote" && (!quote || Date.now() >= quote.expires))
        throw Error("Quote expired. Request and review a fresh quote.");
      const data = await invoke(
        `dapps/${action === "quote" ? "intent-quote" : action === "review" ? "intent-quote-review" : "intent-checkout-preview"}`,
        action === "quote"
          ? { id: requestId }
          : {
              id: requestId,
              quoteId: quote!.id,
              digest: quote!.digest,
              approved: true,
            },
      );
      if (!active.current) return;
      if (data.executionAuthorized !== false)
        throw Error("Unexpected checkout authority; stopped.");
      if (action === "quote") {
        if (
          data.mode !== "dry-run" ||
          data.terms?.network !== "eip155:84532" ||
          data.terms?.slippageBps !== 0 ||
          !Number.isSafeInteger(data.expires) ||
          data.expires <= Date.now() ||
          typeof data.id !== "string" ||
          typeof data.digest !== "string"
        )
          throw Error("Invalid preview quote.");
        setQuote({
          id: data.id,
          digest: data.digest,
          expires: data.expires,
          terms: {
            network: data.terms.network,
            nft: data.terms.nft,
            tokenId: data.terms.tokenId,
            recipient: data.terms.recipient,
            priceWei: data.terms.priceWei,
            zatoshis: data.terms.zatoshis,
            gasBudgetWei: data.terms.gasBudgetWei,
            estimatedFeeWei: data.terms.estimatedFeeWei,
            slippageBps: 0,
          },
        });
        setReviewed(false);
      } else if (action === "review") {
        if (data.reviewed !== true || data.checkoutCreated !== false)
          throw Error("Quote review failed.");
        setReviewed(true);
      } else {
        if (
          data.mode !== "dry-run" ||
          data.financialCheckoutCreated !== false ||
          data.paymentRequestCreated !== false
        )
          throw Error("Unexpected payment state; stopped.");
        setHandoff(true);
      }
    } catch (e: any) {
      if (active.current)
        setError(e.message || "Checkout preview unavailable.");
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <section className="approval-card" aria-label="ZEC checkout rehearsal">
      <h2>ZEC checkout rehearsal</h2>
      <p>Requesting dApp: {origin}</p>
      <p className="notice">
        Dry run only. No payment address, signature, broadcast or relayer
        execution will be created.
      </p>
      {error && <p role="alert">{error}</p>}
      {handoff ? (
        <p role="status">
          Dry-run checkout ready. No financial checkout or payment request
          exists.
        </p>
      ) : (
        <>
          {quote && (
            <dl className="review-list">
              <div>
                <dt>Network</dt>
                <dd>Base Sepolia · 84532</dd>
              </div>
              <div>
                <dt>Destination</dt>
                <dd className="break">
                  One ERC721 NFT · {quote.terms.nft} · token{" "}
                  {quote.terms.tokenId}
                </dd>
              </div>
              <div>
                <dt>Recipient</dt>
                <dd className="break">{quote.terms.recipient}</dd>
              </div>
              <div>
                <dt>Destination price</dt>
                <dd>{quote.terms.priceWei} wei</dd>
              </div>
              <div>
                <dt>Testnet ZEC cost</dt>
                <dd>{quote.terms.zatoshis} zatoshis (TAZ)</dd>
              </div>
              <div>
                <dt>Maximum gas reserve</dt>
                <dd>{quote.terms.gasBudgetWei} wei</dd>
              </div>
              <div>
                <dt>Preliminary buy-call fee estimate</dt>
                <dd>
                  {quote.terms.estimatedFeeWei} wei; signed executor simulation
                  still required
                </dd>
              </div>
              <div>
                <dt>Slippage</dt>
                <dd>0%</dd>
              </div>
              <div>
                <dt>Quote expiry</dt>
                <dd>{new Date(quote.expires).toISOString()}</dd>
              </div>
            </dl>
          )}
          <p>
            Fixed testnet demonstration pricing, not a market exchange rate. The
            fixed gas reserve would be charged even if unused. A trusted
            prefunded relayer supplies destination gas and can correlate source
            payment with the public NFT purchase. Destination ownership is
            public.
          </p>
          <div className="approval-actions">
            <button disabled={busy} onClick={() => run("quote")}>
              {quote ? "Get fresh quote" : "Get checkout quote"}
            </button>
            {quote && !reviewed && (
              <button disabled={busy} onClick={() => run("review")}>
                Review quote only
              </button>
            )}
            {quote && reviewed && (
              <button disabled={busy} onClick={() => run("create")}>
                Authorize dry-run checkout
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
