import Link from "next/link";
import { ArrowRight, Code2, Eye, KeyRound, Laptop, Link2, Lock, Server, ShieldCheck, Webhook } from "lucide-react";
import Wallet from "./wallet";
import HomeWidget from "./home-widget";
import HeroLane from "./components/hero-lane";
import { Band, BaseMark, ButtonLink, Container, SectionHeading, TxRow, ZcashMark } from "./ui";
import { EVIDENCE, baseTx, zcashTx } from "./evidence";

export const dynamic = "force-dynamic";

export default function Home() {
  // The local wallet gateway (Launch-ZecOne.cmd) keeps serving the wallet at "/".
  if (process.env.ZECONE_SURFACE === "wallet")
    return (
      <div className="wallet-scope">
        <Wallet />
      </div>
    );
  return <Marketing />;
}

const fmt = (n: number) => n.toLocaleString("en-US");

function Marketing() {
  return (
    <main>
      {/* Hero ------------------------------------------------------------ */}
      <Band tone="forest" className="relative overflow-hidden">
        <div aria-hidden="true" className="zc-hatch pointer-events-none absolute inset-0 [mask-image:linear-gradient(to_right,transparent_35%,black_75%)]" />
        <Container className="relative grid items-center gap-12 pb-20 pt-14 sm:pt-20 lg:grid-cols-[1.1fr_0.9fr] lg:gap-16 lg:pb-24">
          <div className="animate-rise">
            <p className="mb-6 inline-flex items-center gap-2 rounded-full border border-ivory/15 px-3 py-1 text-[14px] text-ivory/80">
              <span className="h-1.5 w-1.5 rounded-full bg-lime" aria-hidden="true" />
              Wallet and payments, one shielded ecosystem
            </p>
            <h1 className="zc-display max-w-[13ch] text-ivory">Keep ZEC private. Spend it anywhere.</h1>
            <p className="zc-lead mt-6 max-w-[36rem] text-ivory/75">
              ZecOne is a Zcash wallet that keeps your money in the shielded pool, and a payment platform that lets merchants
              accept that shielded ZEC and receive ETH on Base through a prefunded ZecOne relayer.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <ButtonLink href="/payments" variant="lime" size="lg">
                Explore ZecOne Pay <ArrowRight size={18} aria-hidden="true" />
              </ButtonLink>
              <ButtonLink href="/wallet-app" variant="outline-dark" size="lg">
                Meet the wallet
              </ButtonLink>
            </div>
          </div>
          <div className="animate-rise delay-2">
            <HeroLane />
          </div>
        </Container>
      </Band>

      {/* 1. Wallet -------------------------------------------------------- */}
      <Band id="wallet">
        <Container className="grid items-center gap-12 py-20 lg:grid-cols-[0.95fr_1.05fr] lg:gap-16 lg:py-24">
          <div>
            <SectionHeading
              eyebrow="ZecOne Wallet"
              title="A shielded wallet that lives on your computer"
              subtitle="Your keys and history stay on your machine. ZEC is held in the shielded pool, and every website request is shown to you before anything is signed."
              className="mb-8"
            />
            <ul className="grid gap-5">
              {[
                [Laptop, "Local by design", "Started by the ZecOne launcher and served only to your own browser."],
                [Lock, "Shielded first", "Balances and payments use Zcash shielded addresses."],
                [Eye, "Approve every request", "Connected websites ask; you review the exact action before approving."],
              ].map(([Icon, t, d]) => {
                const I = Icon as typeof Laptop;
                return (
                  <li key={t as string} className="flex gap-4">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-forest text-lime">
                      <I size={18} aria-hidden="true" />
                    </span>
                    <span>
                      <span className="block font-semibold text-ink">{t as string}</span>
                      <span className="block text-[15.5px] leading-relaxed text-muted">{d as string}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="mt-9 flex flex-wrap gap-3">
              <ButtonLink href="/wallet-app">See the wallet</ButtonLink>
            </div>
            <p className="mt-4 text-[14px] text-muted">Mainnet wallet support is in development; the current wallet build runs on testnets.</p>
          </div>
          <WalletPreview />
        </Container>
      </Band>

      {/* 2. Pay ----------------------------------------------------------- */}
      <Band tone="paper" id="pay">
        <Container className="grid items-start gap-12 py-20 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16 lg:py-24">
          <div className="order-2 lg:order-1">
            <HomeWidget />
          </div>
          <div className="order-1 lg:order-2">
            <SectionHeading
              eyebrow="ZecOne Pay"
              title="Accept shielded ZEC. Receive ETH on Base."
              subtitle="Your customer pays from any Zcash wallet without revealing their balance or history. You receive ETH at a Base address you proved you control, with signed webhooks telling your server when an order is paid."
              className="mb-8"
            />
            <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-lg)] border border-line bg-line">
              {[
                ["Customer side", "Shielded ZEC", "Amounts and addresses encrypted"],
                ["Merchant side", "ETH on Base", "Public, to your verified address"],
                ["Settlement", "ZecOne relayer", "Prefunded and trusted"],
                ["Integration", "Link, embed or API", "Same checkout everywhere"],
              ].map(([k, v, d]) => (
                <div key={k} className="bg-surface p-4 sm:p-5">
                  <dt className="text-[13.5px] text-muted">{k}</dt>
                  <dd className="mt-1 font-display text-[18px] font-semibold text-ink">{v}</dd>
                  <dd className="mt-0.5 text-[14px] text-muted">{d}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-8 flex flex-wrap gap-3">
              <ButtonLink href="/payments">How ZecOne Pay works</ButtonLink>
              <ButtonLink href="/dashboard" variant="secondary">
                Open the merchant dashboard
              </ButtonLink>
            </div>
          </div>
        </Container>
      </Band>

      {/* 3. Flow ---------------------------------------------------------- */}
      <Band id="flow">
        <Container className="py-20 lg:py-24">
          <SectionHeading
            eyebrow="The payment flow"
            title="Five steps from a shielded payment to a paid order"
            subtitle="Every checkout moves through the same states, whether it is a payment link, an embedded component or an API call."
          />
          <ol className="relative grid gap-0 lg:grid-cols-5">
            {[
              ["Request", "Your server creates a payment. ZecOne fixes the exact ZEC amount for 15 minutes.", "zcash"],
              ["Shielded payment", "The customer sends ZEC to the shielded address for that order.", "zcash"],
              ["Confirmed", "ZecOne attributes the exact transaction and waits for 20 confirmations.", "zcash"],
              ["Payout", "The relayer sends ETH from its prefunded balance to your verified Base address.", "base"],
              ["Completed", "A signed payment.completed webhook lets your server unlock the order.", "base"],
            ].map(([t, d, chain], i) => (
              <li key={t} className="relative border-l-2 border-line pb-8 pl-6 lg:border-l-0 lg:border-t-2 lg:pb-0 lg:pl-0 lg:pr-6 lg:pt-6">
                <span
                  aria-hidden="true"
                  className={`absolute -left-[9px] top-0 grid h-4 w-4 place-items-center rounded-full lg:-top-[9px] lg:left-0 ${chain === "zcash" ? "bg-gold" : "bg-blue"}`}
                />
                <span className="font-mono text-[13px] text-muted">Step {i + 1}</span>
                <h3 className="zc-h3 mt-1 text-ink">{t}</h3>
                <p className="mt-2 text-[15px] leading-relaxed text-muted">{d}</p>
              </li>
            ))}
          </ol>
          <p className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-[14px] text-muted">
            <span className="flex items-center gap-2">
              <ZcashMark size={16} /> Zcash, shielded
            </span>
            <span className="flex items-center gap-2">
              <BaseMark size={16} /> Base, public
            </span>
          </p>
        </Container>
      </Band>

      {/* 4. Evidence ------------------------------------------------------ */}
      <Band tone="forest" id="evidence">
        <Container className="grid gap-12 py-20 lg:grid-cols-[0.8fr_1.2fr] lg:py-24">
          <div>
            <SectionHeading
              tone="dark"
              eyebrow="Verified on mainnet"
              title="The full path already ran once, for real"
              subtitle="During the ZecOne pilot a shielded mainnet payment was received and the merchant was paid ETH on Base mainnet. Open each transaction on its block explorer. The demo checkout replays exactly these, and says so."
              className="mb-6"
            />
            <Link href="/explorer#evidence" className="inline-flex items-center gap-2 font-semibold text-lime hover:underline underline-offset-4">
              See all evidence <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>
          <div className="self-start rounded-[var(--radius-xl)] bg-ivory p-2 text-ink sm:p-3">
            <div className="divide-y divide-line">
              <TxRow
                chain="zcash"
                title="Customer payment received, shielded"
                meta={<span>Zcash block {fmt(EVIDENCE.zcashDeposit.block)}</span>}
                amount={`${EVIDENCE.zcashDeposit.zec} ZEC`}
                href={zcashTx(EVIDENCE.zcashDeposit.txid)}
                hash={EVIDENCE.zcashDeposit.txid}
              />
              <TxRow
                chain="base"
                title="Merchant paid in ETH by the relayer"
                meta={<span>Base block {fmt(EVIDENCE.basePayout.block)}</span>}
                amount={`${EVIDENCE.basePayout.eth.slice(0, 10)} ETH`}
                href={baseTx(EVIDENCE.basePayout.txHash)}
                hash={EVIDENCE.basePayout.txHash}
              />
              <TxRow
                chain="zcash"
                title="Operator spent from the receiving wallet"
                meta={<span>Zcash block {fmt(EVIDENCE.zcashWithdrawal.block)}</span>}
                amount="0.001 ZEC"
                href={zcashTx(EVIDENCE.zcashWithdrawal.txid)}
                hash={EVIDENCE.zcashWithdrawal.txid}
              />
            </div>
          </div>
        </Container>
      </Band>

      {/* 5. Developers ---------------------------------------------------- */}
      <Band id="developers">
        <Container className="py-20 lg:py-24">
          <SectionHeading
            eyebrow="For developers"
            title="Three ways to add ZecOne to your DApp"
            subtitle="All three use the same payment API and the same checkout, so you can start with a link and move to the SDK later."
          />
          <div className="grid gap-px overflow-hidden rounded-[var(--radius-xl)] border border-line bg-line md:grid-cols-3">
            {[
              {
                Icon: Link2,
                t: "Payment links",
                d: "Create a link in the dashboard and share it anywhere. No code.",
                code: "https://…/pay/pay_…?t=…",
                href: "/dashboard",
                cta: "Create a link",
              },
              {
                Icon: Code2,
                t: "Embedded checkout",
                d: "Render the checkout inside your React or Next.js app with a read-only token.",
                code: "<ZecOneCheckout paymentId={id} … />",
                href: "/docs#embedded",
                cta: "See the component",
              },
              {
                Icon: Webhook,
                t: "API and signed webhooks",
                d: "Create payments from your server and unlock orders on a verified webhook.",
                code: "zecone.payments.create({ amountUsd })",
                href: "/docs#webhooks",
                cta: "Read the API guide",
              },
            ].map(({ Icon, t, d, code, href, cta }) => (
              <div key={t} className="flex flex-col bg-surface p-6 sm:p-7">
                <Icon size={22} aria-hidden="true" className="text-lime-deep" />
                <h3 className="zc-h3 mt-4 text-ink">{t}</h3>
                <p className="mt-2 flex-1 text-[15.5px] leading-relaxed text-muted">{d}</p>
                <code className="mt-5 block overflow-x-auto whitespace-nowrap rounded-[10px] bg-forest px-3.5 py-2.5 font-mono text-[13px] text-lime">{code}</code>
                <Link href={href} className="mt-5 inline-flex items-center gap-1.5 font-semibold text-ink hover:underline underline-offset-4">
                  {cta} <ArrowRight size={16} aria-hidden="true" />
                </Link>
              </div>
            ))}
          </div>
        </Container>
      </Band>

      {/* 6. Security ------------------------------------------------------ */}
      <Band tone="paper" id="security">
        <Container className="grid gap-12 py-20 lg:grid-cols-[0.85fr_1.15fr] lg:py-24">
          <div>
            <SectionHeading
              eyebrow="Security and privacy"
              title="Private where it can be. Honest where it cannot."
              subtitle="ZecOne is a trusted relayer, not a trustless bridge. Here is exactly who can see what."
              className="mb-6"
            />
            <ButtonLink href="/security" variant="secondary">
              Read the trust model
            </ButtonLink>
          </div>
          <div className="grid gap-px overflow-hidden rounded-[var(--radius-xl)] border border-line bg-line sm:grid-cols-2">
            {[
              [ShieldCheck, "Shielded on Zcash", "Observers cannot see the customer's address, balance or amount."],
              [Eye, "Public on Base", "The ETH payout and your payout address are visible to anyone."],
              [Server, "Operator can link them", "The ZecOne relayer knows which payment funded which payout."],
              [KeyRound, "Keys stay separated", "The payment API never loads spending, relayer or signing keys."],
            ].map(([Icon, t, d]) => {
              const I = Icon as typeof Eye;
              return (
                <div key={t as string} className="bg-surface p-6">
                  <I size={20} aria-hidden="true" className="text-forest" />
                  <h3 className="mt-3 font-display text-[17px] font-semibold text-ink">{t as string}</h3>
                  <p className="mt-1.5 text-[15px] leading-relaxed text-muted">{d as string}</p>
                </div>
              );
            })}
          </div>
        </Container>
      </Band>

      {/* 7. Demo invitation ----------------------------------------------- */}
      <Band>
        <Container className="py-20">
          <div className="zc-dark relative overflow-hidden rounded-[28px] bg-forest px-7 py-12 text-ivory sm:px-12 lg:px-16">
            <div aria-hidden="true" className="zc-hatch pointer-events-none absolute inset-0" />
            <div className="relative grid items-center gap-8 lg:grid-cols-[1fr_auto]">
              <div>
                <h2 className="zc-h2 max-w-xl">Try the whole flow in under a minute</h2>
                <p className="mt-4 max-w-xl text-[16.5px] leading-relaxed text-ivory/75">
                  Buy something from the demo store and watch each step. Demo checkouts are simulated: there is nothing to pay,
                  no address is shown, and the steps replay the recorded mainnet pilot.
                </p>
              </div>
              <ButtonLink href="/checkout" variant="lime" size="lg">
                Open the demo store <ArrowRight size={18} aria-hidden="true" />
              </ButtonLink>
            </div>
          </div>
        </Container>
      </Band>
    </main>
  );
}

/** Static, labelled design preview of the wallet. Not connected to any wallet data. */
function WalletPreview() {
  return (
    <figure className="relative">
      <div className="zc-dark overflow-hidden rounded-[28px] border border-forest bg-forest p-5 text-ivory shadow-float sm:p-6">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-[14px] text-ivory/70">
            <span className="h-2 w-2 rounded-full bg-gold" aria-hidden="true" /> Zcash testnet
          </span>
          <span className="rounded-full border border-ivory/15 px-2.5 py-0.5 text-[13px] text-ivory/70">Design preview</span>
        </div>
        <p className="mt-7 text-[14px] text-ivory/60">Shielded balance</p>
        <p className="font-display text-[44px] font-semibold leading-none tracking-[-0.03em]">
          12.4800 <span className="text-[22px] text-ivory/60">ZEC</span>
        </p>
        <div className="mt-6 grid grid-cols-2 gap-2">
          <span className="rounded-full bg-lime py-2.5 text-center text-[15px] font-semibold text-forest">Send</span>
          <span className="rounded-full border border-ivory/20 py-2.5 text-center text-[15px] font-semibold">Receive</span>
        </div>
        <ul className="mt-6 divide-y divide-ivory/10 rounded-2xl bg-forest-2 px-4">
          {[
            ["Received", "+2.0000 ZEC", "Shielded"],
            ["Paid a merchant", "−0.1000 ZEC", "Shielded"],
            ["Received", "+0.5000 ZEC", "Shielded"],
          ].map(([t, a, n], i) => (
            <li key={i} className="flex items-center justify-between py-3 text-[14.5px]">
              <span>
                <span className="block">{t}</span>
                <span className="block text-[13px] text-ivory/50">{n}</span>
              </span>
              <span className="font-mono text-[14px]">{a}</span>
            </li>
          ))}
        </ul>
      </div>
      <figcaption className="mt-3 text-[13.5px] text-muted">Design preview with sample values. Not connected to a wallet.</figcaption>
    </figure>
  );
}
