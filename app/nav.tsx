"use client";
// Primary navigation: Wallet | Payments | Developers | Explore.
// Each section opens a small menu on hover or keyboard focus; the section label
// itself links to the section's overview page. Mobile uses a grouped drawer.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, Menu, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Wordmark, buttonClass } from "./ui";

type Item = { href: string; label: string; note: string };
type Section = { id: string; label: string; href: string; match: string[]; items: Item[] };

export const SECTIONS: Section[] = [
  {
    id: "wallet",
    label: "Wallet",
    href: "/wallet-app",
    match: ["/wallet-app"],
    items: [
      { href: "/wallet-app", label: "ZecOne Wallet", note: "A private Zcash wallet that runs on your computer" },
      { href: "/wallet", label: "Open the local wallet", note: "Needs the ZecOne launcher running on this machine" },
    ],
  },
  {
    id: "payments",
    label: "Payments",
    href: "/payments",
    match: ["/payments", "/checkout", "/dashboard", "/pay/"],
    items: [
      { href: "/payments", label: "ZecOne Pay", note: "Accept shielded ZEC, receive ETH on Base" },
      { href: "/checkout", label: "Demo checkout", note: "Try a simulated purchase end to end" },
      { href: "/dashboard", label: "Merchant dashboard", note: "Sign in with your Base wallet, keys, links, webhooks" },
    ],
  },
  {
    id: "developers",
    label: "Developers",
    href: "/docs",
    match: ["/docs"],
    items: [
      { href: "/docs", label: "Integration guide", note: "Quickstart, SDK, checkout and webhooks" },
      { href: "/docs#embedded", label: "Embedded checkout", note: "<ZecOneCheckout> for React and Next.js" },
      { href: "/docs#reference", label: "API reference", note: "Every endpoint and the scope it needs" },
    ],
  },
  {
    id: "explore",
    label: "Explore",
    href: "/explorer",
    match: ["/explorer", "/security"],
    items: [
      { href: "/explorer", label: "Verify a payment", note: "Check a checkout and the mainnet evidence" },
      { href: "/security", label: "Security and privacy", note: "The trust model, stated plainly" },
    ],
  },
];

export function sectionFor(pathname: string) {
  return SECTIONS.find((s) => s.match.some((m) => (m.endsWith("/") ? pathname.startsWith(m) : pathname === m || pathname.startsWith(`${m}/`))));
}

export default function Nav() {
  const pathname = usePathname() ?? "/";
  const [open, setOpen] = useState(false);
  const active = sectionFor(pathname)?.id;

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="sticky top-0 z-50 border-b border-line bg-canvas/95 backdrop-blur-sm">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:rounded-md focus:bg-forest focus:px-3 focus:py-2 focus:text-ivory">
        Skip to content
      </a>
      <nav aria-label="Primary" className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-6 px-5 sm:px-8">
        <Link href="/" aria-label="ZecOne home" className="shrink-0 rounded-md">
          <Wordmark />
        </Link>

        <ul className="hidden items-center gap-1 md:flex">
          {SECTIONS.map((s) => (
            <li key={s.id} className="group relative">
              <Link
                href={s.href}
                aria-current={active === s.id ? "true" : undefined}
                className={`flex items-center gap-1 rounded-full px-3.5 py-2 text-[15px] font-semibold transition-colors ${
                  active === s.id ? "bg-forest text-ivory" : "text-ink-soft hover:bg-ink/5 hover:text-ink"
                }`}
              >
                {s.label}
                <ChevronDown size={14} aria-hidden="true" className="opacity-60 transition-transform group-focus-within:rotate-180 group-hover:rotate-180" />
              </Link>
              <div className="invisible absolute left-1/2 top-full w-[300px] -translate-x-1/2 pt-2 opacity-0 transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
                <ul className="rounded-[var(--radius-lg)] border border-line bg-surface p-1.5 shadow-float">
                  {s.items.map((it) => (
                    <li key={it.href}>
                      <Link href={it.href} className="block rounded-[10px] px-3 py-2.5 hover:bg-canvas">
                        <span className="block text-[14.5px] font-semibold text-ink">{it.label}</span>
                        <span className="block text-[13px] leading-snug text-muted">{it.note}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            </li>
          ))}
        </ul>

        <div className="hidden md:block">
          <Link href="/dashboard" className={buttonClass("lime", "sm", "border border-forest/15")}>
            Merchant dashboard
          </Link>
        </div>

        <button
          type="button"
          className="grid h-11 w-11 place-items-center rounded-full text-ink hover:bg-ink/5 md:hidden"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          aria-controls="mobile-menu"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <X size={22} /> : <Menu size={22} />}
        </button>
      </nav>

      {open && (
        <div id="mobile-menu" className="max-h-[calc(100dvh-4rem)] overflow-y-auto border-t border-line bg-canvas px-5 pb-6 pt-2 md:hidden">
          {SECTIONS.map((s) => (
            <div key={s.id} className="border-b border-line py-3">
              <Link href={s.href} className={`block py-1.5 font-display text-[18px] font-semibold ${active === s.id ? "text-lime-deep" : "text-ink"}`}>
                {s.label}
              </Link>
              <ul className="mt-1 grid gap-0.5">
                {s.items.map((it) => (
                  <li key={it.href}>
                    <Link href={it.href} className="block rounded-lg py-2 pl-3 text-[15px] text-ink-soft hover:bg-ink/5">
                      {it.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <Link href="/dashboard" className={buttonClass("primary", "md", "mt-5 w-full")}>
            Merchant dashboard
          </Link>
        </div>
      )}
    </header>
  );
}
