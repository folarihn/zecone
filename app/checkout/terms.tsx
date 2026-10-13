"use client";
import { formatUnits } from "viem";
import { useState } from "react";
type Terms = {
  networkName?: string;
  chainId?: number;
  recipient: string;
  price?: string;
  gasBudget?: string;
  estimatedFee?: string;
  zatoshis: string;
  expiry: number;
  refundDestination?: string;
  fee?: { feeZatoshis: string; totalZatoshis: string; expires?: number };
};
const units = (s: string, decimals = 18) => formatUnits(BigInt(s), decimals);
/** Shared exact-payment terms for marketplace, Seaport and token review dialogs.
 * Values come from the existing authenticated intent/fee projection, not UI pricing.
 */
export default function CheckoutTerms({ terms: t }: { terms: Terms }) {
  const [references, setReferences] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const network =
    t.networkName ??
    {
      84532: "Base Sepolia",
      11155111: "Ethereum Sepolia",
      46630: "Robinhood Testnet",
    }[t.chainId ?? 84532];
  return (
    <section aria-label="Unified checkout terms">
      <dl className="review-list">
        <div>
          <dt>Destination network</dt>
          <dd>{network}</dd>
        </div>
        <div>
          <dt>Receiving wallet</dt>
          <dd className="mono break">{t.recipient}</dd>
        </div>
        {t.price && (
          <div>
            <dt>Purchase price</dt>
            <dd>{units(t.price)} test ETH</dd>
          </div>
        )}
        <div>
          <dt>Shielded payment amount</dt>
          <dd>{units(t.zatoshis, 8)} TAZ</dd>
        </div>
        <div>
          <dt>Provider pricing</dt>
          <dd>
            Existing simulated testnet rate; no separate provider fee. Fixed gas
            reserve is included and charged even if unused.
          </dd>
        </div>
        {t.gasBudget && (
          <div>
            <dt>Destination gas reserve</dt>
            <dd>{units(t.gasBudget)} test ETH</dd>
          </div>
        )}
        {t.estimatedFee && (
          <div>
            <dt>Destination fee estimate</dt>
            <dd>{units(t.estimatedFee)} test ETH</dd>
          </div>
        )}
        {t.fee && (
          <>
            <div>
              <dt>Maximum Zcash fee</dt>
              <dd>{units(t.fee.feeZatoshis, 8)} TAZ</dd>
            </div>
            <div>
              <dt>Total debit</dt>
              <dd>{units(t.fee.totalZatoshis, 8)} TAZ</dd>
            </div>
          </>
        )}
        <div>
          <dt>Execution deadline</dt>
          <dd>{new Date(t.expiry * 1000).toLocaleString()}</dd>
        </div>
        {t.fee?.expires && (
          <div>
            <dt>Payment approval expires</dt>
            <dd>{new Date(t.fee.expires).toLocaleString()}</dd>
          </div>
        )}
        {t.refundDestination && (
          <div>
            <dt>Refund destination</dt>
            <dd className="break">{t.refundDestination}</dd>
          </div>
        )}
      </dl>
      <p className="notice">
        Ten Zcash confirmations are required. The provider can correlate your
        shielded payment with the public asset delivery. Testnet liquidity has
        no real-asset redemption value.
      </p>
      <p>
        Failed purchases require manual recovery. Independent refund signing is
        under development; no automatic or confirmed refund is promised.
        Existing wallet credentials have not been migrated to the new test
        keystore.
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          setReferences(null);
          try {
            const response = await fetch("/api/reference-prices", {
                cache: "no-store",
              }),
              body = await response.json();
            if (!response.ok)
              throw Error(body.error || "Market reference unavailable");
            setReferences(body);
          } catch (e) {
            setError(
              e instanceof Error ? e.message : "Market reference unavailable",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Checking reference feeds…" : "View current market reference"}
      </button>
      <p className="muted">
        This optional lookup contacts Coinbase and Kraken through the local
        service. It sends no wallet address. Mainnet market prices are
        informational and do not change the approved testnet payment.
      </p>
      {error && <p role="status">{error}</p>}
      {references && (
        <p role="status">
          Reference snapshot: ZEC ${units(references.zec.usdE8, 8)} · ETH $
          {units(references.eth.usdE8, 8)}. Valid until{" "}
          {new Date(
            Math.min(references.zec.expires, references.eth.expires) * 1000,
          ).toLocaleTimeString()}
          . These prices cannot be redeemed for testnet assets.
        </p>
      )}
    </section>
  );
}
