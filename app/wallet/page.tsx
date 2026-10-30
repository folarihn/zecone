import Wallet from "../wallet";
import { ExternalLink, HardDrive, KeyRound, ShieldCheck } from "lucide-react";
import { Band, ButtonLink, Callout, Container, PageHeader, Panel } from "../ui";

export const dynamic = "force-dynamic";

export default function Page() {
  // The authenticated wallet API is deliberately bound to loopback. Rendering
  // the runtime wallet on a public origin would leave its pairing UI talking to
  // nonexistent cloud /api routes and could encourage users to enter a local
  // pairing capability on the wrong origin.
  if (process.env.ZECONE_SURFACE !== "wallet") return <LocalWalletHandoff />;
  return (
    <div className="wallet-scope" data-theme="zecone">
      <Wallet />
    </div>
  );
}

function LocalWalletHandoff() {
  return (
    <main className="zc-site">
      <PageHeader
        crumbs={[{ label: "Home", href: "/" }, { label: "Wallet" }]}
        title="Open ZecOne on this computer"
        lead="Verified Mainnet receiving, balance, history and sync views run in the local wallet on your Windows PC. This public page is only a secure handoff: it never receives your seed, keystore passphrase, pairing code, balance, history or wallet database."
        actions={
          <ButtonLink href="http://127.0.0.1:3210" external>
            Open local wallet <ExternalLink size={17} aria-hidden="true" />
          </ButtonLink>
        }
      />
      <Band>
        <Container className="grid gap-6 py-14 lg:grid-cols-[1.05fr_0.95fr]">
          <Panel
            title="Start the trusted local gateway"
            description="Do this on the Windows computer that already holds your ZecOne wallet."
          >
            <ol className="grid gap-5 text-[15.5px] leading-relaxed text-ink-soft">
              <li className="flex gap-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-forest font-mono text-[13px] font-semibold text-lime">
                  1
                </span>
                <span>
                  Open the ZecOne project folder and double-click{" "}
                  <code className="rounded bg-ink/5 px-1.5 py-0.5 font-mono text-[14px]">
                    Launch-ZecOne.cmd
                  </code>
                  .
                </span>
              </li>
              <li className="flex gap-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-forest font-mono text-[13px] font-semibold text-lime">
                  2
                </span>
                <span>
                  Wait for the launcher to open{" "}
                  <code className="rounded bg-ink/5 px-1.5 py-0.5 font-mono text-[14px]">
                    127.0.0.1:3210
                  </code>
                  . Check that exact loopback address before entering a pairing
                  code.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-forest font-mono text-[13px] font-semibold text-lime">
                  3
                </span>
                <span>
                  Select Mainnet only for the verified read-only wallet view.
                  Mainnet signing and broadcasting remain operator-gated and
                  unavailable from this public website.
                </span>
              </li>
            </ol>
          </Panel>
          <div className="grid gap-4">
            <Callout
              tone="warning"
              title="Never paste a pairing code on zecone.xyz"
            >
              Pairing capabilities are accepted only by the local gateway at{" "}
              <strong>127.0.0.1:3210</strong>. The public site does not proxy
              wallet sessions.
            </Callout>
            <div className="grid gap-px overflow-hidden rounded-[var(--radius-xl)] border border-line bg-line sm:grid-cols-3 lg:grid-cols-1">
              {[
                [
                  HardDrive,
                  "Keys stay local",
                  "No seed, keystore or wallet database is uploaded.",
                ],
                [
                  KeyRound,
                  "Pairing stays local",
                  "One-time capabilities are exchanged only on loopback.",
                ],
                [
                  ShieldCheck,
                  "Approvals stay exact",
                  "Signing and broadcast remain separate operator actions.",
                ],
              ].map(([Icon, title, description]) => {
                const I = Icon as typeof HardDrive;
                return (
                  <div key={title as string} className="bg-surface p-5">
                    <I
                      size={20}
                      aria-hidden="true"
                      className="text-lime-deep"
                    />
                    <p className="mt-3 font-semibold text-ink">
                      {title as string}
                    </p>
                    <p className="mt-1 text-[14px] leading-relaxed text-muted">
                      {description as string}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </Container>
      </Band>
    </main>
  );
}
