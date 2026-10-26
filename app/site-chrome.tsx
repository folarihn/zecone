"use client";
// Marketing chrome (nav + footer). Hidden on wallet popups, the embeddable
// checkout and when this Next app is served by the local wallet gateway.
import { usePathname } from "next/navigation";
import Nav from "./nav";

const BARE = ["/connect", "/solana-connect", "/embed"];

export default function SiteChrome({ children, walletSurface }: { children: React.ReactNode; walletSurface: boolean }) {
  const pathname = usePathname() ?? "/";
  const bare = walletSurface || BARE.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (bare) return <>{children}</>;
  return (
    <>
      <Nav />
      {children}
      <Footer />
    </>
  );
}

function Footer() {
  const cols: { h: string; links: [string, string][] }[] = [
    { h: "Product", links: [["Try checkout", "/checkout"], ["Merchant dashboard", "/dashboard"], ["Verify a payment", "/explorer"]] },
    { h: "Developers", links: [["Quickstart", "/docs#quickstart"], ["Embedded checkout", "/docs#embedded"], ["Webhooks", "/docs#webhooks"]] },
    { h: "Trust", links: [["Security & privacy", "/security"], ["Local wallet", "/wallet"]] },
  ];
  return (
    <footer className="mt-24 border-t border-line bg-surface">
      <div className="mx-auto grid max-w-6xl gap-8 px-5 py-12 sm:grid-cols-2 sm:px-8 lg:grid-cols-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="grid h-6 w-6 place-items-center rounded-md bg-ink text-[13px] font-bold text-white">Z</span>
            <span className="text-[15px] font-semibold text-ink">ZecOne</span>
          </div>
          <p className="mt-3 max-w-xs text-[13px] leading-relaxed text-muted">
            Customers pay with shielded Zcash. Merchants receive ETH on Base.
          </p>
        </div>
        {cols.map((col) => (
          <div key={col.h}>
            <div className="text-[13px] font-semibold text-ink">{col.h}</div>
            <ul className="mt-3 space-y-2">
              {col.links.map(([label, href]) => (
                <li key={label}>
                  <a href={href} className="text-[13px] text-muted transition-colors hover:text-ink">
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-line px-5 py-5 sm:px-8">
        <p className="mx-auto max-w-6xl text-[12px] leading-relaxed text-muted">
          ZecOne is in development beta and runs in demo mode: live Base payouts and Zcash broadcasts are disabled. The
          Zcash payment is shielded; the Base payout is public, and the ZecOne operator can link the two. Not a trustless bridge.
        </p>
      </div>
    </footer>
  );
}
