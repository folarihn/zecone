import type { Metadata } from "next";
import { Ban, Droplets, Eye, Globe, KeyRound, Lock, Server, ShieldCheck } from "lucide-react";
import { Band, BaseMark, Callout, Container, PageHeader, SectionHeading, ZcashMark } from "../ui";

export const metadata: Metadata = { title: "Security and privacy | ZecOne" };

const VISIBILITY = [
  {
    title: "Private on chain",
    Icon: Lock,
    tint: "border-gold/50 bg-gold-soft/50",
    who: "The public cannot see",
    body: "The customer's shielded Zcash address, the amount and the note contents. The payment sits inside the shielded pool.",
  },
  {
    title: "Public on chain",
    Icon: Globe,
    tint: "border-blue/25 bg-blue-soft/60",
    who: "Anyone can see",
    body: "The Base payout: the ETH amount, the merchant's receiving address and the relayer address. It is permanent.",
  },
  {
    title: "Visible to the operator",
    Icon: Eye,
    tint: "border-line-strong bg-surface",
    who: "ZecOne can see",
    body: "The operator verifies the shielded payment with the wallet's viewing key, so it can link the Zcash payment to the Base payout. ZecOne does not promise anonymity from the operator.",
  },
];

const BOUNDARIES = [
  { Icon: KeyRound, t: "Payment API", d: "Holds no spending key, relayer key or signing credential. It cannot move funds.", tone: "text-green" },
  { Icon: Eye, t: "Mainnet watcher", d: "Uses a viewing key only (UFVK). It can see incoming payments, never spend them.", tone: "text-green" },
  { Icon: Server, t: "Relayer submitter", d: "The only component that could pay on Base. Paused by default and behind separate SIGN and BROADCAST approvals.", tone: "text-amber" },
  { Icon: ShieldCheck, t: "Merchant credentials", d: "API keys and sessions are stored hashed, scoped, rate-limited and rotatable.", tone: "text-green" },
];

export default function Security() {
  return (
    <main>
      <PageHeader
        crumbs={[{ label: "Home", href: "/" }, { label: "Explore", href: "/explorer" }, { label: "Security and privacy" }]}
        title="An honest trust model"
        lead="ZecOne is a trusted-relayer payment system, not a trustless bridge. This page states exactly what is private, what is public, who can link them, and what is switched off."
      />

      {/* Diagram */}
      <Band>
        <Container className="py-16">
          <SectionHeading title="How money moves, and who can see it" subtitle="Two chains with very different privacy, joined by an operator you have to trust." />
          <figure className="overflow-hidden rounded-[var(--radius-xl)] border border-line bg-surface">
            <div className="grid lg:grid-cols-[1fr_auto_1fr]">
              <div className="zc-dark zc-hatch bg-forest p-6 text-ivory sm:p-8">
                <p className="flex items-center gap-2 text-[14px] text-ivory/70">
                  <ZcashMark size={20} /> Zcash, shielded
                </p>
                <ol className="mt-5 grid gap-3">
                  <Node dark title="Customer wallet" sub="Pays shielded ZEC" />
                  <Node dark title="ZecOne receiving address" sub="One shielded address, viewing key on the watcher" />
                </ol>
                <p className="mt-5 text-[14.5px] text-ivory/70">Sender, recipient and amount are encrypted on chain.</p>
              </div>
              <div className="flex flex-col items-center justify-center gap-2 border-y border-line bg-canvas px-6 py-6 text-center lg:border-x lg:border-y-0">
                <span className="grid h-14 w-14 place-items-center rounded-full bg-forest font-display text-[17px] font-bold text-lime">Z1</span>
                <p className="font-display text-[16px] font-semibold text-ink">ZecOne operator</p>
                <p className="max-w-[16rem] text-[14px] leading-relaxed text-muted">Verifies the payment, then a prefunded relayer pays out. Can link both legs.</p>
              </div>
              <div className="p-6 sm:p-8">
                <p className="flex items-center gap-2 text-[14px] text-muted">
                  <BaseMark size={20} /> Base, public
                </p>
                <ol className="mt-5 grid gap-3">
                  <Node title="Relayer wallet" sub="Prefunded with ETH" />
                  <Node title="Merchant payout address" sub="Verified by wallet signature" />
                </ol>
                <p className="mt-5 text-[14.5px] text-muted">Amounts and addresses are public and permanent.</p>
              </div>
            </div>
            <figcaption className="border-t border-line px-6 py-3 text-[14px] text-muted">
              There is no cross-chain message. The two legs are joined only by the operator&apos;s ledger.
            </figcaption>
          </figure>
        </Container>
      </Band>

      {/* Visibility */}
      <Band tone="paper">
        <Container className="py-16">
          <SectionHeading title="Privacy is not all or nothing" />
          <div className="grid gap-4 md:grid-cols-3">
            {VISIBILITY.map(({ title, Icon, tint, who, body }) => (
              <section key={title} className={`rounded-[var(--radius-xl)] border p-6 ${tint}`}>
                <Icon size={22} aria-hidden="true" className="text-forest" />
                <h3 className="zc-h3 mt-4 text-ink">{title}</h3>
                <p className="mt-1 text-[14px] font-semibold text-ink-soft">{who}</p>
                <p className="mt-2 text-[15.5px] leading-relaxed text-muted">{body}</p>
              </section>
            ))}
          </div>
        </Container>
      </Band>

      {/* Relayer, liquidity */}
      <Band>
        <Container className="grid gap-10 py-16 lg:grid-cols-2">
          <div>
            <SectionHeading title="Trusted relayer, prefunded liquidity" className="mb-6" />
            <div className="grid gap-5 text-[16px] leading-relaxed text-ink-soft">
              <p>
                <strong className="text-ink">Not a trustless bridge.</strong> A trusted, prefunded relayer executes the Base payout
                after the operator verifies the Zcash payment. If the operator misbehaves, the merchant is not paid; nothing on
                chain forces it.
              </p>
              <p className="flex gap-3">
                <Droplets size={20} aria-hidden="true" className="mt-1 shrink-0 text-blue-deep" />
                <span>
                  <strong className="text-ink">Liquidity.</strong> The relayer pays from its own ETH balance. A quote is issued only if
                  that balance covers it and all open payouts. There is no automatic ZEC to ETH conversion, and the relayer can be
                  paused.
                </span>
              </p>
            </div>
          </div>
          <div>
            <SectionHeading title="Key boundaries" className="mb-6" />
            <ul className="divide-y divide-line overflow-hidden rounded-[var(--radius-xl)] border border-line bg-surface">
              {BOUNDARIES.map(({ Icon, t, d, tone }) => (
                <li key={t} className="flex gap-4 p-5">
                  <Icon size={20} aria-hidden="true" className={`mt-0.5 shrink-0 ${tone}`} />
                  <span>
                    <span className="block font-semibold text-ink">{t}</span>
                    <span className="block text-[15px] leading-relaxed text-muted">{d}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </Container>
      </Band>

      {/* Disabled */}
      <Band tone="paper">
        <Container className="py-16">
          <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr]">
            <div>
              <SectionHeading title="Switched off in this build" subtitle="Live settlement is disabled. These stay off until a separate, reviewed release." className="mb-6" />
              <Callout tone="warning" title="Live settlement is disabled">
                The merchant API refuses to start in live mode. Demo checkouts are simulated; monitor mode observes real deposits but
                never pays out.
              </Callout>
            </div>
            <div>
              <ul className="grid gap-px overflow-hidden rounded-[var(--radius-xl)] border border-line bg-line sm:grid-cols-2">
                {[
                  "Live Base payouts",
                  "Zcash mainnet broadcast",
                  "The Base relayer submitter (paused)",
                  "Any payout without separate operator SIGN and BROADCAST approvals",
                  "Browser-triggered payment completion (demo replays run on the server only)",
                  "Spending keys, keystores or passphrases on any public API process",
                ].map((x) => (
                  <li key={x} className="flex gap-3 bg-surface p-4 text-[15px] leading-relaxed text-ink-soft">
                    <Ban size={17} aria-hidden="true" className="mt-1 shrink-0 text-red" />
                    {x}
                  </li>
                ))}
              </ul>
              <p className="mt-5 text-[15px] leading-relaxed text-muted">
                Still enforced: quote expiry, a 20-confirmation policy for live attribution, one source transaction per order,
                relayer liquidity checks, signed webhooks with replay windows, and an append-only event log. Merchant accounts are
                created only after an EIP-4361 signature over a single-use, server-issued message, and payouts can only go to that
                verified address.
              </p>
            </div>
          </div>
        </Container>
      </Band>
    </main>
  );
}

function Node({ title, sub, dark = false }: { title: string; sub: string; dark?: boolean }) {
  return (
    <li className={`rounded-[14px] border px-4 py-3 ${dark ? "border-ivory/15 bg-forest-2" : "border-line bg-canvas"}`}>
      <span className={`block font-semibold ${dark ? "text-ivory" : "text-ink"}`}>{title}</span>
      <span className={`block text-[14px] ${dark ? "text-ivory/65" : "text-muted"}`}>{sub}</span>
    </li>
  );
}
