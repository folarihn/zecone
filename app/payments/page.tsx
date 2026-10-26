import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Code2, LayoutDashboard, Link2, ShoppingBag } from "lucide-react";
import { Band, ButtonLink, Callout, Container, PageHeader, SectionHeading } from "../ui";

export const metadata: Metadata = { title: "ZecOne Pay: accept shielded ZEC, receive ETH on Base" };

const MODES = [
  {
    name: "Simulated demo",
    tone: "border-line-strong bg-surface",
    chip: "bg-canvas text-ink-soft border-line-strong",
    status: "Default in this build",
    points: ["No payment address is shown", "Nothing to pay", "Steps replay the recorded mainnet pilot, labelled as a replay"],
  },
  {
    name: "Mainnet monitoring",
    tone: "border-gold/50 bg-gold-soft/50",
    chip: "bg-gold-soft text-gold-deep border-gold/40",
    status: "Operator machine only",
    points: ["Shows the real shielded receiving address", "Detects and confirms real deposits, read-only", "Stops at ZEC confirmed: no automatic payout"],
  },
  {
    name: "Live settlement",
    tone: "border-dashed border-line-strong bg-canvas",
    chip: "bg-red-soft text-red border-red/25",
    status: "Disabled",
    points: ["Would pay merchants ETH on Base automatically", "Refused by the payment API in this build", "Requires a separate, reviewed release"],
  },
];

export default function Payments() {
  return (
    <main>
      <PageHeader
        crumbs={[{ label: "Home", href: "/" }, { label: "Payments" }]}
        title="ZecOne Pay"
        lead="Accept shielded Zcash from your customers and receive ETH on Base at an address you proved you own. Start with a payment link, embed the checkout, or call the API."
        actions={
          <>
            <ButtonLink href="/dashboard">Open the merchant dashboard</ButtonLink>
            <ButtonLink href="/checkout" variant="secondary">
              Try the demo checkout
            </ButtonLink>
          </>
        }
      />

      <Band>
        <Container className="py-16">
          <div className="grid gap-4 md:grid-cols-3">
            {[
              { Icon: ShoppingBag, t: "Demo checkout", d: "Buy from the demo store and watch a simulated payment move through every step.", href: "/checkout", cta: "Open the demo store" },
              { Icon: LayoutDashboard, t: "Merchant dashboard", d: "Sign in with your Base wallet, get an API key, create links and set webhooks.", href: "/dashboard", cta: "Go to the dashboard" },
              { Icon: Code2, t: "Integration guide", d: "Create payments with @zecone/sdk and unlock orders on a signed webhook.", href: "/docs", cta: "Read the guide" },
            ].map(({ Icon, t, d, href, cta }) => (
              <Link key={t} href={href} className="group flex flex-col rounded-[var(--radius-xl)] border border-line bg-surface p-6 transition-colors hover:border-forest/40">
                <Icon size={22} aria-hidden="true" className="text-lime-deep" />
                <h2 className="zc-h3 mt-4 text-ink">{t}</h2>
                <p className="mt-2 flex-1 text-[15.5px] leading-relaxed text-muted">{d}</p>
                <span className="mt-5 inline-flex items-center gap-1.5 font-semibold text-ink">
                  {cta} <ArrowRight size={16} aria-hidden="true" className="transition-transform group-hover:translate-x-0.5" />
                </span>
              </Link>
            ))}
          </div>
        </Container>
      </Band>

      <Band tone="paper">
        <Container className="py-16">
          <SectionHeading
            eyebrow="Operating modes"
            title="Three modes, never confused"
            subtitle="Every checkout shows which mode it is in. Only the first two can run in this build."
          />
          <div className="grid gap-4 lg:grid-cols-3">
            {MODES.map((m) => (
              <section key={m.name} className={`rounded-[var(--radius-xl)] border p-6 ${m.tone}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="zc-h3 text-ink">{m.name}</h3>
                  <span className={`rounded-full border px-2.5 py-0.5 text-[13px] font-semibold ${m.chip}`}>{m.status}</span>
                </div>
                <ul className="mt-4 grid gap-2 text-[15px] leading-relaxed text-ink-soft">
                  {m.points.map((p) => (
                    <li key={p} className="flex gap-2.5">
                      <span aria-hidden="true" className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-sage" />
                      {p}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </Container>
      </Band>

      <Band>
        <Container className="grid gap-10 py-16 lg:grid-cols-2">
          <div>
            <SectionHeading eyebrow="What you need" title="Before you accept payments" className="mb-6" />
            <ol className="grid gap-5">
              {[
                ["Prove your payout wallet", "Connect the Base wallet that should receive ETH and sign a one-time message. It authorizes no transaction."],
                ["Store your API key on your server", "The key is shown once. It never belongs in browser code."],
                ["Register a webhook", "Unlock orders only when a signed payment.completed event arrives."],
              ].map(([t, d], i) => (
                <li key={t} className="grid grid-cols-[32px_1fr] gap-4">
                  <span className="grid h-8 w-8 place-items-center rounded-full bg-forest font-mono text-[14px] text-lime">{i + 1}</span>
                  <span>
                    <span className="block font-semibold text-ink">{t}</span>
                    <span className="block text-[15.5px] leading-relaxed text-muted">{d}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
          <div className="grid content-start gap-4">
            <Callout tone="warning" title="Limits in this build">
              One checkout can await payment at a time, because all checkouts share one receiving address. Quotes last 15 minutes,
              and the demo uses a fixed rate of 1 ZEC = $50.
            </Callout>
            <Callout title="Privacy, plainly">
              Your customer&apos;s Zcash payment is shielded. Your ETH payout on Base is public, and the ZecOne operator can link the
              two. <Link href="/security" className="font-semibold text-ink underline underline-offset-4">Read the trust model</Link>.
            </Callout>
            <Link href="/dashboard" className="inline-flex items-center gap-2 font-semibold text-ink hover:underline underline-offset-4">
              <Link2 size={16} aria-hidden="true" /> Create your first payment link
            </Link>
          </div>
        </Container>
      </Band>
    </main>
  );
}
