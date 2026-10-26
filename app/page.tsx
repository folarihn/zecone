import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import Wallet from "./wallet";
import HomeWidget from "./home-widget";
import { BaseMark, ButtonLink, Container, ZcashMark } from "./ui";
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

const LEDGER = [
  {
    when: `Zcash block ${EVIDENCE.zcashDeposit.block.toLocaleString("en-US")}`,
    what: "Customer payment received in the shielded pool",
    amount: `${EVIDENCE.zcashDeposit.zec} ZEC`,
    href: zcashTx(EVIDENCE.zcashDeposit.txid),
    id: EVIDENCE.zcashDeposit.txid,
    mark: <ZcashMark size={22} />,
  },
  {
    when: `Base block ${EVIDENCE.basePayout.block.toLocaleString("en-US")}`,
    what: "Merchant paid in ETH by the ZecOne relayer",
    amount: `${EVIDENCE.basePayout.eth} ETH`,
    href: baseTx(EVIDENCE.basePayout.txHash),
    id: EVIDENCE.basePayout.txHash,
    mark: <BaseMark size={22} />,
  },
  {
    when: `Zcash block ${EVIDENCE.zcashWithdrawal.block.toLocaleString("en-US")}`,
    what: "Operator spent from the shielded receiving wallet",
    amount: "0.001 ZEC sent",
    href: zcashTx(EVIDENCE.zcashWithdrawal.txid),
    id: EVIDENCE.zcashWithdrawal.txid,
    mark: <ZcashMark size={22} />,
  },
];

function Marketing() {
  return (
    <main>
      <section>
        <Container className="grid items-center gap-12 pb-16 pt-12 sm:pt-16 lg:grid-cols-[1.05fr_1fr] lg:gap-14">
          <div className="animate-rise">
            <h1 className="text-[44px] font-semibold leading-[1.02] tracking-[-0.035em] text-ink sm:text-[60px]">
              Take shielded Zcash. Get paid in ETH on Base.
            </h1>
            <p className="mt-6 max-w-[34rem] text-[17px] leading-relaxed text-ink-soft">
              ZecOne is a checkout for DApps and online merchants. Your customer pays from a private Zcash wallet; you
              receive ETH at a Base address you&apos;ve proven you control. Drop in a hosted link, an embedded component,
              or call the API.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <ButtonLink href="/dashboard">Start accepting ZEC</ButtonLink>
              <ButtonLink href="/docs" variant="secondary">
                Read the integration guide
              </ButtonLink>
            </div>
            <dl className="mt-10 grid max-w-md grid-cols-2 gap-x-8 gap-y-4 border-t border-line pt-6 text-[13.5px]">
              <div>
                <dt className="text-muted">Customer side</dt>
                <dd className="mt-0.5 font-medium text-ink">Shielded ZEC, private on-chain</dd>
              </div>
              <div>
                <dt className="text-muted">Merchant side</dt>
                <dd className="mt-0.5 font-medium text-ink">ETH on Base, public</dd>
              </div>
            </dl>
          </div>
          <div className="animate-rise delay-2">
            <HomeWidget />
          </div>
        </Container>
      </section>

      <section className="border-y border-line bg-surface py-16">
        <Container>
          <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr]">
            <div>
              <h2 className="text-[28px] font-semibold tracking-tight text-ink">Already settled on mainnet</h2>
              <p className="mt-3 max-w-sm text-[15px] leading-relaxed text-muted">
                The full path ran once on Zcash and Base mainnet during the ZecOne pilot. These are the transactions —
                open them on the block explorers. The demo checkout replays exactly these, labelled as a replay.
              </p>
            </div>
            <ol className="divide-y divide-line border-y border-line">
              {LEDGER.map((row) => (
                <li key={row.id}>
                  <a
                    href={row.href}
                    target="_blank"
                    rel="noreferrer"
                    className="group grid grid-cols-[auto_1fr_auto] items-center gap-4 py-4 transition-colors hover:bg-canvas sm:px-2"
                  >
                    {row.mark}
                    <span className="min-w-0">
                      <span className="block text-[14.5px] font-medium text-ink">{row.what}</span>
                      <span className="block truncate text-[12.5px] text-muted">
                        {row.when} · <span className="font-mono">{row.id.slice(0, 18)}…</span>
                      </span>
                    </span>
                    <span className="flex items-center gap-1 text-right text-[14px] font-semibold tabular-nums text-ink">
                      {row.amount}
                      <ArrowUpRight size={15} className="text-muted transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                    </span>
                  </a>
                </li>
              ))}
            </ol>
          </div>
        </Container>
      </section>

      <section className="py-20">
        <Container>
          <h2 className="max-w-xl text-[28px] font-semibold tracking-tight text-ink">Three ways to add it to your DApp</h2>
          <div className="mt-10 grid gap-x-10 gap-y-10 md:grid-cols-3">
            {[
              {
                t: "Payment links",
                d: "Create a link from the dashboard and share it anywhere. Live checkouts show a QR code and the exact amount; every checkout shows live status.",
                href: "/dashboard",
                cta: "Create a link",
              },
              {
                t: "Embedded checkout",
                d: "Render <ZecOneCheckout> inside your React or Next.js app, themed to match. It only needs a read-only checkout token.",
                href: "/docs#embedded",
                cta: "See the component",
              },
              {
                t: "API and signed webhooks",
                d: "Create payments from your server with @zecone/sdk and unlock goods when a signed payment.completed webhook arrives.",
                href: "/docs#webhooks",
                cta: "Read the API guide",
              },
            ].map((m) => (
              <div key={m.t} className="border-t-2 border-ink pt-5">
                <h3 className="text-[17px] font-semibold text-ink">{m.t}</h3>
                <p className="mt-2 text-[14.5px] leading-relaxed text-muted">{m.d}</p>
                <Link href={m.href} className="mt-4 inline-block text-[14px] font-semibold text-blue-deep hover:underline">
                  {m.cta}
                </Link>
              </div>
            ))}
          </div>
        </Container>
      </section>

      <section className="pb-8">
        <Container>
          <div className="flex flex-col items-start justify-between gap-6 rounded-[28px] bg-ink px-8 py-10 text-white sm:flex-row sm:items-center sm:px-12">
            <div>
              <h2 className="text-[24px] font-semibold tracking-tight">See the whole flow in under a minute</h2>
              <p className="mt-2 max-w-lg text-[14.5px] leading-relaxed text-white/70">
                Buy something from the demo store, watch the payment move through each step, and get a receipt that links to
                the mainnet transactions.
              </p>
            </div>
            <Link
              href="/checkout"
              className="shrink-0 rounded-full bg-[#f4b728] px-6 py-3 text-[15px] font-semibold text-ink transition-colors hover:bg-[#ffc94a]"
            >
              Open the demo store
            </Link>
          </div>
        </Container>
      </section>
    </main>
  );
}
