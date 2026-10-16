"use client";
import { useEffect, useRef, useState } from "react";
export default function SolanaConnection() {
  const [review, setReview] = useState<any>(null),
    [error, setError] = useState(""),
    [account, setAccount] = useState(""),
    [busy, setBusy] = useState(false);
  const bound = useRef(""),
    channel = useRef(""),
    csrf = useRef(""),
    seen = useRef(false);
  const send = (
    result?: unknown,
    error?: { code: number; message: string },
  ) => {
    if (bound.current)
      window.opener?.postMessage(
        {
          protocol: "zecone:solana:1",
          channel: channel.current,
          kind: "response",
          result,
          error,
        },
        bound.current,
      );
  };
  async function call(path: string, body: unknown) {
    const r = await fetch(`/api/solana/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ZecOne-CSRF": csrf.current,
      },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) throw Object.assign(Error(d.error), { code: d.code });
    return d;
  }
  useEffect(() => {
    channel.current = location.hash.slice(1);
    history.replaceState(null, "", "/solana-connect");
    if (!/^[a-f0-9-]{36}$/.test(channel.current) || !window.opener) {
      setError("Open this page through ZecOne Wallet Standard.");
      return;
    }
    let active = true;
    const receive = async (e: MessageEvent) => {
      const m = e.data;
      if (
        e.source !== window.opener ||
        m?.protocol !== "zecone:solana:1" ||
        m.channel !== channel.current ||
        m.kind !== "request" ||
        seen.current
      )
        return;
      try {
        const u = new URL(e.origin);
        if (u.protocol !== "https:" || u.origin !== e.origin) return;
      } catch {
        return;
      }
      seen.current = true;
      bound.current = e.origin;
      try {
        const s = await fetch("/api/session").then((r) => r.json());
        if (!s.connected || !s.csrf)
          throw Error(
            "Unlock and verify the disposable wallet in the main window first.",
          );
        csrf.current = s.csrf;
        if (m.method === "disconnect") {
          await call("revoke", { origin: e.origin });
          send(null);
          setError("Permission revoked. You can close this window.");
          return;
        }
        const r = await call("request", { origin: e.origin, method: m.method });
        if (active) {
          setReview(r);
          setAccount(r.accounts?.[0] ?? "");
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Connection unavailable";
        setError(message);
        send(undefined, { code: 4100, message });
      }
    };
    window.addEventListener("message", receive);
    // ready contains only a random transport identifier, no account or session data.
    const ready = () =>
      window.opener?.postMessage(
        {
          protocol: "zecone:solana:1",
          channel: channel.current,
          kind: "ready",
        },
        "*",
      );
    ready();
    const timer = setInterval(() => {
      if (!seen.current) ready();
    }, 500);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("message", receive);
    };
  }, []);
  async function decide(approved: boolean) {
    if (!review || busy) return;
    setBusy(true);
    try {
      const r = await call("approve", { id: review.id, account, approved });
      send(r);
      setReview(null);
      setError("Connected. You can close this window.");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Request rejected";
      send(undefined, { code: approved ? 4100 : 4001, message });
      setReview(null);
      setError(message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main
      className="panel account-panel"
      style={{ maxWidth: 640, margin: "2rem auto", padding: 24 }}
    >
      <h1>ZecOne · Solana devnet</h1>
      <p>No broadcast or browser signing is enabled.</p>
      {error && <p role="status">{error}</p>}
      {review && (
        <>
          <h2>
            {review.method === "connect"
              ? "Connect account"
              : "Signing request"}
          </h2>
          <p style={{ overflowWrap: "anywhere" }}>{review.origin}</p>
          <p>{review.warning}</p>
          {review.method === "connect" && (
            <label>
              Disposable account
              <select
                value={account}
                onChange={(e) => setAccount(e.target.value)}
              >
                {review.accounts.map((a: string) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </label>
          )}
          <button disabled={busy} onClick={() => decide(false)}>
            Reject
          </button>
          {review.method === "connect" && (
            <button disabled={busy} onClick={() => decide(true)}>
              Connect devnet account
            </button>
          )}
        </>
      )}
    </main>
  );
}
