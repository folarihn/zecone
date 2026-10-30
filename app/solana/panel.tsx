"use client";
import { useEffect, useState } from "react";
export default function SolanaPanel() {
  const [accounts, setAccounts] = useState<
      { label: string; address: string }[]
    >([]),
    [selected, setSelected] = useState(""),
    [balance, setBalance] = useState<any>(null),
    [preview, setPreview] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [grants, setGrants] = useState<{ origin: string; account: string }[]>([]);
  async function call(path: string, body?: unknown) {
    const s = await fetch("/api/session").then((r) => r.json());
    const r = await fetch(
      `/api/solana/${path}`,
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
    );
    const d = await r.json();
    if (!r.ok) throw Error(d.error || "Solana backend unavailable");
    return d;
  }
  useEffect(() => {
    let active = true;
    call("accounts")
      .then((d) => {
        if (active) {
          setAccounts(d.accounts);
          setSelected(d.accounts[0]?.address ?? "");
        }
      })
      .catch(() => {
        if (active)
          setError("Start the isolated Phase 7A server to use Solana devnet.");
      });
    call("permissions")
      .then((d) => {
        if (active) setGrants(d.permissions);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unavailable");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="panel account-panel"
      style={{ minWidth: 0, overflowWrap: "anywhere" }}
    >
      <h2>Solana devnet</h2>
      <p>
        Separate disposable accounts. Signing locked; broadcasts disabled. Swaps
        and NFT purchases are unsupported.
      </p>
      <label htmlFor="solana-account">Account</label>
      <select
        id="solana-account"
        disabled={busy}
        style={{ width: "100%", minWidth: 0, maxWidth: "100%" }}
        value={selected}
        onChange={(e) => {
          setSelected(e.target.value);
          setBalance(null);
          setPreview(null);
        }}
      >
        {accounts.map((a) => (
          <option value={a.address} key={a.address}>
            {a.label}: {a.address}
          </option>
        ))}
      </select>
      <p style={{ overflowWrap: "anywhere" }}>
        {selected || "No disposable accounts configured"}
      </p>
      <button
        disabled={!selected}
        onClick={() =>
          run(async () => {
            await navigator.clipboard.writeText(selected);
            setError("Receive address copied.");
          })
        }
      >
        Copy Solana receive address
      </button>
      <button
        disabled={!selected || busy}
        onClick={() =>
          run(async () => {
            setBalance(await call("balance", { address: selected }));
          })
        }
      >
        Refresh devnet balance
      </button>
      {error && <p role="status">{error}</p>}
      {balance && (
        <>
          <h3>{balance.sol} SOL (devnet)</h3>
          <p>Observed {balance.observedAt}</p>
          {balance.tokens.length === 0 ? (
            <p>No SPL or Token-2022 accounts found.</p>
          ) : (
            balance.tokens.map((t: any) => (
              <article key={t.address} style={{ overflowWrap: "anywhere" }}>
                <h4>Unknown token · {t.mint}</h4>
                <p>
                  {t.balance ?? "Encrypted balance unavailable"} tokens ·{" "}
                  {t.decimals} decimals · {t.raw} public raw units
                </p>
                <p>
                  Account: {t.address} ·{" "}
                  {t.associated
                    ? "Associated token account"
                    : "Non-associated account"}
                </p>
                <p>
                  {t.program} · {t.status} ·{" "}
                  {t.transferSupported
                    ? "Legacy transfer supported"
                    : "Transfers unsupported"}{" "}
                  {t.extensions.join(", ")}
                </p>
              </article>
            ))
          )}
        </>
      )}
      <h3>Controlled transfer preview</h3>
      <p>
        Simulate 0.001 devnet SOL to the other disposable account. No signature
        or broadcast.
      </p>
      <button
        disabled={accounts.length !== 2 || busy || !selected}
        onClick={() =>
          run(async () => {
            setPreview(null);
            setPreview(
              await call("prepare", {
                id: crypto.randomUUID(),
                owner: selected,
                recipient: accounts.find((a) => a.address !== selected)!
                  .address,
                amount: "1000000",
              }),
            );
          })
        }
      >
        Prepare and simulate
      </button>
      {preview && (
        <div role="status" style={{ overflowWrap: "anywhere" }}>
          <p>{preview.state}</p>
          <p>Recipient: {preview.action.recipient}</p>
          <p>Amount: 0.001 SOL · estimated fee: {preview.fee} lamports</p>
          <p>
            Simulation:{" "}
            {preview.simulation.err
              ? JSON.stringify(preview.simulation.err)
              : "Succeeded"}{" "}
            · units: {preview.simulation.unitsConsumed}
          </p>
          <p>ID: {preview.id}</p>
          <p>
            Last valid block height: {preview.lifetime.lastValidBlockHeight}.
            Re-prepare after expiration. This is not a confirmed transaction.
          </p>
        </div>
      )}
      <h3>Solana app permissions</h3>
      {grants.length === 0 ? (
        <p>No connected Solana apps.</p>
      ) : (
        grants.map((g) => (
          <div key={g.origin}>
            <p>{g.origin}</p>
            <button
              onClick={() =>
                run(async () => {
                  await call("revoke", { origin: g.origin });
                  setGrants(grants.filter((x) => x.origin !== g.origin));
                })
              }
            >
              Revoke {g.origin}
            </button>
          </div>
        ))
      )}
    </section>
  );
}
