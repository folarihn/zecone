import type { Metadata } from "next";
import { Eye, HardDrive, KeyRound, Network, PlugZap, ShieldCheck } from "lucide-react";
import { Band, ButtonLink, Callout, Container, PageHeader, Pill, SectionHeading } from "../ui";

// Public product page for ZecOne Wallet. It does not load or talk to the wallet;
// the runtime wallet stays at /wallet and is served by the local launcher.
export const metadata: Metadata = { title: "ZecOne Wallet: a private Zcash wallet on your computer" };

const NOW = [
  { Icon: HardDrive, t: "Runs on your computer", d: "The ZecOne launcher starts a local gateway and opens the wallet in your own browser. Keys stay on your machine." },
  { Icon: ShieldCheck, t: "Shielded Zcash", d: "Balances and payments use Zcash shielded addresses, so amounts and counterparties stay private on chain." },
  { Icon: Eye, t: "Approve website requests", d: "Websites you connect can ask for a payment or a signature. You see the exact request before you approve it." },
  { Icon: Network, t: "Clear network labels", d: "The wallet always shows which network it is on, so test funds and real funds are never mixed up." },
];

const NEXT = [
  { Icon: KeyRound, t: "Mainnet ZEC", d: "Mainnet wallet support is in development." },
  { Icon: PlugZap, t: "Connected DApps manager", d: "One place to review and revoke every site connection." },
];

export default function WalletApp() {
  return (
    <main>
      <PageHeader
        crumbs={[{ label: "Home", href: "/" }, { label: "Wallet" }]}
        title="ZecOne Wallet"
        lead="A Zcash wallet that keeps your money in the shielded pool and runs on your own computer. It is the same ZecOne you pay merchants with."
        actions={
          <>
            <ButtonLink href="/wallet">Open the local wallet</ButtonLink>
            <ButtonLink href="/payments" variant="secondary">
              Paying merchants with ZecOne Pay
            </ButtonLink>
          </>
        }
      />
      <Band>
        <Container className="py-16">
          <Callout title="The local wallet needs the launcher">
            Open the wallet by running <code className="rounded bg-ink/5 px-1.5 py-0.5 font-mono text-[14px]">Launch-ZecOne.cmd</code> on the
            computer that holds your wallet. The current build runs on testnets.
          </Callout>
          <SectionHeading title="What the wallet does today" className="mb-8 mt-14" />
          <div className="grid gap-px overflow-hidden rounded-[var(--radius-xl)] border border-line bg-line sm:grid-cols-2">
            {NOW.map(({ Icon, t, d }) => (
              <div key={t} className="bg-surface p-6 sm:p-7">
                <Icon size={22} aria-hidden="true" className="text-lime-deep" />
                <h3 className="zc-h3 mt-4 text-ink">{t}</h3>
                <p className="mt-2 text-[15.5px] leading-relaxed text-muted">{d}</p>
              </div>
            ))}
          </div>
        </Container>
      </Band>
      <Band tone="paper">
        <Container className="py-16">
          <SectionHeading title="Coming next" subtitle="These are planned and not available yet." className="mb-8" />
          <div className="grid gap-4 sm:grid-cols-2">
            {NEXT.map(({ Icon, t, d }) => (
              <div key={t} className="rounded-[var(--radius-xl)] border border-dashed border-line-strong bg-canvas p-6">
                <div className="flex items-center justify-between gap-3">
                  <Icon size={22} aria-hidden="true" className="text-sage" />
                  <Pill>Conceptual</Pill>
                </div>
                <h3 className="zc-h3 mt-4 text-ink">{t}</h3>
                <p className="mt-2 text-[15.5px] leading-relaxed text-muted">{d}</p>
              </div>
            ))}
          </div>
        </Container>
      </Band>
    </main>
  );
}
