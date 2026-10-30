import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import SiteChrome from "./site-chrome";

// Fonts are bundled in app/fonts (SIL OFL 1.1, see app/fonts/LICENSE.txt), so the
// site never depends on a third-party font host at build or run time.
const heading = localFont({
  src: "./fonts/space-grotesk-latin-wght-normal.woff2",
  variable: "--font-heading",
  weight: "300 700",
  display: "swap",
});
const body = localFont({
  src: "./fonts/manrope-latin-wght-normal.woff2",
  variable: "--font-body",
  weight: "200 800",
  display: "swap",
});
const code = localFont({
  src: [
    { path: "./fonts/ibm-plex-mono-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-mono-latin-500-normal.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-code",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ZecOne: shielded Zcash wallet and payments",
  description:
    "ZecOne is a private Zcash wallet and a payment platform. Accept shielded ZEC and receive ETH on Base through hosted checkout, an embeddable component, the SDK and signed webhooks.",
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  // The local wallet gateway sets ZECONE_SURFACE=wallet and serves the wallet at "/".
  const walletSurface = process.env.ZECONE_SURFACE === "wallet";
  return (
    <html lang="en" className={`${heading.variable} ${body.variable} ${code.variable}`}>
      <body className="min-h-screen bg-canvas text-ink antialiased">
        <SiteChrome walletSurface={walletSurface}>{children}</SiteChrome>
      </body>
    </html>
  );
}
