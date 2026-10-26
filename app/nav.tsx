"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { useState } from "react";

const LINKS = [
  { href: "/checkout", label: "Try checkout" },
  { href: "/docs", label: "Developers" },
  { href: "/explorer", label: "Verify" },
  { href: "/security", label: "Security" },
  { href: "/wallet", label: "Wallet" },
];

export default function Nav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <header className="sticky top-0 z-50 border-b border-line/80 bg-canvas/85 backdrop-blur-md">
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
        <Link href="/" className="flex items-center gap-2.5" onClick={() => setOpen(false)}>
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-ink text-[15px] font-bold text-white">
            Z
          </span>
          <span className="text-[17px] font-semibold tracking-tight text-ink">
            ZecOne<span className="text-gold">.</span>
          </span>
        </Link>

        <div className="hidden items-center gap-1 md:flex">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`rounded-full px-3.5 py-2 text-[13.5px] font-medium transition-colors ${
                isActive(l.href) ? "bg-surface text-ink shadow-sm" : "text-ink-soft hover:text-ink"
              }`}
            >
              {l.label}
            </Link>
          ))}
          <Link
            href="/dashboard"
            className="ml-2 rounded-full bg-ink px-4 py-2 text-[13.5px] font-semibold text-white transition-colors hover:bg-navy"
          >
            Merchant dashboard
          </Link>
        </div>

        <button
          className="grid h-10 w-10 place-items-center rounded-lg text-ink md:hidden"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <X size={22} /> : <Menu size={22} />}
        </button>
      </nav>

      {open && (
        <div className="border-t border-line bg-canvas px-5 py-3 md:hidden">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className={`block rounded-lg px-3 py-2.5 text-[15px] font-medium ${
                isActive(l.href) ? "bg-surface text-ink" : "text-ink-soft"
              }`}
            >
              {l.label}
            </Link>
          ))}
          <Link
            href="/dashboard"
            onClick={() => setOpen(false)}
            className="mt-2 block rounded-lg bg-ink px-3 py-2.5 text-center text-[15px] font-semibold text-white"
          >
            Merchant dashboard
          </Link>
        </div>
      )}
    </header>
  );
}
