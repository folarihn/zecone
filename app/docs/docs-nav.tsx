"use client";
// Documentation sidebar: grouped sections, a local filter, and the section in
// view highlighted as you scroll. On small screens it collapses into a menu.
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Search } from "lucide-react";

export type DocsGroup = { label: string; items: [string, string][] };

export default function DocsNav({ groups }: { groups: DocsGroup[] }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(groups[0]?.items[0]?.[0] ?? "");
  const [open, setOpen] = useState(false);
  const ids = useMemo(() => groups.flatMap((g) => g.items.map(([id]) => id)), [groups]);

  useEffect(() => {
    const els = ids.map((id) => document.getElementById(id)).filter((e): e is HTMLElement => !!e);
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-90px 0px -65% 0px" },
    );
    els.forEach((e) => obs.observe(e));
    return () => obs.disconnect();
  }, [ids]);

  const term = q.trim().toLowerCase();
  const filtered = groups
    .map((g) => ({
      ...g,
      items: g.items.filter(([id, label]) => {
        if (!term) return true;
        if (label.toLowerCase().includes(term)) return true;
        return (document.getElementById(id)?.textContent ?? "").toLowerCase().includes(term);
      }),
    }))
    .filter((g) => g.items.length);
  const current = groups.flatMap((g) => g.items).find(([id]) => id === active)?.[1] ?? "Contents";

  const list = (
    <div className="grid gap-6">
      <div className="relative">
        <Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <label htmlFor="docs-filter" className="sr-only">
          Filter sections
        </label>
        <input
          id="docs-filter"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter sections"
          className="w-full rounded-full border border-line-strong bg-surface py-2 pl-9 pr-3 text-[14.5px] text-ink placeholder:text-muted/80 focus:border-forest focus:outline-none focus:ring-2 focus:ring-lime"
        />
      </div>
      {filtered.length === 0 && <p className="px-3 text-[14px] text-muted">No section mentions “{q}”.</p>}
      {filtered.map((g) => (
        <div key={g.label}>
          <p className="px-3 font-display text-[14px] font-semibold text-ink">{g.label}</p>
          <ul className="mt-1.5 grid gap-0.5 border-l border-line">
            {g.items.map(([id, label]) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  onClick={() => setOpen(false)}
                  aria-current={active === id ? "location" : undefined}
                  className={`-ml-px block border-l-2 py-1.5 pl-3.5 pr-2 text-[15px] transition-colors ${
                    active === id ? "border-forest font-semibold text-ink" : "border-transparent text-muted hover:border-line-strong hover:text-ink"
                  }`}
                >
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );

  return (
    <>
      <nav aria-label="Documentation" className="hidden lg:block">
        <div className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto pb-6 pr-2">{list}</div>
      </nav>
      <nav aria-label="Documentation" className="sticky top-16 z-30 -mx-5 border-b border-line bg-canvas/95 px-5 py-2 backdrop-blur-sm sm:-mx-8 sm:px-8 lg:hidden">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="docs-mobile-nav"
          onClick={() => setOpen((v) => !v)}
          className="flex min-h-11 w-full items-center justify-between rounded-[var(--radius-md)] border border-line-strong bg-surface px-4 text-left text-[15px]"
        >
          <span>
            <span className="text-muted">On this page: </span>
            <span className="font-semibold text-ink">{current}</span>
          </span>
          <ChevronDown size={18} aria-hidden="true" className={`transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        {open && (
          <div id="docs-mobile-nav" className="mt-2 max-h-[65vh] overflow-y-auto rounded-[var(--radius-md)] border border-line bg-surface p-4 shadow-float">
            {list}
          </div>
        )}
      </nav>
    </>
  );
}
