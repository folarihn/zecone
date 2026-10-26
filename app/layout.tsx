import type { Metadata } from "next";
import "./globals.css";
import SiteChrome from "./site-chrome";

export const metadata: Metadata = {
  title: "ZecOne — Shielded ZEC in, ETH on Base out",
  description: "Accept shielded Zcash payments and settle ETH on Base. Hosted checkout, embeddable checkout, SDK and signed webhooks.",
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  // The local wallet gateway sets ZECONE_SURFACE=wallet and serves the wallet at "/".
  const walletSurface = process.env.ZECONE_SURFACE === "wallet";
  return (
    <html lang="en">
      <body className="min-h-screen bg-canvas text-ink antialiased">
        <SiteChrome walletSurface={walletSurface}>{children}</SiteChrome>
      </body>
    </html>
  );
}
