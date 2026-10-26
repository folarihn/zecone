import type { Metadata } from "next";
import { ArrowRight, Eye, Globe, Lock, ShieldCheck } from "lucide-react";
import { BaseMark, Container, Pill, SectionHeading, ZcashMark } from "../ui";

export const metadata: Metadata = { title: "Security & transparency — ZecOne" };

const VISIBILITY = [
  {
    title: "Private on-chain",
    tone: "gold",
    icon: <Lock size={18} className="text-gold-deep" />,
    body: "The shielded Zcash payment is private on-chain. The customer's shielded address, amount, and note are not visible to the public.",
  },
  {
    title: "Public on-chain",
    tone: "blue",
    icon: <Globe size={18} className="text-blue-deep" />,
    body: "The Base payout is public and permanent. Anyone can see the ETH amount and the merchant's receiving address.",
  },
  {
    title: "Visible to the operator",
    tone: "amber",
    icon: <Eye size={18} className="text-amber" />,
    body: "The operator verifies the shielded payment with the wallet's viewing keys, so it can correlate the two legs. ZecOne does not guarantee anonymity against the operator.",
  },
] as const;

export default function Security() {
  return (
    <main>
      <Container className="py-12 sm:py-16">
        <Pill tone="gold">Security &amp; transparency</Pill>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
          An honest trust model.
        </h1>
        <p className="mt-3 max-w-2xl text-[16px] leading-relaxed text-muted">
          ZecOne is a trusted-relayer payment system. We state its privacy boundaries precisely —
          we do not claim complete anonymity.
        </p>

        {/* Architecture */}
        <section className="mt-12">
          <SectionHeading eyebrow="Architecture" title="Customer → merchant, in four hops" />
          <div className="overflow-x-auto rounded-3xl border border-line bg-surface p-6 shadow-card sm:p-8">
            <div className="flex min-w-[640px] items-center justify-between gap-3">
              {[
                { label: "Customer", sub: "shielded ZEC", mark: <ZcashMark size={26} /> },
                { label: "ZecOne", sub: "verify & confirm", mark: <ShieldCheck size={24} className="text-gold" /> },
                { label: "Relayer", sub: "prefunded ETH", mark: <BaseMark size={26} /> },
                { label: "Merchant", sub: "receives ETH", mark: <BaseMark size={26} /> },
              ].map((step, i, arr) => (
                <div key={step.label} className="flex flex-1 items-center gap-3">
                  <div className="flex-1 rounded-2xl border border-line bg-canvas p-3.5 text-center">
                    <div className="mx-auto flex justify-center">{step.mark}</div>
                    <div className="mt-2 text-[13px] font-semibold text-ink">{step.label}</div>
                    <div className="text-[11px] text-muted">{step.sub}</div>
                  </div>
                  {i < arr.length - 1 && <ArrowRight size={18} className="shrink-0 text-line-strong" />}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Visibility */}
        <section className="mt-12">
          <SectionHeading eyebrow="Who sees what" title="Privacy is not binary" />
          <div className="grid gap-5 md:grid-cols-3">
            {VISIBILITY.map((v) => (
              <div key={v.title} className="rounded-2xl border border-line bg-surface p-6 shadow-card">
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-canvas">{v.icon}</div>
                <h3 className="mt-4 text-[16px] font-semibold text-ink">{v.title}</h3>
                <p className="mt-2 text-[13.5px] leading-relaxed text-muted">{v.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Points */}
        <section className="mt-12 grid gap-5 md:grid-cols-2">
          {[
            {
              title: "Not a trustless bridge",
              body: "There is no cross-chain message passing. A trusted, prefunded relayer executes the Base payout after the operator verifies the Zcash leg. The two legs are coupled only by the operator's ledger.",
            },
            {
              title: "Liquidity & availability",
              body: "The relayer is prefunded with ETH. Payouts require sufficient liquidity, and the relayer can be paused. There is no automated ZEC-to-ETH conversion.",
            },
            {
              title: "Operator controls",
              body: "Real payouts require separate SIGN and BROADCAST approvals, a paused-by-default submitter, confirmation thresholds, replay protection, and emergency pause. Live payout is disabled by default.",
            },
            {
              title: "Merchant credentials",
              body: "Merchant accounts are created only after an EIP-4361 wallet signature over a single-use, server-issued message. API keys and sessions are stored hashed, scoped, rate-limited and rotatable; payouts can only go to the signature-verified Base address.",
            },
          ].map((p) => (
            <div key={p.title} className="rounded-2xl border border-line bg-surface p-6 shadow-card">
              <h3 className="text-[16px] font-semibold text-ink">{p.title}</h3>
              <p className="mt-2 text-[14px] leading-relaxed text-muted">{p.body}</p>
            </div>
          ))}
        </section>
        <section className="mt-12 rounded-3xl border border-line bg-surface p-6 shadow-card sm:p-8">
          <h2 className="text-[20px] font-semibold text-ink">Switched off in this build</h2>
          <ul className="mt-4 grid gap-x-8 gap-y-2.5 text-[14px] text-ink-soft sm:grid-cols-2">
            {[
              "Live Base payouts (the merchant API refuses to start in live mode)",
              "Zcash mainnet broadcast",
              "The Base relayer submitter (paused)",
              "Any payout without separate operator SIGN and BROADCAST approvals",
              "Browser-triggered payment completion (demo replays run server-side only)",
              "Spending keys, keystores or passphrases on any public API process",
            ].map((x) => (
              <li key={x} className="flex gap-2">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-gold" />
                {x}
              </li>
            ))}
          </ul>
          <p className="mt-5 text-[13px] leading-relaxed text-muted">
            Still enforced in the payment journal: quote expiry, 20-confirmation policy for live attribution, one source
            transaction per order, relayer liquidity checks, signed webhooks with replay windows, and an append-only event log.
          </p>
        </section>
      </Container>
    </main>
  );
}
