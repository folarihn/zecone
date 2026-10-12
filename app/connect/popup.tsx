"use client";
import { useEffect, useRef, useState } from "react";
import PurchasePanel from "../purchases/panel";
type Review = {
  done?: boolean;
  id?: string;
  origin?: string;
  method?: string;
  state?: string;
  review?: Record<string, unknown>;
  reviewHash?: string;
  expires?: number;
  result?: unknown;
  error?: { code: number; message: string } | string;
};
export default function Connection() {
  const [current, setCurrent] = useState<Review | null>(null),
    [error, setError] = useState(""),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [site, setSite] = useState(""),
    [purchaseId, setPurchaseId] = useState("");
  const csrf = useRef(""),
    bound = useRef(""),
    channel = useRef(""),
    pending = useRef(new Map<string, Review>());
  const send = (value: Record<string, unknown>) => {
    if (bound.current)
      window.opener?.postMessage(
        { protocol: "zecone:2", channel: channel.current, ...value },
        bound.current,
      );
  };
  async function api(path: string, body?: unknown) {
    const res = await fetch(`/api/${path}`, {
      method: body ? "POST" : "GET",
      headers: body
        ? { "Content-Type": "application/json", "X-ZecOne-CSRF": csrf.current }
        : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok)
      throw Object.assign(new Error(data.error || "Wallet unavailable"), {
        code: data.code || 4100,
        status: res.status,
      });
    return data;
  }
  function receive(id: string, data: Review) {
    if (data.done) {
      pending.current.delete(id);
      if (
        data.result &&
        typeof data.result === "object" &&
        "purchaseId" in data.result
      )
        setPurchaseId(String(data.result.purchaseId));
      send({
        kind: "response",
        id,
        ...(data.error ? { error: data.error } : { result: data.result }),
      });
      if (data.result && Array.isArray(data.result))
        send({ kind: "event", event: "accountsChanged", value: data.result });
    } else pending.current.set(id, data);
    setCurrent([...pending.current.values()][0] || null);
  }
  useEffect(() => {
    channel.current = location.hash.slice(1);
    history.replaceState(null, "", "/connect");
    if (!/^[0-9a-f-]{36}$/.test(channel.current) || !window.opener) {
      setError("Open this approval window from a compatible dApp.");
      return;
    }
    let active = true,
      previous: string[] | null = null;
    const listener = async (e: MessageEvent) => {
      const m = e.data;
      if (
        e.source !== window.opener ||
        e.origin === "null" ||
        !m ||
        m.protocol !== "zecone:2" ||
        m.channel !== channel.current
      )
        return;
      try {
        const u = new URL(e.origin);
        if (
          u.origin !== e.origin ||
          !(
            u.protocol === "https:" ||
            (u.protocol === "http:" &&
              ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname))
          )
        )
          return;
      } catch {
        return;
      }
      if (bound.current && bound.current !== e.origin) return;
      bound.current = e.origin;
      setSite(e.origin);
      if (m.kind === "hello") {
        if (csrf.current) send({ kind: "ready" });
        return;
      }
      if (
        m.kind !== "request" ||
        typeof m.id !== "string" ||
        typeof m.method !== "string" ||
        !csrf.current
      )
        return;
      try {
        const d = await api("dapps/request", {
          id: m.id,
          channel: channel.current,
          origin: e.origin,
          method: m.method,
          params: m.params,
        });
        if (active) receive(m.id, d);
      } catch (err: any) {
        send({
          kind: "response",
          id: m.id,
          error: { code: err.code || -32603, message: err.message },
        });
      }
    };
    window.addEventListener("message", listener);
    api("session")
      .then((s) => {
        if (!s.connected)
          throw Error(
            "Open the local wallet launcher and verify ownership in the dashboard, then reopen this popup.",
          );
        csrf.current = s.csrf;
        setReady(true);
        if (bound.current) send({ kind: "ready" });
      })
      .catch((e) => setError(e.message));
    const timer = setInterval(async () => {
      if (!csrf.current) return;
      try {
        for (const id of [...pending.current.keys()])
          receive(id, await api("dapps/status", { id }));
        const list = await api("dapps/list"),
          accounts = list.connections.some(
            (c: any) => c.origin === bound.current,
          )
            ? ["connected"]
            : [];
        if (previous?.length && !accounts.length)
          send({ kind: "event", event: "accountsChanged", value: [] });
        previous = accounts;
      } catch (e: any) {
        setError(e.message);
        if (e.status === 401 || e.status === 403) {
          send({
            kind: "event",
            event: "disconnect",
            value: { code: 4900, message: "Wallet session ended" },
          });
          csrf.current = "";
        }
      }
      if (window.opener?.closed) window.close();
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("message", listener);
    };
  }, []);
  async function decide(approved: boolean) {
    if (!current?.id) return;
    setBusy(true);
    try {
      receive(
        current.id,
        await api("dapps/approve", {
          id: current.id,
          reviewHash: current.reviewHash,
          approved,
        }),
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const r = (current?.review ?? {}) as Record<string, unknown>,
    typed = (r.typedData ?? {}) as Record<string, any>;
  return (
    <main className="connect-shell">
      <div className="eyebrow">ZECONE · LOCAL APPROVAL</div>
      <h1>
        {current?.method === "zecone_payWithZec"
          ? "Review marketplace quote"
          : current?.method === "eth_requestAccounts"
            ? "Connect application"
            : current?.method === "eth_sendTransaction"
              ? "Review transaction"
              : current
                ? "Review signature"
                : "Application connection"}
      </h1>
      <p className="muted">Base Sepolia · testnet only</p>
      <div className="origin-box">
        <small>REQUESTING WEBSITE — CHECK THE ENTIRE ORIGIN</small>
        <strong>{current?.origin || site || "Waiting for application"}</strong>
      </div>
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {current ? (
        <section
          role="dialog"
          aria-label="Application approval"
          aria-modal="true"
        >
          <p>
            {current.method === "zecone_payWithZec"
              ? "Approve one exact NFT purchase quote. A separate fee review and approval is required before spending shielded test ZEC."
              : current.method === "eth_requestAccounts"
                ? "Share your public EVM address with this exact website? Your Zcash balance and history remain private to the local wallet."
                : current.method === "eth_sendTransaction"
                  ? "Review the exact public Base Sepolia transaction. A successful simulation is not a safety guarantee."
                  : "The website is asking your local user wallet to sign. Public EVM activity can be linked to this address."}
          </p>
          <p>
            <strong>{current.method}</strong> · {current.state}
          </p>
          <dl className="review-list">
            <div>
              <dt>Network</dt>
              <dd>Base Sepolia · chain 84532</dd>
            </div>
            <div>
              <dt>User account</dt>
              <dd className="mono break">
                {String(r.account ?? "Not shared")}
              </dd>
            </div>
            {current.method === "zecone_payWithZec" ? (
              <>
                {[
                  ["Collection", r.nft],
                  ["Token ID", r.tokenId],
                  ["Seller", r.seller],
                  ["NFT price (wei)", r.price],
                  ["Fixed gas reserve (wei)", r.gasBudget],
                  ["Shielded payment (zatoshis)", r.zatoshis],
                  ["Slippage", "0%"],
                  [
                    "Expires",
                    new Date(Number(r.expiry) * 1000).toLocaleString(),
                  ],
                  ["Trust and pricing", r.trust],
                ].map(([label, value]) => (
                  <div key={String(label)}>
                    <dt>{String(label)}</dt>
                    <dd className="break">{String(value)}</dd>
                  </div>
                ))}
              </>
            ) : current.method === "eth_sendTransaction" ? (
              <>
                <div>
                  <dt>Destination</dt>
                  <dd className="mono break">{String(r.to)}</dd>
                </div>
                <div>
                  <dt>Native value</dt>
                  <dd>{String(r.value)} wei</dd>
                </div>
                <div>
                  <dt>Contract method</dt>
                  <dd>{String(r.method ?? "Unknown contract interaction")}</dd>
                </div>
                <div>
                  <dt>Estimated gas / limit</dt>
                  <dd>
                    {String(r.estimatedGas ?? "—")} / {String(r.gas ?? "—")}
                  </dd>
                </div>
                <div>
                  <dt>Maximum execution fee</dt>
                  <dd>
                    {String(r.executionFeeCapWei ?? "—")} wei · Base L1 data
                    fees are additional
                  </dd>
                </div>
                <div>
                  <dt>Simulation</dt>
                  <dd>{String(r.simulation ?? "Not available")}</dd>
                </div>
                <div>
                  <dt>Risk</dt>
                  <dd>{String(r.warning ?? "Unknown contract interaction")}</dd>
                </div>
              </>
            ) : current.method === "personal_sign" ? (
              <div>
                <dt>Message</dt>
                <dd className="break">{String(r.text ?? r.raw ?? "")}</dd>
              </div>
            ) : current.method === "eth_signTypedData_v4" ? (
              <>
                <div>
                  <dt>Typed-data domain</dt>
                  <dd>
                    {String(typed.domain?.name ?? "Unknown")} · chain{" "}
                    {String(typed.domain?.chainId ?? "Unknown")}
                  </dd>
                </div>
                <div>
                  <dt>Primary type</dt>
                  <dd>{String(typed.primaryType ?? "Unknown")}</dd>
                </div>
                <div>
                  <dt>Typed data to sign</dt>
                  <dd>
                    <pre className="review-data">
                      {JSON.stringify(typed.message ?? {}, null, 2)}
                    </pre>
                  </dd>
                </div>
                <div>
                  <dt>Signature risk</dt>
                  <dd>{String(r.warning ?? "")}</dd>
                </div>
              </>
            ) : null}
          </dl>
          <details>
            <summary>Inspect exact RPC payload</summary>
            <pre className="review-data">
              {JSON.stringify(current.review, null, 2)}
            </pre>
          </details>
          {current.state === "pending" ? (
            <div className="approval-actions">
              <button onClick={() => decide(false)} disabled={busy}>
                Reject request
              </button>
              <button
                className="primary"
                onClick={() => decide(true)}
                disabled={busy}
              >
                {busy ? "Processing…" : "Approve request"}
              </button>
            </div>
          ) : (
            <p className="notice">
              {typeof current.error === "string"
                ? current.error
                : "Waiting for reconciliation. Do not create a duplicate request."}
            </p>
          )}
        </section>
      ) : purchaseId ? (
        <PurchasePanel id={purchaseId} />
      ) : (
        <p>
          {ready
            ? "Ready. Return to the application to request an action."
            : "Unlock your local wallet to continue."}
        </p>
      )}
      <p className="muted">
        Never approve a request you did not initiate. A successful simulation is
        not a safety guarantee. Closing this window disconnects the transport;
        revoke saved permissions in Apps.
      </p>
    </main>
  );
}
