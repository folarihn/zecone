"use client";
import { useEffect, useState } from "react";
export default function SolanaDelivery() {
  const [rows, setRows] = useState<any[]>([]),
    [recipient, setRecipient] = useState(""),
    [amount, setAmount] = useState("1000000"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [available, setAvailable] = useState(false);
  async function call(path: string, body?: unknown) {
    const s = await fetch("/api/session").then((r) => r.json()),
      r = await fetch(
        `/api/solana-settlement/${path}`,
        body
          ? {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-ZecOne-CSRF": s.csrf,
              },
              body: JSON.stringify(body),
            }
          : {},
      ),
      d = await r.json();
    if (!r.ok) throw Error(d.error || "Settlement unavailable");
    return d;
  }
  useEffect(() => {
    let active = true;
    const load = () =>
      call("status")
        .then((d) => {
          if (active && Array.isArray(d.orders)) {
            setAvailable(true);
            setRows(d.orders);
          }
        })
        .catch(() => {});
    void load();
    const timer = setInterval(load, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  return (
    <section
      className="panel account-panel"
      style={{ minWidth: 0, overflowWrap: "anywhere" }}
    >
      <h2>Shielded ZEC-funded SOL delivery</h2>
      <p>
        Zcash testnet → trusted prefunded Solana devnet relayer. Fixed demo
        pricing: 0.001 TAZ per delivery. This is not an exchange rate or a
        trustless bridge. Each broadcast requires exact operator approval; live
        refunds remain disabled.
      </p>
      {!available ? (
        <p>
          Start the isolated Phase 7B backend and verify the disposable local
          account to review this checkout.
        </p>
      ) : (
        <>
          <label htmlFor="delivery-recipient">Recipient Solana address</label>
          <input
            id="delivery-recipient"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            autoComplete="off"
            style={{ width: "100%", minWidth: 0 }}
          />
          <label htmlFor="delivery-amount">SOL delivery amount</label>
          <select
            id="delivery-amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          >
            <option value="1000000">0.001 devnet SOL</option>
            <option value="2000000">0.002 devnet SOL</option>
            <option value="5000000">0.005 devnet SOL</option>
          </select>
          <button
            disabled={busy || !recipient}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                setRows([await call("quote", { recipient, lamports: amount })]);
              } catch (e) {
                setError(e instanceof Error ? e.message : "Quote failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            Review fixed testnet quote
          </button>
          {rows.map((r) => (
            <article key={r.id}>
              <h3>{r.state.replaceAll("_", " ")}</h3>
              <p>Order: {r.id}</p>
              <p>Recipient: {r.recipient}</p>
              <p>Delivery: {Number(r.lamports) / 1e9} devnet SOL</p>
              <p>
                Shielded payment: {r.zatoshis} zatoshis (0.001 TAZ). Native
                payer fee cap: 10,000 zatoshis; Solana fee cap: {r.feeCap}{" "}
                lamports.
              </p>
              <p>
                Quote expires: {new Date(r.expires * 1000).toLocaleString()}
              </p>
              <p>
                Confirmed payment: {r.confirmedZatoshis} / {r.zatoshis}{" "}
                zatoshis; minimum 10 confirmations.
              </p>
              <p>Zcash confirmations: {r.confirmations ?? 0} / 10</p>
              {r.paymentTxs?.map((tx: string) => (
                <p key={tx}>Zcash payment transaction: {tx}</p>
              ))}
              <p>
                Reveal the fresh payment address in the unified checkout. The
                operator prepares the exact payment and obtains approval of its
                actual fee, expiry and transaction ID before sending. This page
                cannot send funds.
              </p>
              {r.prepared && (
                <p>
                  Prepared digest: {r.prepared.digest}; fee: {r.prepared.fee}{" "}
                  lamports. Simulation is not completion.
                </p>
              )}
              {r.signature && (
                <p>
                  <a href={r.explorer} target="_blank" rel="noreferrer">
                    {r.signature}
                  </a>
                </p>
              )}
              {r.state === "RECOVERY_REQUIRED" && (
                <p role="alert">
                  Recovery required. Do not pay or execute again. Reconcile the
                  original transaction; refunds are disabled.
                </p>
              )}
            </article>
          ))}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
