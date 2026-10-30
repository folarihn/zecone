import Link from "next/link";
import { AlertTriangle, CheckCircle2, ChevronRight, Info, Loader2, ShieldAlert } from "lucide-react";

// ZecOne shared component library (server-safe primitives). Interactive pieces
// (tabs, dialog, toast, copy) live in ./components/ui-client.tsx.
// Every value comes from the tokens in globals.css; see design/zecone-design-system.md.

type Children = { children: React.ReactNode };
const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/* ------------------------------------------------------------------ layout */

export function Container({ children, className = "", wide = false }: Children & { className?: string; wide?: boolean }) {
  return <div className={cx("mx-auto w-full px-5 sm:px-8", wide ? "max-w-[1320px]" : "max-w-6xl", className)}>{children}</div>;
}

/** A full-bleed band. `tone="forest"` flips text colours for the dark brand band. */
export function Band({
  children,
  tone = "ivory",
  className = "",
  id,
}: Children & { tone?: "ivory" | "paper" | "forest"; className?: string; id?: string }) {
  const tones = {
    ivory: "bg-canvas text-ink",
    paper: "bg-surface text-ink border-y border-line",
    forest: "zc-dark bg-forest text-ivory",
  };
  return (
    <section id={id} className={cx(tones[tone], "scroll-mt-20", className)}>
      {children}
    </section>
  );
}

/* --------------------------------------------------------------- brand marks */

export function Logo({ size = 28, tone = "light" }: { size?: number; tone?: "light" | "dark" }) {
  const bg = tone === "dark" ? "#d7f276" : "#102820";
  const fg = tone === "dark" ? "#102820" : "#d7f276";
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="9" fill={bg} />
      <path d="M9 9.5h14l-10.6 13H23" fill="none" stroke={fg} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="23.5" cy="9.5" r="2.1" fill="#e8b547" />
    </svg>
  );
}

export function Wordmark({ tone = "light" }: { tone?: "light" | "dark" }) {
  return (
    <span className="flex items-center gap-2.5">
      <Logo tone={tone} />
      <span className={cx("font-display text-[19px] font-semibold tracking-[-0.03em]", tone === "dark" ? "text-ivory" : "text-ink")}>
        ZecOne
      </span>
    </span>
  );
}

// Small inline network glyphs. These are simple lettermarks, not the networks' official logos.
export function ZcashMark({ size = 20 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-grid shrink-0 place-items-center rounded-full bg-gold font-display text-forest"
      style={{ width: size, height: size, fontSize: size * 0.56, fontWeight: 700, lineHeight: 1 }}
    >
      Z
    </span>
  );
}
export function BaseMark({ size = 20 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-grid shrink-0 place-items-center rounded-full bg-blue font-display text-white"
      style={{ width: size, height: size, fontSize: size * 0.54, fontWeight: 700, lineHeight: 1 }}
    >
      E
    </span>
  );
}

/* ---------------------------------------------------------------- headings */

export function Eyebrow({ children, tone = "light" }: Children & { tone?: "light" | "dark" }) {
  return <p className={cx("mb-3 text-[14px] font-semibold", tone === "dark" ? "text-lime" : "text-lime-deep")}>{children}</p>;
}

export function SectionHeading({
  eyebrow,
  title,
  subtitle,
  tone = "light",
  className = "",
}: {
  eyebrow?: string;
  title: string;
  subtitle?: React.ReactNode;
  tone?: "light" | "dark";
  className?: string;
}) {
  return (
    <div className={cx("mb-10 max-w-2xl", className)}>
      {eyebrow && <Eyebrow tone={tone}>{eyebrow}</Eyebrow>}
      <h2 className="zc-h2">{title}</h2>
      {subtitle && <p className={cx("mt-4 text-[17px] leading-relaxed", tone === "dark" ? "text-ivory/75" : "text-muted")}>{subtitle}</p>}
    </div>
  );
}

export type Crumb = { label: string; href?: string };

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-5">
      <ol className="flex flex-wrap items-center gap-1 text-[14px] text-muted">
        {items.map((c, i) => (
          <li key={c.label} className="flex items-center gap-1">
            {i > 0 && <ChevronRight size={14} aria-hidden="true" className="text-sage" />}
            {c.href ? (
              <Link href={c.href} className="rounded px-0.5 hover:text-ink hover:underline underline-offset-4">
                {c.label}
              </Link>
            ) : (
              <span aria-current="page" className="font-medium text-ink">
                {c.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** Page header used by every inner page: breadcrumbs, title, lead and optional actions/aside. */
export function PageHeader({
  crumbs,
  title,
  lead,
  actions,
  aside,
}: {
  crumbs?: Crumb[];
  title: string;
  lead?: React.ReactNode;
  actions?: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <header className="border-b border-line bg-canvas">
      <Container className="pb-10 pt-8 sm:pb-12 sm:pt-10">
        {crumbs && <Breadcrumbs items={crumbs} />}
        <div className={cx("grid gap-8", !!aside && "lg:grid-cols-[1fr_auto] lg:items-end")}>
          <div className="max-w-3xl">
            <h1 className="zc-title text-ink">{title}</h1>
            {lead && <div className="zc-lead mt-4 max-w-2xl text-ink-soft">{lead}</div>}
            {actions && <div className="mt-7 flex flex-wrap gap-3">{actions}</div>}
          </div>
          {aside && <div className="justify-self-start lg:justify-self-end">{aside}</div>}
        </div>
      </Container>
    </header>
  );
}

/* ----------------------------------------------------------------- buttons */

type Variant = "primary" | "secondary" | "ghost" | "lime" | "outline-dark";
const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const BUTTON_SIZE = { md: "min-h-11 px-5 text-[15px]", lg: "min-h-12 px-6 text-[16px]", sm: "min-h-9 px-4 text-[14px]" };
export const BUTTON_VARIANTS: Record<Variant, string> = {
  primary: "bg-forest text-ivory hover:bg-navy",
  secondary: "border border-line-strong bg-surface text-ink hover:border-forest/40",
  ghost: "text-ink hover:bg-ink/5",
  lime: "bg-lime text-forest hover:bg-[#e3f79a]",
  "outline-dark": "border border-ivory/25 text-ivory hover:border-ivory/60 hover:bg-ivory/5",
};

export function buttonClass(variant: Variant = "primary", size: keyof typeof BUTTON_SIZE = "md", className = "") {
  return cx(BUTTON_BASE, BUTTON_SIZE[size], BUTTON_VARIANTS[variant], className);
}

export function ButtonLink({
  href,
  children,
  variant = "primary",
  size = "md",
  className = "",
  external = false,
}: Children & { href: string; variant?: Variant; size?: keyof typeof BUTTON_SIZE; className?: string; external?: boolean }) {
  if (external)
    return (
      <a href={href} target="_blank" rel="noreferrer" className={buttonClass(variant, size, className)}>
        {children}
      </a>
    );
  return (
    <Link href={href} className={buttonClass(variant, size, className)}>
      {children}
    </Link>
  );
}

/* ------------------------------------------------------------ surfaces/cards */

export function Card({ children, className = "", as: Tag = "div" }: Children & { className?: string; as?: "div" | "section" | "article" }) {
  return <Tag className={cx("rounded-[var(--radius-xl)] border border-line bg-surface shadow-card", className)}>{children}</Tag>;
}

export function Panel({ title, description, action, children, className = "" }: Children & { title: string; description?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <Card as="section" className={cx("p-6 sm:p-7", className)}>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="zc-h3 text-ink">{title}</h2>
          {description && <p className="mt-1 text-[14.5px] leading-relaxed text-muted">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </Card>
  );
}

/* ---------------------------------------------------------- status & badges */

export type Tone = "gold" | "blue" | "green" | "amber" | "neutral" | "red" | "lime";
const TONES: Record<Tone, string> = {
  gold: "bg-gold-soft text-gold-deep border-gold/40",
  blue: "bg-blue-soft text-blue-deep border-blue/25",
  green: "bg-green-soft text-green border-green/25",
  amber: "bg-amber-soft text-amber border-amber/25",
  red: "bg-red-soft text-red border-red/25",
  lime: "bg-lime-soft text-lime-deep border-lime-deep/25",
  neutral: "bg-canvas text-ink-soft border-line-strong",
};

export function Pill({ children, tone = "neutral", dot = false }: Children & { tone?: Tone; dot?: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[13px] font-semibold", TONES[tone])}>
      {dot && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

/** Maps a payment lifecycle state to a consistent badge across dashboard, explorer and receipts. */
export function StateBadge({ state }: { state: string }) {
  const map: Record<string, [Tone, string]> = {
    COMPLETED: ["green", "Completed"],
    PAYOUT_CONFIRMED: ["blue", "Payout confirmed"],
    PAYOUT_SUBMITTED: ["blue", "Payout sent"],
    PAYOUT_PENDING: ["blue", "Payout pending"],
    ZEC_CONFIRMED: ["lime", "ZEC confirmed"],
    VERIFYING: ["gold", "Verifying"],
    PAYMENT_DETECTED: ["gold", "Payment detected"],
    AWAITING_PAYMENT: ["neutral", "Awaiting payment"],
    QUOTED: ["neutral", "Quoted"],
    CREATED: ["neutral", "Created"],
    EXPIRED: ["amber", "Expired"],
    CANCELLED: ["amber", "Cancelled"],
    MANUAL_REVIEW: ["amber", "Manual review"],
    FAILED: ["red", "Failed"],
  };
  const [tone, label] = map[state] ?? ["neutral", state.replaceAll("_", " ").toLowerCase()];
  return (
    <Pill tone={tone} dot>
      {label}
    </Pill>
  );
}

/** The three operating modes, always shown the same way. */
export function ModeBadge({ mode }: { mode: "demo" | "monitor" | "live" | "down" | "checking" }) {
  const map = {
    demo: ["neutral", "Simulated demo"],
    monitor: ["gold", "Mainnet monitoring, payout off"],
    live: ["green", "Live settlement"],
    down: ["red", "Payment API offline"],
    checking: ["neutral", "Checking service"],
  } as const;
  const [tone, label] = map[mode];
  return (
    <Pill tone={tone} dot>
      {label}
    </Pill>
  );
}

/* ---------------------------------------------------------------- callouts */

export function Callout({
  tone = "info",
  title,
  children,
  className = "",
}: { children?: React.ReactNode; tone?: "info" | "warning" | "danger" | "success"; title?: string; className?: string }) {
  const map = {
    info: { cls: "border-line-strong bg-surface text-ink-soft", Icon: Info, icon: "text-sage" },
    warning: { cls: "border-gold/50 bg-gold-soft/60 text-ink-soft", Icon: AlertTriangle, icon: "text-gold-deep" },
    danger: { cls: "border-red/30 bg-red-soft text-ink-soft", Icon: ShieldAlert, icon: "text-red" },
    success: { cls: "border-green/25 bg-green-soft text-ink-soft", Icon: CheckCircle2, icon: "text-green" },
  }[tone];
  const { Icon } = map;
  return (
    <div role={tone === "danger" || tone === "warning" ? "note" : undefined} className={cx("flex gap-3 rounded-[var(--radius-lg)] border px-4 py-3.5 text-[15px] leading-relaxed", map.cls, className)}>
      <Icon size={18} aria-hidden="true" className={cx("mt-1 shrink-0", map.icon)} />
      <div className="min-w-0">
        {title && <p className="font-semibold text-ink">{title}</p>}
        {children && <div className={title ? "mt-0.5" : ""}>{children}</div>}
      </div>
    </div>
  );
}

/* --------------------------------------------------------- empty & loading */

export function EmptyState({ title, children, action, icon }: { title: string; children?: React.ReactNode; action?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-[var(--radius-lg)] border border-dashed border-line-strong bg-canvas/60 px-6 py-8">
      {icon && <span className="grid h-10 w-10 place-items-center rounded-full bg-surface text-sage">{icon}</span>}
      <p className="font-display text-[17px] font-semibold text-ink">{title}</p>
      {children && <div className="max-w-md text-[15px] leading-relaxed text-muted">{children}</div>}
      {action}
    </div>
  );
}

export function Spinner({ label, size = 16 }: { label?: string; size?: number }) {
  return (
    <span className="inline-flex items-center gap-2 text-[14px] text-muted" role="status">
      <Loader2 size={size} aria-hidden="true" className="animate-spin" />
      {label ?? <span className="sr-only">Loading</span>}
    </span>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={cx("block animate-pulse rounded-md bg-line/80", className)} />;
}

/* ------------------------------------------------------------------ forms */

export const inputClass =
  "w-full rounded-[var(--radius-md)] border border-line-strong bg-white px-3.5 py-2.5 text-[15px] text-ink placeholder:text-muted/70 transition-colors hover:border-forest/40 focus:border-forest focus:outline-none focus:ring-2 focus:ring-lime";

export function Field({ label, hint, error, children, htmlFor }: Children & { label: string; hint?: React.ReactNode; error?: string; htmlFor?: string }) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={htmlFor} className="text-[14px] font-semibold text-ink">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-[13px] leading-relaxed text-muted">{hint}</p>}
      {error && (
        <p className="text-[13px] font-medium text-red" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- data rows */

export function Hash({ value, head = 10, tail = 8, className = "" }: { value: string; head?: number; tail?: number; className?: string }) {
  const short = value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
  return (
    <span className={cx("font-mono text-[13px] text-ink-soft", className)} title={value}>
      {short}
    </span>
  );
}

/** One on-chain transaction, laid out the same way on the homepage, explorer and receipts. */
export function TxRow({
  chain,
  title,
  meta,
  amount,
  href,
  hash,
}: {
  chain: "zcash" | "base";
  title: string;
  meta: React.ReactNode;
  amount: string;
  href: string;
  hash: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="group grid grid-cols-[auto_1fr] items-start gap-x-4 gap-y-1 px-1 py-4 transition-colors hover:bg-ink/[0.03] sm:grid-cols-[auto_1fr_auto] sm:items-center sm:px-3"
    >
      {chain === "zcash" ? <ZcashMark size={28} /> : <BaseMark size={28} />}
      <span className="min-w-0">
        <span className="block text-[15.5px] font-semibold text-ink">{title}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[13.5px] text-muted">
          {meta}
          <Hash value={hash} />
        </span>
      </span>
      <span className="col-start-2 flex items-center gap-1.5 font-mono text-[14px] font-medium tabular-nums text-ink sm:col-start-3 sm:justify-end">
        {amount}
        <span className="text-[13px] text-muted transition-transform group-hover:translate-x-0.5" aria-hidden="true">
          ↗
        </span>
        <span className="sr-only">(opens block explorer)</span>
      </span>
    </a>
  );
}

/** Definition list used for account details, receipts and evidence. */
export function DataList({ items, className = "" }: { items: [string, React.ReactNode][]; className?: string }) {
  return (
    <dl className={cx("divide-y divide-line", className)}>
      {items.map(([k, v]) => (
        <div key={k} className="grid gap-1 py-3 sm:grid-cols-[180px_1fr] sm:gap-4">
          <dt className="text-[14px] text-muted">{k}</dt>
          <dd className="min-w-0 text-[15px] text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
