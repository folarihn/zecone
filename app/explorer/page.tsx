"use client";
import { useState } from "react";
import { ArrowUpRight, Search } from "lucide-react";
import { EVIDENCE, baseTx, zcashTx } from "../evidence";
import CheckoutPanel from "../components/checkout-panel";
import { BaseMark, Container, ZcashMark } from "../ui";

// Accepts a full checkout link (https://…/pay/pay_…?t=…) or "pay_…?t=…".
function parseLink(input: string): { id: string; token: string } | null {
  const m = /(pay_[0-9a-f]{26})\?(?:.*&)?t=([0-9a-f]{40})/.exec(input.trim());
  return m ? { id: m[1], token: m[2] } : null;
}

export default function Explorer() {
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<{ id: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function lookup() {
    const parsed = parseLink(query);
    setError(parsed ? null : "Paste the full checkout link — it includes the payment id and its view token.");
    setTarget(parsed);
  }

  return (
    <main>
      <Container className="py-12 sm:py-16">
        <h1 className="text-[40px] font-semibold tracking-tight text-ink sm:text-[48px]">Verify a payment</h1>
        <p className="mt-3 max-w-2xl text-[16px] leading-relaxed text-muted">
          Paste a ZecOne checkout link to see its live status. A link only reveals that one payment; it can&apos;t change
          anything.
        </p>
        <form
          className="mt-8 flex max-w-2xl gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            lookup();
          }}
        >
          <label className="flex flex-1 items-center gap-2 rounded-full border border-line bg-surface px-4 py-3 focus-within:border-ink/40">
            <Search size={17} className="text-muted" />
            <input
              aria-label="Checkout link"
              className="w-full bg-transparent font-mono text-[13px] text-ink outline-none"
              placeholder="https://…/pay/pay_…?t=…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <button type="submit" className="rounded-full bg-ink px-6 py-3 text-[14px] font-semibold text-white hover:bg-navy">
            Check status
          </button>
        </form>
        {error && <p className="mt-3 text-[13px] text-red">{error}</p>}
        {target && (
          <div className="mt-6 max-w-xl">
            <CheckoutPanel key={target.id} paymentId={target.id} checkoutToken={target.token} />
          </div>
        )}

        <h2 className="mt-16 text-[22px] font-semibold text-ink">Mainnet pilot transactions</h2>
        <p className="mt-2 max-w-2xl text-[14.5px] text-muted">
          The transactions every demo checkout replays. Amounts and hashes are exactly as recorded on-chain.
        </p>
        <div className="mt-6 grid gap-5 md:grid-cols-3">
          {[
            { label: "Shielded ZEC deposit", id: EVIDENCE.zcashDeposit.txid, meta: `${EVIDENCE.zcashDeposit.zec} ZEC · block ${EVIDENCE.zcashDeposit.block}`, href: zcashTx(EVIDENCE.zcashDeposit.txid), mark: <ZcashMark size={22} /> },
            { label: "ETH payout on Base", id: EVIDENCE.basePayout.txHash, meta: `${EVIDENCE.basePayout.eth} ETH · block ${EVIDENCE.basePayout.block}`, href: baseTx(EVIDENCE.basePayout.txHash), mark: <BaseMark size={22} /> },
            { label: "Shielded ZEC spend", id: EVIDENCE.zcashWithdrawal.txid, meta: `0.001 ZEC sent · block ${EVIDENCE.zcashWithdrawal.block}`, href: zcashTx(EVIDENCE.zcashWithdrawal.txid), mark: <ZcashMark size={22} /> },
          ].map((t) => (
            <a key={t.id} href={t.href} target="_blank" rel="noreferrer" className="group rounded-2xl border border-line bg-surface p-5 transition-colors hover:border-ink/25">
              <div className="flex items-center justify-between">
                <span className="text-[14px] font-semibold text-ink">{t.label}</span>
                {t.mark}
              </div>
              <div className="mt-1 text-[13px] text-muted">{t.meta}</div>
              <div className="mt-3 break-all font-mono text-[11.5px] leading-relaxed text-ink-soft">{t.id}</div>
              <div className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-blue-deep">
                Open in explorer <ArrowUpRight size={14} />
              </div>
            </a>
          ))}
        </div>
      </Container>
    </main>
  );
}
