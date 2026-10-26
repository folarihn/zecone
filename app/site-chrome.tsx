"use client";
// Public-site chrome (nav + footer). Hidden on wallet popups, the embeddable
// checkout and when this Next app is served by the local wallet gateway.
// The `.zc-site` wrapper carries site typography so none of it reaches the wallet.
import Link from "next/link";
import { usePathname } from "next/navigation";
import Nav from "./nav";
import { Wordmark } from "./ui";
import { ToastProvider } from "./components/ui-client";

const BARE = ["/connect", "/solana-connect"];

export default function SiteChrome({ children, walletSurface }: { children: React.ReactNode; walletSurface: boolean }) {
  const pathname = usePathname() ?? "/";
  const under = (p: string) => pathname === p || pathname.startsWith(`${p}/`);
  // Wallet popups and the wallet gateway keep exactly their own styling.
  if (walletSurface || BARE.some(under)) return <>{children}</>;
  // Embeddable checkout: no chrome, site typography only.
  if (under("/embed")) return <div className="zc-site">{children}</div>;
  // The local wallet page (/wallet) keeps the site chrome, but its content is not
  // wrapped in the site typography so no style reaches `.wallet-scope`.
  const walletPage = under("/wallet");
  return (
    <ToastProvider>
      <div className="flex min-h-screen flex-col">
        <div className="zc-site">
          <Nav />
        </div>
        <div id="main" className={walletPage ? "flex-1" : "zc-site flex-1"}>
          {children}
        </div>
        <div className="zc-site">
          <Footer />
        </div>
      </div>
    </ToastProvider>
  );
}

const COLS: { h: string; links: [string, string][] }[] = [
  { h: "Wallet", links: [["ZecOne Wallet", "/wallet-app"], ["Open the local wallet", "/wallet"]] },
  { h: "Payments", links: [["ZecOne Pay", "/payments"], ["Demo checkout", "/checkout"], ["Merchant dashboard", "/dashboard"]] },
  { h: "Developers", links: [["Quickstart", "/docs#quickstart"], ["Embedded checkout", "/docs#embedded"], ["Webhooks", "/docs#webhooks"], ["API reference", "/docs#reference"]] },
  { h: "Explore", links: [["Verify a payment", "/explorer"], ["Mainnet evidence", "/explorer#evidence"], ["Security and privacy", "/security"]] },
];

function Footer() {
  return (
    <footer className="zc-dark bg-forest text-ivory">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 sm:px-8 lg:grid-cols-[1.3fr_repeat(4,1fr)]">
        <div>
          <Link href="/" aria-label="ZecOne home" className="inline-block rounded-md">
            <Wordmark tone="dark" />
          </Link>
          <p className="mt-4 max-w-xs text-[14.5px] leading-relaxed text-ivory/70">
            A private Zcash wallet and a payment platform. Shielded ZEC in, ETH on Base out.
          </p>
        </div>
        {COLS.map((col) => (
          <div key={col.h}>
            <h2 className="font-display text-[15px] font-semibold text-ivory">{col.h}</h2>
            <ul className="mt-3 space-y-2">
              {col.links.map(([label, href]) => (
                <li key={label}>
                  <Link href={href} className="text-[14.5px] text-ivory/70 transition-colors hover:text-lime">
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-ivory/10">
        <p className="mx-auto max-w-6xl px-5 py-6 text-[13.5px] leading-relaxed text-ivory/60 sm:px-8">
          ZecOne is in development beta. Demo checkouts are simulated, and live Base payouts and Zcash broadcasts are disabled in
          this build. The Zcash payment is shielded; the Base payout is public, and the ZecOne operator can link the two. ZecOne is
          a trusted relayer, not a trustless bridge.
        </p>
      </div>
    </footer>
  );
}
