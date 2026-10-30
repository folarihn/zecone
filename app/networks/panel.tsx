"use client";
import { useEffect, useState } from "react";
import { formatEther } from "viem";
export default function NetworksPanel() {
  const [rows, setRows] = useState<any[]>([]),
    [selected, setSelected] = useState(84532),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const r = await fetch("/api/networks", { cache: "no-store" });
        if (!r.ok)
          throw Error(
            "Network balances are unavailable. Unlock the wallet and retry.",
          );
        const v = await r.json();
        if (!Array.isArray(v.networks))
          throw Error(
            "Network balances are unavailable. Invalid response from the local service.",
          );
        if (active) {
          setRows(v.networks);
          setError("");
        }
      } catch (e: any) {
        if (active) setError(e.message);
      }
    };
    void refresh();
    const t = setInterval(refresh, 30000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, []);
  const row = rows.find((r) => r.chainId === selected);
  return (
    <section
      className="panel"
      style={{ padding: 20, marginBottom: 20 }}
      aria-label="EVM networks"
    >
      <h2>Testnet accounts</h2>
      <label htmlFor="network-view">Network view</label>{" "}
      <select
        id="network-view"
        value={selected}
        onChange={(e) => setSelected(Number(e.target.value))}
      >
        <option value={84532}>Base Sepolia</option>
        <option value={11155111}>Ethereum Sepolia</option>
        <option value={46630}>Robinhood Chain Testnet</option>
      </select>
      <p className="muted">
        Your existing EVM address is reused and publicly linkable across these
        chains. Shielding Zcash does not make EVM activity private. dApp network
        switches require a separate approval.
      </p>
      {error && <p role="alert">{error}</p>}
      {!row ? (
        <p>Checking live network data…</p>
      ) : (
        <>
          <p>
            {row.name} · chain {row.chainId} · {row.health}
          </p>
          <p className="mono break">{row.address}</p>
          <p>
            {row.wei === null
              ? "Balance unavailable"
              : `${formatEther(BigInt(row.wei))} test ETH`}
          </p>
          <p className="muted">
            Checked {row.checkedAt} {row.block ? `· block ${row.block}` : ""}
          </p>
          <p>
            {row.configured
              ? "Marketplace deployment configured"
              : "ZEC-funded purchases unavailable: marketplace deployment pending funding and validation"}
          </p>
          <h3>Tokens</h3>
          <p>{row.tokenIndexing}</p>
          {row.tokens?.map((t: any) => (
            <p key={t.address}>
              {t.symbol}: {t.balance} base units
            </p>
          ))}
          <h3>NFT holdings</h3>
          <p>{row.nftStatus}</p>
          <p className="muted">{row.nftIndexing}</p>
          {row.nfts?.map((n: any) => (
            <p key={`${n.address}:${n.tokenId}`} className="break">
              Verified ERC-721 #{n.tokenId} · {n.address}
            </p>
          ))}
        </>
      )}
    </section>
  );
}
