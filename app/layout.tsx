import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "ZecOne — Your local wallet",
  description: "A local testnet wallet for shielded Zcash and Base Sepolia.",
  robots: { index: false, follow: false },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
