"use client";
import { useEffect, useState } from "react";
const notice =
  "Shielded ZEC funding protects the Zcash payment details on-chain. Solana swap transactions and token ownership remain public. ZecOne's relayer can correlate funding and delivery.";
export default function SolanaSwap() {
  const [config, setConfig] = useState<any>(null),
    [recipient, setRecipient] = useState(""),
    [rows, setRows] = useState<any[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [reveal, setReveal] = useState<any>(null),
    [reuse, setReuse] = useState(false);
  async function call(path: string, body?: unknown) {
    const session = await fetch("/api/session").then((r) => r.json());
    const r = await fetch(
      `/api/solana-swap/${path}`,
      body
        ? {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-ZecOne-CSRF": session.csrf,
            },
            body: JSON.stringify(body),
            cache: "no-store",
          }
        : { cache: "no-store" },
    );
    const d = await r.json();
    if (!r.ok) throw Error(d.error || "Swap unavailable");
    return d;
  }
  useEffect(() => {
    let active = true;
    void call("config")
      .then((d) => {
        if (active && d.freshRecipient) {
          setConfig(d);
          setRecipient(d.freshRecipient);
        }
      })
      .catch(() => {});
    const load = () =>
      call("status")
        .then((d) => {
          if (active && Array.isArray(d.orders)) setRows(d.orders);
        })
        .catch(() => {});
    void load();
    const timer = setInterval(load, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  if (!config) return null;
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Swap unavailable");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="panel account-panel"
      style={{ minWidth: 0, overflowWrap: "anywhere" }}
    >
      <h2>Shielded ZEC-funded Solana token swap</h2>
      <p>{notice}</p>
      <p>
        Solana devnet only. One allowlisted Raydium CPMM pool; trusted prefunded
        relayer. Fixed simulated ZEC quote: 0.001 TAZ; this is not a market
        exchange rate. Each broadcast requires a separate exact operator
        approval. Live refunds remain disabled.
      </p>
      <label htmlFor="swap-recipient">Recipient account</label>
      <select
        id="swap-recipient"
        style={{ width: "100%", maxWidth: "100%", minWidth: 0 }}
        value={recipient}
        onChange={(e) => {
          setRecipient(e.target.value);
          setReveal(null);
        }}
        disabled={busy || rows.length > 0}
      >
        <option value={config.freshRecipient}>
          Fresh local recipient — {config.freshRecipient}
        </option>
        {(config.existingRecipients ?? []).map((a: string) => (
          <option key={a} value={a}>
            Existing local recipient — {a}
          </option>
        ))}
      </select>
      <p>
        Fresh keys are created by the local account tool and stored encrypted,
        outside the backend. A fresh address is pseudonymous; the swap and token
        ownership stay public. No funding transfer from your known wallet is
        automatically added.
      </p>
      <p>
        Chosen destination: <code>{recipient}</code>
      </p>
      <label>
        <input
          type="checkbox"
          checked={reuse}
          onChange={(e) => setReuse(e.target.checked)}
        />{" "}
        I acknowledge address reuse if this recipient was previously selected.
      </label>
      <button
        disabled={busy || rows.length > 0}
        onClick={() =>
          void act(async () => {
            const row = await call("quote", { recipient, acceptReuse: reuse });
            setRows([row]);
          })
        }
      >
        Review bounded token swap
      </button>
      {error && <p role="alert">{error}</p>}
      {rows.map((r) => (
        <article key={r.handle} className="panel">
          <h3>{String(r.state).replaceAll("_", " ")}</h3>
          <p>
            Input: 0.001 WSOL (1,000,000 units, 9 decimals). The relayer wraps
            its own devnet SOL within the transaction.
          </p>
          <p>
            Output mint: <code>{r.swap?.outputMint}</code> (6 decimals; no
            asserted token name or market value).
          </p>
          <p>
            Expected output: {r.swap?.expectedOut} base units. Minimum received:{" "}
            {r.swap?.minimumOut} base units.
          </p>
          <p>
            Maximum slippage: 1%. Network fee ceiling: 10,000 lamports. Token
            account rent ceiling: 6,000,000 lamports. Estimated network fee:{" "}
            {r.estimatedFee ?? "available after preparation"} lamports.
          </p>
          <p>
            Shielded quote: 0.001 TAZ; payer transaction fee is reviewed
            separately. Payment request expires:{" "}
            {new Date(r.expires * 1000).toLocaleString()}.
          </p>
          <p>
            Recipient: <code>{r.recipient}</code>
          </p>
          <p>
            Zcash confirmations: {r.confirmations} / {r.requiredConfirmations}.
            Simulation is not completion.
          </p>
          {r.state === "PAYMENT_PENDING" && (
            <button
              disabled={busy}
              onClick={() =>
                void act(async () =>
                  setReveal(
                    await call("payment-request", {
                      handle: r.handle,
                      reveal: true,
                    }),
                  ),
                )
              }
            >
              Reveal shielded payment request
            </button>
          )}
          {r.signature && (
            <p>
              Solana transaction:{" "}
              <a href={r.explorer} target="_blank" rel="noreferrer">
                {r.signature}
              </a>
            </p>
          )}
          {r.state === "COMPLETED" && (
            <p>
              Finalized swap effects and recipient token ownership verified.
              Received: {r.deliveredAmount} token base units.
            </p>
          )}
          {r.state === "RECOVERY_REQUIRED" && (
            <p>
              Preserve this checkout for operator review. No automatic retry or
              refund is authorized.
            </p>
          )}
        </article>
      ))}
      {reveal && (
        <div className="panel">
          <p>
            Private Zcash testnet receiving address — do not publish with your
            Solana destination:
          </p>
          <code>{reveal.address}</code>
          <p>
            Send exactly 0.001 TAZ only after the separate operator review.
            Revealing an address does not authorize a broadcast.
          </p>
          <button onClick={() => setReveal(null)}>Hide payment request</button>
        </div>
      )}
    </section>
  );
}
