"use client";
import { useEffect, useState } from "react";
import { formatUnits } from "viem";
export default function OpenSeaPanel() {
  const [collection, setCollection] = useState("pudgypenguins"),
    [rows, setRows] = useState<any[]>([]),
    [preview, setPreview] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  async function run(path: string, body: unknown) {
    setBusy(true);
    setError("");
    setPreview(null);
    if (path === "listings") setRows([]);
    try {
      const session = await (
        await fetch("/api/session", { cache: "no-store" })
      ).json();
      const r = await fetch(`/api/opensea/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ZecOne-CSRF": session.csrf,
        },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      const j = await r.json();
      if (!r.ok) throw Error(j.error || "OpenSea inspection unavailable");
      if (path === "listings") setRows(j.listings);
      else setPreview(j);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const eth = (v: string) => formatUnits(BigInt(v), 18),
    expired = preview && now >= preview.expiry * 1000;
  return (
    <section className="swap-panel" aria-label="OpenSea inspection">
      <h2>OpenSea · read-only discovery</h2>
      <p className="notice">
        Ethereum mainnet listings for inspection only. No purchase, signature,
        ZEC payment or liquidity reservation can be created here.
      </p>
      <p className="muted">
        Queries contact OpenSea and Ethereum RPC. NFT ownership and public
        wallet addresses are visible to those services. ZecOne is not affiliated
        with OpenSea.
      </p>
      <label>
        OpenSea collection slug{" "}
        <input
          value={collection}
          maxLength={100}
          onChange={(e) => {
            setCollection(e.target.value);
            setRows([]);
            setPreview(null);
          }}
          disabled={busy}
        />
      </label>
      <button
        className="primary"
        disabled={busy}
        onClick={() => void run("listings", { collection })}
      >
        {busy ? "Checking official services…" : "Discover official listings"}
      </button>
      {error && <p role="alert">{error}</p>}
      <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
        {rows.map((r) => (
          <article
            className="card"
            key={r.orderHash}
            style={{ padding: 16, overflowWrap: "anywhere" }}
          >
            <h3>Token #{r.tokenId}</h3>
            <p>
              {r.currency === "ETH" ? eth(r.priceWei) : r.priceWei} {r.currency}{" "}
              · {r.status}
            </p>
            <p className="muted">Unvalidated API listing · {r.orderHash}</p>
            <button
              disabled={busy}
              onClick={() =>
                void run("preview", { collection, orderHash: r.orderHash })
              }
            >
              Validate & preview #{r.tokenId}
            </button>
          </article>
        ))}
      </div>
      {preview && (
        <article
          className="card"
          aria-label="Non-executing checkout preview"
          style={{ padding: 20, marginTop: 20, overflowWrap: "anywhere" }}
        >
          <h3>{preview.name}</h3>
          <p>
            {preview.collection} · {preview.source}
          </p>
          {preview.image ? (
            <img
              src={preview.image}
              alt={preview.name}
              width={200}
              height={200}
              style={{ objectFit: "contain", maxWidth: "100%" }}
            />
          ) : (
            <p>Image unavailable from the permitted image service.</p>
          )}
          <p role="status">
            {expired
              ? "Preview expired — validate again. This is never payable."
              : "Validated snapshot — non-executing preview"}
          </p>
          <dl>
            {[
              ["Network", preview.network],
              ["Seller", preview.seller],
              ["Receiving wallet", preview.recipient],
              ["Order", preview.orderHash],
              ["NFT", `${preview.nft} · #${preview.tokenId}`],
              ["Seller price", `${eth(preview.sellerWei)} ETH`],
              ["Consideration fees", `${eth(preview.feesWei)} ETH`],
              ["Total listing price", `${eth(preview.priceWei)} ETH`],
              ["Estimated gas reserve", `${eth(preview.gasBudgetWei)} ETH`],
              [
                "Required hypothetical liquidity",
                `${eth(preview.requiredLiquidityWei)} ETH`,
              ],
              [
                "Illustrative shielded amount",
                `${formatUnits(BigInt(preview.simulatedZatoshis), 8)} TAZ; native Zcash fee not quoted`,
              ],
              [
                "Quote expiry",
                new Date(preview.expiry * 1000).toLocaleString(),
              ],
              ["Verified block", preview.block],
              ["Seller authorization", preview.sellerAuthorization],
              ["Binding", preview.bindingHash],
            ].map(([k, v]) => (
              <div key={k} style={{ marginBottom: 10 }}>
                <dt className="muted">{k}</dt>
                <dd style={{ margin: 0 }}>{v}</dd>
              </div>
            ))}
          </dl>
          <h4>Exact consideration recipients</h4>
          {preview.consideration.map((r: any) => (
            <p key={r.address}>
              {r.address}: {eth(r.amount)} ETH
              {r.contract ? " (contract recipient)" : ""}
            </p>
          ))}
          <p>{preview.simulatedRate}</p>
          <p>{preview.simulation}</p>
          <p className="notice">{preview.executionBlocker}</p>
          <p>{preview.trust}</p>
          <p>{preview.privacy}</p>
          <a href={preview.openSeaUrl} target="_blank" rel="noreferrer">
            View listing on OpenSea
          </a>
        </article>
      )}
    </section>
  );
}
