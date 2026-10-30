"use client";
import { useEffect, useState } from "react";
import { formatUnits } from "viem";
export default function SettlementReviewPanel() {
  const [recipients, setRecipients] = useState<string[]>([]),
    [recipient, setRecipient] = useState(""),
    [action, setAction] = useState("transfer"),
    [review, setReview] = useState<any>(null),
    [created, setCreated] = useState<any>(null),
    [enabled, setEnabled] = useState(false),
    [supportsSpl, setSupportsSpl] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [signature, setSignature] = useState("");
  const [signatureRequired, setSignatureRequired] = useState(false);
  const [settlement, setSettlement] = useState<any>(null);
  useEffect(() => {
    let active = true;
    void fetch("/api/settlement-review/config", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) return;
        const data = await r.json();
        if (active && Array.isArray(data.recipients)) {
          setRecipients(data.recipients);
          setRecipient(data.recipients[0] ?? "");
          setEnabled(data.financialCreationEnabled === true);
          setSupportsSpl(data.spl === true);
          setSignatureRequired(data.userSignatureRequired === true);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!created) return;
    let active = true;
    const poll = async () => {
      try {
        const r = await fetch("/api/settlement-review/status", {
          cache: "no-store",
        });
        if (!r.ok) {
          if (active) {
            setCreated(null);
            setSettlement(null);
          }
          return;
        }
        const s = await r.json();
        const row = s.reviews?.find((v: any) => v.orderId === created.orderId);
        if (active && row?.settlement) setSettlement(row.settlement);
      } catch {}
    };
    void poll();
    const t = setInterval(() => void poll(), 5000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [created]);
  if (!recipients.length) return null;
  return (
    <section
      className="panel account-panel"
      aria-label="Settlement economic review"
    >
      <h2>ZEC-funded transaction review</h2>
      <p>
        Solana devnet only. Fixed testnet demo pricing; trusted prefunded
        relayer. Local pairing is not wallet ownership verification.{" "}
        {enabled
          ? "Financial creation is enabled; payment and execution are not."
          : "Review only; financial creation is disabled."}
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
          {supportsSpl && (
            <option value="spl-transfer">
              Deliver 1 unit of the configured SPL token
            </option>
          )}
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
          setCreated(null);
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
          {enabled && (
            <>
              {signatureRequired && (
                <label>
                  Authorize these terms with your configured user EOA (public
                  signature only)
                  <pre style={{ whiteSpace: "pre-wrap" }}>{review.message}</pre>
                  <input
                    aria-label="SOL checkout public signature"
                    value={signature}
                    onChange={(e) => setSignature(e.target.value)}
                    autoComplete="off"
                  />
                </label>
              )}
              <button
                disabled={
                  busy ||
                  (signatureRequired && !/^0x[a-fA-F0-9]{130}$/.test(signature))
                }
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    const session = await fetch("/api/session", {
                      cache: "no-store",
                    }).then((r) => r.json());
                    const response = await fetch(
                      "/api/settlement-review/authorize",
                      {
                        method: "POST",
                        headers: {
                          "Content-Type": "application/json",
                          "X-ZecOne-CSRF": session.csrf,
                        },
                        body: JSON.stringify({
                          id: review.id,
                          digest: review.digest,
                          approved: true,
                          ...(signatureRequired ? { signature } : {}),
                        }),
                      },
                    );
                    const data = await response.json();
                    if (!response.ok)
                      throw Error(data.error || "Authorization unavailable.");
                    if (
                      data.executionAuthorized !== false ||
                      data.financialOrderCreated !== true
                    )
                      throw Error("Unexpected financial state.");
                    setCreated(data);
                  } catch {
                    setError(
                      "Financial order not created. No payment was sent or authorized.",
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Create financial order and show payment request
              </button>
            </>
          )}
        </div>
      )}
      {created && (
        <div role="status" style={{ overflowWrap: "anywhere" }}>
          <h3>Payment request</h3>
          <p>Order: {created.orderId}</p>
          <p>Pay exactly: {created.paymentRequest.zatoshis} zatoshis.</p>
          {(!settlement || settlement.state === "PAYMENT_PENDING") && (
            <p>To shielded address: {created.paymentRequest.address}</p>
          )}
          {settlement && (
            <>
              <p>
                State: {settlement.state}. Confirmations:{" "}
                {settlement.confirmations}/10.
              </p>
              {settlement.signature && (
                <p>Destination signature: {settlement.signature}</p>
              )}
            </>
          )}
          <p>
            Expires:{" "}
            {new Date(created.paymentRequest.expiry * 1000).toISOString()}.
          </p>
          <p>Network: {created.paymentRequest.network}.</p>
          <p>
            This screen did not send, sign or broadcast a payment. Paying from
            another wallet is a separate manual action outside this app.
          </p>
        </div>
      )}
    </section>
  );
}
