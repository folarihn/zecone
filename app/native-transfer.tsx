"use client";
import { useEffect, useState } from "react";
import { formatEther } from "viem";
export default function NativeTransferPanel({
  connected,
}: {
  connected: boolean;
}) {
  const [config, setConfig] = useState<any>(null),
    [recipient, setRecipient] = useState(""),
    [amount, setAmount] = useState("1000000000000"),
    [review, setReview] = useState<any>(null),
    [signature, setSignature] = useState(""),
    [intentId, setIntentId] = useState(""),
    [status, setStatus] = useState<any>(null),
    [payment, setPayment] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function post(operation: string, body: unknown) {
    const session = await fetch("/api/session", { cache: "no-store" }).then(
      (r) => r.json(),
    );
    const r = await fetch(`/api/native-transfer/${operation}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ZecOne-CSRF": session.csrf,
      },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok)
      throw Error(
        "Operation unavailable. Check the local operator state; no automatic retry.",
      );
    return data;
  }
  useEffect(() => {
    if (!connected) {
      setConfig(null);
      setPayment(null);
      setReview(null);
      setSignature("");
      return;
    }
    let active = true;
    void fetch("/api/native-transfer/config", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) return;
        const c = await r.json();
        if (active && Array.isArray(c.recipients)) {
          setConfig(c);
          setRecipient(c.recipients[0] ?? "");
          if (c.resume) {
            setReview(c.resume.review);
            setStatus(c.resume.status);
          }
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [connected]);
  useEffect(() => {
    if (!review || !status?.financialOrderCreated) return;
    let active = true;
    const timer = setInterval(() => {
      void post("status", { id: review.id })
        .then((s) => {
          if (active) setStatus(s);
        })
        .catch(() => {
          if (active)
            setError(
              "Status unavailable. Preserve this checkout; do not send another payment.",
            );
        });
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [review, status?.financialOrderCreated]);
  if (!connected || !config) return null;
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="panel account-panel"
      aria-label="ZEC-funded native transfer"
    >
      <h2>ZEC-funded native testnet transfer</h2>
      <p>
        Chain {config.chainId}. Trusted prefunded relayer; fixed demo payment
        0.001 TAZ plus the payer wallet's Zcash sending fee. No mainnet, ERC-20
        or SPL transfers. This flow does not impersonate ordinary dApp signing.
      </p>
      <label>
        Registered recipient
        <select
          disabled={busy || !!status?.financialOrderCreated}
          value={recipient}
          onChange={(e) => {
            setRecipient(e.target.value);
            setReview(null);
            setSignature("");
          }}
        >
          {config.recipients.map((a: string) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </label>
      <label>
        Amount in wei
        <input
          disabled={busy || !!status?.financialOrderCreated}
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setReview(null);
            setSignature("");
          }}
          autoComplete="off"
        />
      </label>
      <button
        disabled={busy || !!status?.financialOrderCreated}
        onClick={() =>
          void run(async () => {
            setReview(await post("review", { recipient, amount }));
            setStatus(null);
            setPayment(null);
          })
        }
      >
        Review native delivery
      </button>
      <label>
        Optional consented dApp request ID
        <input
          disabled={busy || !!status?.financialOrderCreated}
          value={intentId}
          onChange={(e) => setIntentId(e.target.value)}
          autoComplete="off"
        />
      </label>
      <button
        disabled={busy || !intentId || !!status?.financialOrderCreated}
        onClick={() =>
          void run(async () => {
            setReview(
              await post("from-intent", { id: intentId, approved: true }),
            );
            setStatus(null);
            setPayment(null);
            setSignature("");
          })
        }
      >
        Open a separate ZEC-funded checkout
      </button>
      {review && (
        <div style={{ overflowWrap: "anywhere" }}>
          <p>
            Recipient: {review.recipient}. Amount:{" "}
            {formatEther(BigInt(review.amount))} test ETH. Fee cap:{" "}
            {review.feeCapWei} wei.
          </p>
          <p>
            Review expires: {new Date(review.expires * 1000).toISOString()}.
            Authorizer: {config.authorizer}.
          </p>
          <pre style={{ whiteSpace: "pre-wrap" }}>{review.message}</pre>
          {review.estimatedFeeWei && (
            <p>
              Destination fee estimate at review: {review.estimatedFeeWei} wei.
              It must be checked again before execution.
            </p>
          )}
          {review.source && (
            <p>
              Imported from {review.source.origin}. The standard dApp
              transaction was not executed. This is a separately authorized
              relayer delivery.
            </p>
          )}
          {!status?.financialOrderCreated &&
            config.financialCreationEnabled && (
              <>
                <label>
                  Public signature of this exact message from the authorizer
                  wallet
                  <textarea
                    autoComplete="off"
                    value={signature}
                    onChange={(e) => setSignature(e.target.value)}
                  />
                </label>
                <button
                  disabled={busy || !/^0x[0-9a-fA-F]{130}$/.test(signature)}
                  onClick={() =>
                    void run(async () =>
                      setStatus(
                        await post("authorize", {
                          id: review.id,
                          signature,
                          approved: true,
                        }),
                      ),
                    )
                  }
                >
                  Authorize this payment request
                </button>
              </>
            )}
        </div>
      )}
      {status && (
        <p role="status">
          {status.state}. Received: {status.receivedZatoshis ?? "0"} zatoshis.
          Confirmed: {status.confirmedZatoshis ?? "0"}. Required confirmations:{" "}
          {status.requiredConfirmations ?? 10}.
        </p>
      )}
      {status?.transactionHash && (
        <p style={{ overflowWrap: "anywhere" }}>
          Destination transaction: <code>{status.transactionHash}</code>
        </p>
      )}
      {status?.state === "PAYMENT_PENDING" && (
        <button
          disabled={busy}
          onClick={() =>
            void run(async () =>
              setPayment(
                await post("payment-request", { id: review.id, reveal: true }),
              ),
            )
          }
        >
          Reveal shielded testnet payment request
        </button>
      )}
      {payment && status?.state === "PAYMENT_PENDING" && (
        <div style={{ overflowWrap: "anywhere" }}>
          <p>{payment.address}</p>
          <p>
            Pay {payment.zatoshis} zatoshis once on Zcash testnet. Expires:{" "}
            {new Date(payment.expiry * 1000).toISOString()}. Do not send another
            payment after detection or expiry.
          </p>
        </div>
      )}
      <p>
        Payment verification uses the local native watch-only observer.
        Destination execution requires separate operator approval. Destination
        activity is public; the operator can correlate payment and delivery.
        Live refunds are disabled.
      </p>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
