"use client";
import { useState } from "react";
export default function AccountPanel({ address }: { address: string }) {
  const [network, setNetwork] = useState("84532"),
    [copied, setCopied] = useState(false),
    [error, setError] = useState("");
  return (
    <section className="panel account-panel" aria-label="Send and receive">
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
        A general receive/send interface for the quarantined historical Zcash
        wallet is disabled. Existing recovery markers and inputs remain
        untouched.
      </p>
    </section>
  );
}
