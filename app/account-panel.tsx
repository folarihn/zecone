"use client";
import { useState } from "react";
import type { ZcashNetworkView } from "../services/wallet/zcash-networks";
export default function AccountPanel({
  address,
  zcash,
}: {
  address: string;
  zcash?: ZcashNetworkView | null;
}) {
  const [network, setNetwork] = useState("84532"),
    [copied, setCopied] = useState(false),
    [error, setError] = useState("");
  return (
    <section className="panel account-panel" aria-label="Send and receive">
      {zcash?.network === "zcash-mainnet" && (
        <>
          <p className="eyebrow">ZCASH MAINNET · READ ONLY</p>
          <h2>Receive shielded ZEC</h2>
          <p className="mono break">{zcash.receivingAddress}</p>
          <button
            className="secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(zcash.receivingAddress!);
                setCopied(true);
                setError("");
              } catch {
                setError(
                  "Clipboard unavailable. Select and copy the address manually.",
                );
              }
            }}
          >
            {copied ? "Address copied" : "Copy Zcash mainnet address"}
          </button>
          <p className="muted">
            ZIP-316 verified against the existing wallet identity. Receivers:{" "}
            {[
              zcash.receivers?.orchard && "Orchard",
              zcash.receivers?.sapling && "Sapling",
              zcash.receivers?.transparent && "transparent",
            ]
              .filter(Boolean)
              .join(", ")}
            .
          </p>
          <button disabled>Send mainnet ZEC unavailable</button>
          <p className="notice" role="status">
            {zcash.sendUnavailableReason}
          </p>
          <hr />
        </>
      )}
      <p className="eyebrow">YOUR ACCOUNT</p>
      <h2>Receive on an EVM testnet</h2>
      <label htmlFor="receive-network">Receive network</label>
      <select
        id="receive-network"
        value={network}
        onChange={(e) => setNetwork(e.target.value)}
      >
        <option value="84532">Base Sepolia</option>
        <option value="11155111">Ethereum Sepolia</option>
        <option value="46630">Robinhood Chain Testnet</option>
      </select>
      <p className="mono break">{address}</p>
      <button
        className="secondary"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(address);
            setCopied(true);
            setError("");
          } catch {
            setError(
              "Clipboard unavailable. Select and copy the address manually.",
            );
          }
        }}
      >
        {copied ? "Address copied" : "Copy receiving address"}
      </button>
      {error && <p role="alert">{error}</p>}
      <p className="muted">
        One configured local account. The same address on these networks is
        publicly linkable. Receive only test assets.
      </p>
      <hr />
      <h3>Send with explicit approval</h3>
      <p>
        Standard EVM sends are reviewed in the connected dApp approval window.
        ZEC-funded payments are available only through the supported checkout
        adapters.
      </p>
      <button disabled>General-purpose Zcash send unavailable</button>
      <p className="muted">
        Browser Zcash signing and broadcasting are disabled. Existing recovery
        markers, approval gates and wallet inputs remain untouched.
      </p>
    </section>
  );
}
