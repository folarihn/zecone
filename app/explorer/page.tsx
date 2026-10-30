"use client";
import { useState } from "react";
import { ArrowUpRight, Search, SearchCheck } from "lucide-react";
import { EVIDENCE, baseTx, zcashTx } from "../evidence";
import CheckoutPanel from "../components/checkout-panel";
import { BaseMark, Callout, Container, EmptyState, PageHeader, Pill, ZcashMark, buttonClass } from "../ui";
import { CopyButton } from "../components/ui-client";

// Accepts a full checkout link (https://…/pay/pay_…?t=…) or "pay_…?t=…".
function parseLink(input: string): { id: string; token: string } | null {
  const m = /(pay_[0-9a-f]{26})\?(?:.*&)?t=([0-9a-f]{40})/.exec(input.trim());
  return m ? { id: m[1], token: m[2] } : null;
}

// Intentionally public, recorded Mainnet evidence. The first three entries are
// the historical cross-chain pilot; the fourth is a separate Zcash execution
// test. Values come from app/evidence.ts; nothing here is a live wallet feed.
const TIMELINE = [
  {
    chain: "zcash" as const,
    title: "Shielded ZEC payment received",
    explain: "A customer's shielded payment arrived at the ZecOne receiving address. On chain, sender, recipient and amount are encrypted.",
    network: "Zcash mainnet",
    block: EVIDENCE.zcashDeposit.block,
    amount: `${EVIDENCE.zcashDeposit.zec} ZEC`,
    sub: `${EVIDENCE.zcashDeposit.zatoshis} zatoshis`,
    hash: EVIDENCE.zcashDeposit.txid,
    href: zcashTx(EVIDENCE.zcashDeposit.txid),
    explorer: "zcashblockexplorer.com",
  },
  {
    chain: "base" as const,
    title: "ETH paid to the merchant on Base",
    explain: "The prefunded ZecOne relayer paid the merchant's verified address. This leg is public: anyone can see the amount and the address.",
    network: "Base mainnet (8453)",
    block: EVIDENCE.basePayout.block,
    amount: `${EVIDENCE.basePayout.eth} ETH`,
    sub: `${EVIDENCE.basePayout.wei} wei`,
    hash: EVIDENCE.basePayout.txHash,
    href: baseTx(EVIDENCE.basePayout.txHash),
    explorer: "basescan.org",
  },
  {
    chain: "zcash" as const,
    title: "Operator spent from the receiving wallet",
    explain: "Proof the operator controls the shielded receiving wallet: 0.001 ZEC sent, with the rest returned as shielded change.",
    network: "Zcash mainnet",
    block: EVIDENCE.zcashWithdrawal.block,
    amount: "0.001 ZEC",
    sub: `fee ${EVIDENCE.zcashWithdrawal.feeZat} zat, change ${EVIDENCE.zcashWithdrawal.changeZat} zat`,
    hash: EVIDENCE.zcashWithdrawal.txid,
    href: zcashTx(EVIDENCE.zcashWithdrawal.txid),
    explorer: "zcashblockexplorer.com",
  },
  {
    chain: "zcash" as const,
    title: "Operator-approved Mainnet execution test",
    explain: "A separate, real Zcash mainnet transfer proved the guarded local workflow can synchronize, prepare, require exact SIGN and BROADCAST approvals, submit once and reconcile to finality. It was not created by the hosted checkout and did not trigger a Base payout.",
    network: "Zcash mainnet",
    block: EVIDENCE.zcashExecutionTest.block,
    amount: "0.0001 ZEC",
    sub: `fee ${EVIDENCE.zcashExecutionTest.feeZat} zat, change ${EVIDENCE.zcashExecutionTest.changeZat} zat · FINALIZED (${EVIDENCE.zcashExecutionTest.finalityThreshold}+ confirmations)`,
    hash: EVIDENCE.zcashExecutionTest.txid,
    href: zcashTx(EVIDENCE.zcashExecutionTest.txid),
    explorer: "zcashblockexplorer.com",
  },
];

export default function Explorer() {
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<{ id: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function lookup() {
    const parsed = parseLink(query);
    setError(parsed ? null : "That is not a complete checkout link. Paste the whole link: it contains the payment id (pay_…) and its view token (t=…).");
    setTarget(parsed);
  }

  return (
    <main>
      <PageHeader
        crumbs={[{ label: "Home", href: "/" }, { label: "Explore", href: "/explorer" }, { label: "Verify a payment" }]}
        title="Verify a payment"
        lead="Paste a ZecOne checkout link to see its status, network and confirmations. A link only reveals that one payment and cannot change anything."
      />

      <Container className="py-10 sm:py-14">
        <form
          role="search"
          className="flex max-w-3xl flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            lookup();
          }}
        >
          <label className="flex min-h-12 flex-1 items-center gap-2.5 rounded-full border border-line-strong bg-white px-4 focus-within:border-forest focus-within:ring-2 focus-within:ring-lime">
            <Search size={18} className="shrink-0 text-muted" aria-hidden="true" />
            <input
              aria-label="Checkout link"
              className="w-full bg-transparent py-3 font-mono text-[14px] text-ink outline-none"
              placeholder="https://…/pay/pay_…?t=…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <button type="submit" className={buttonClass("primary", "lg")}>
            Check status
          </button>
        </form>
        {error && (
          <Callout tone="danger" className="mt-4 max-w-3xl">
            <span role="alert">{error}</span>
          </Callout>
        )}

        <div className="mt-8 grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0">
            {target ? (
              <CheckoutPanel key={target.id} paymentId={target.id} checkoutToken={target.token} />
            ) : (
              <EmptyState title="No payment selected" icon={<SearchCheck size={18} />}>
                Paste the checkout link a merchant sent you, or the one from your dashboard. You will see the amount, the mode
                (simulated demo, mainnet monitoring or live) and live progress through each step.
              </EmptyState>
            )}
          </div>
          <aside aria-label="Reading the result" className="rounded-[var(--radius-xl)] border border-line bg-surface p-6">
            <h2 className="font-display text-[17px] font-semibold text-ink">Reading the result</h2>
            <dl className="mt-3 grid gap-3 text-[14.5px] leading-relaxed">
              <div>
                <dt className="font-semibold text-ink">Simulated demo</dt>
                <dd className="text-muted">Nothing was paid. The steps replay the recorded pilot below.</dd>
              </div>
              <div>
                <dt className="font-semibold text-ink">Mainnet monitoring</dt>
                <dd className="text-muted">Real ZEC observed read-only. Confirmations count up to 20; payout stays off.</dd>
              </div>
              <div>
                <dt className="font-semibold text-ink">Completed</dt>
                <dd className="text-muted">A completed real payment links to its Base payout transaction.</dd>
              </div>
            </dl>
          </aside>
        </div>
      </Container>

      <section id="evidence" aria-labelledby="evidence-h" className="scroll-mt-20 border-t border-line bg-surface">
        <Container className="py-16">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="max-w-2xl">
              <h2 id="evidence-h" className="zc-h2 text-ink">
                Mainnet transaction evidence
              </h2>
              <p className="mt-3 text-[16.5px] leading-relaxed text-muted">
                The first three records document the historical Zcash-to-Base pilot. The fourth is a separate, operator-approved
                Zcash mainnet execution test. Demo checkouts replay the historical pilot and are labelled as simulations; they do
                not create these transactions. This is intentionally public evidence, not a live wallet feed.
              </p>
            </div>
            <Pill tone="green" dot>
              Mined on mainnet
            </Pill>
          </div>

          <ol className="mt-10 grid gap-5">
            {TIMELINE.map((t, i) => (
              <li key={t.hash} className="grid gap-4 md:grid-cols-[48px_1fr]">
                <div className="hidden flex-col items-center md:flex" aria-hidden="true">
                  {t.chain === "zcash" ? <ZcashMark size={36} /> : <BaseMark size={36} />}
                  {i < TIMELINE.length - 1 && <span className="mt-2 w-px flex-1 bg-line-strong" />}
                </div>
                <article className="rounded-[var(--radius-xl)] border border-line bg-canvas p-5 sm:p-6">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[14px] text-muted">
                        Step {i + 1}, {t.network}
                      </p>
                      <h3 className="zc-h3 mt-0.5 text-ink">{t.title}</h3>
                    </div>
                    <p className="text-right">
                      <span className="block font-mono text-[17px] font-medium tabular-nums text-ink">{t.amount}</span>
                      <span className="block font-mono text-[13px] text-muted">{t.sub}</span>
                    </p>
                  </div>
                  <p className="mt-3 max-w-2xl text-[15.5px] leading-relaxed text-ink-soft">{t.explain}</p>
                  <dl className="mt-4 grid gap-3 border-t border-line pt-4 text-[14.5px] sm:grid-cols-[auto_1fr] sm:gap-x-8">
                    <dt className="text-muted">Block</dt>
                    <dd className="font-mono text-ink">{t.block.toLocaleString("en-US")}</dd>
                    <dt className="text-muted">Transaction</dt>
                    <dd className="flex min-w-0 flex-wrap items-center gap-x-2">
                      <span className="zc-hash min-w-0 text-ink-soft">{t.hash}</span>
                      <CopyButton value={t.hash} label="Copy hash" />
                    </dd>
                  </dl>
                  <a
                    href={t.href}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-4 inline-flex items-center gap-1.5 text-[15px] font-semibold text-ink underline-offset-4 hover:underline"
                  >
                    Open on {t.explorer} <ArrowUpRight size={15} aria-hidden="true" />
                  </a>
                </article>
              </li>
            ))}
          </ol>
        </Container>
      </section>
    </main>
  );
}
