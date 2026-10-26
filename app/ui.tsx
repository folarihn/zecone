import Link from "next/link";

// Shared primitives for the ZecOne marketing site (light theme).

export function Container({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-6xl px-5 sm:px-8 ${className}`}>{children}</div>;
}

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 text-[13.5px] font-semibold text-gold-deep">{children}</p>
  );
}

export function Pill({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "gold" | "blue" | "green" | "amber" | "neutral" | "red";
}) {
  const tones: Record<string, string> = {
    gold: "bg-gold-soft text-gold-deep border-gold/20",
    blue: "bg-blue-soft text-blue-deep border-blue/20",
    green: "bg-green-soft text-green border-green/20",
    amber: "bg-amber-soft text-amber border-amber/20",
    red: "bg-red-soft text-red border-red/20",
    neutral: "bg-canvas text-ink-soft border-line",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold tracking-wide ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-line bg-surface shadow-card ${className}`}>{children}</div>
  );
}

export function ButtonLink({
  href,
  children,
  variant = "primary",
  className = "",
}: {
  href: string;
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  className?: string;
}) {
  const styles: Record<string, string> = {
    primary: "bg-ink text-white hover:bg-navy",
    secondary: "border border-line-strong bg-surface text-ink hover:border-ink/30 hover:bg-canvas",
    ghost: "text-ink hover:bg-canvas",
  };
  return (
    <Link
      href={href}
      className={`inline-flex items-center justify-center gap-2 rounded-full px-6 py-3 text-[15px] font-semibold transition-colors ${styles[variant]} ${className}`}
    >
      {children}
    </Link>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="mb-8">
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <h2 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">{title}</h2>
      {subtitle && <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">{subtitle}</p>}
    </div>
  );
}

// Small inline network glyphs used across the site. These are simple lettermarks,
// not the networks' official logos.
export function ZcashMark({ size = 20 }: { size?: number }) {
  return (
    <span
      className="inline-grid place-items-center rounded-full bg-gold-soft font-serif text-gold-deep"
      style={{ width: size, height: size, fontSize: size * 0.62, fontWeight: 700 }}
    >
      Z
    </span>
  );
}
export function BaseMark({ size = 20 }: { size?: number }) {
  return (
    <span
      className="inline-grid place-items-center rounded-full bg-blue-soft font-semibold text-blue-deep"
      style={{ width: size, height: size, fontSize: size * 0.58, lineHeight: 1 }}
    >
      E
    </span>
  );
}
