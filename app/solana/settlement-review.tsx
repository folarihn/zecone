"use client";
import { useEffect, useState } from "react";
import { formatUnits } from "viem";
export default function SettlementReviewPanel() {
  const [recipients, setRecipients] = useState<string[]>([]),
    [recipient, setRecipient] = useState(""),
    [action, setAction] = useState("transfer"),
    [review, setReview] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void fetch("/api/settlement-review/config", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) return;
        const data = await r.json();
        if (
          active &&
          Array.isArray(data.recipients) &&
          data.financialCreationEnabled === false
        ) {
          setRecipients(data.recipients);
          setRecipient(data.recipients[0] ?? "");
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  if (!recipients.length) return null;
  return (
    <section
      className="panel account-panel"
      aria-label="Settlement economic review"
    >
      <h2>ZEC-funded transaction review</h2>
      <p>
        Solana devnet only. Review terms without paying or signing. Fixed
        testnet demo pricing; trusted prefunded relayer. Local pairing is not
        wallet ownership verification.
      </p>
      <label>
        Action
        <select
          disabled={busy}
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
            setReview(null);
          }}
        >
          <option value="transfer">Deliver 0.001 SOL</option>
          <option value="swap">Swap 0.001 WSOL on the supported pool</option>
        </select>
      </label>
      <label>
        Registered recipient
        <select
          disabled={busy}
          value={recipient}
          onChange={(e) => {
            setRecipient(e.target.value);
            setReview(null);
          }}
        >
          {recipients.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </label>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          setReview(null);
          try {
            const session = await fetch("/api/session", {
              cache: "no-store",
            }).then((r) => r.json());
            const response = await fetch("/api/settlement-review", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-ZecOne-CSRF": session.csrf,
              },
              body: JSON.stringify({ action, recipient, lamports: "1000000" }),
            });
            const data = await response.json();
            if (!response.ok) throw Error(data.error || "Review unavailable.");
            if (
              data.executionAuthorized !== false ||
              data.financialOrderCreated !== false
            )
              throw Error("Unexpected financial state.");
            setReview(data);
          } catch {
            setError(
              "Review unavailable. No payment or execution was authorized.",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        Review economic terms only
      </button>
      {error && <p role="alert">{error}</p>}
      {review && (
        <div role="status" style={{ overflowWrap: "anywhere" }}>
          <p>Recipient: {review.recipient}</p>
          <p>Payment: 0.001 TAZ (fixed demo price).</p>
          <p>
            Input: 0.001 {review.swap ? "WSOL" : "SOL"}. Fee cap: 0.00001 SOL.
            Rent cap: {review.swap ? "0.006" : "0"} SOL.
          </p>
          {review.swap && (
            <>
              <p>Output mint: {review.swap.outputMint}</p>
              <p>
                Expected: {formatUnits(BigInt(review.swap.expectedOut), 6)}.
                Minimum: {formatUnits(BigInt(review.swap.minimumOut), 6)}.
                Slippage: 1%.
              </p>
            </>
          )}
          <p>
            Review expires: {new Date(review.expires * 1000).toISOString()}.
            Refresh requires another review; this is not transaction approval.
          </p>
          <p>
            No financial order, payment request, signed transaction or
            broadcast. Destination activity would be public; the settlement
            operator can correlate funding and execution.
          </p>
        </div>
      )}
    </section>
  );
}
