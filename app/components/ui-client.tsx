"use client";
// Interactive parts of the ZecOne component library: tabs, dialog, toast and copy.
// No animation library: motion is CSS only and respects prefers-reduced-motion.
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { Check, Copy, X } from "lucide-react";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/* -------------------------------------------------------------------- copy */

export function CopyButton({ value, label = "Copy", className = "", tone = "light" }: { value: string; label?: string; className?: string; tone?: "light" | "dark" }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard unavailable (insecure context); the value stays selectable */
        }
      }}
      className={cx(
        "inline-flex min-h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold transition-colors",
        tone === "dark" ? "text-ivory/80 hover:bg-ivory/10 hover:text-ivory" : "text-ink-soft hover:bg-ink/5 hover:text-ink",
        className,
      )}
      aria-label={done ? "Copied" : `${label}`}
    >
      {done ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      <span aria-live="polite">{done ? "Copied" : label}</span>
    </button>
  );
}

/* -------------------------------------------------------------------- tabs */

export function Tabs({
  tabs,
  label,
  initial,
}: {
  tabs: { id: string; label: string; content: React.ReactNode }[];
  label: string;
  initial?: string;
}) {
  const base = useId();
  const [active, setActive] = useState(initial ?? tabs[0]?.id);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const n = tabs.length;
    const next = e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setActive(tabs[next].id);
    refs.current[next]?.focus();
  };
  return (
    <div>
      <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b border-line">
        {tabs.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="tab"
            id={`${base}-tab-${t.id}`}
            aria-controls={`${base}-panel-${t.id}`}
            aria-selected={active === t.id}
            tabIndex={active === t.id ? 0 : -1}
            onClick={() => setActive(t.id)}
            onKeyDown={(e) => onKey(e, i)}
            className={cx(
              "-mb-px whitespace-nowrap border-b-2 px-3.5 py-2.5 text-[14.5px] font-semibold transition-colors",
              active === t.id ? "border-forest text-ink" : "border-transparent text-muted hover:text-ink",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`${base}-panel-${t.id}`}
          aria-labelledby={`${base}-tab-${t.id}`}
          hidden={active !== t.id}
          className="pt-5"
        >
          {t.content}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ dialog */

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={onClose}
      className="m-auto w-[min(92vw,520px)] rounded-[var(--radius-xl)] border border-line bg-surface p-0 text-ink shadow-float backdrop:bg-forest/50"
    >
      <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
        <h2 id={titleId} className="zc-h3">
          {title}
        </h2>
        <button type="button" onClick={onClose} aria-label="Close dialog" className="grid h-9 w-9 place-items-center rounded-full text-muted hover:bg-ink/5 hover:text-ink">
          <X size={18} />
        </button>
      </div>
      <div className="px-6 py-5 text-[15px] leading-relaxed text-ink-soft">{children}</div>
      {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-6 py-4">{footer}</div>}
    </dialog>
  );
}

/* ------------------------------------------------------------------- toast */

type Toast = { id: number; tone: "success" | "error" | "info"; text: string };
const ToastCtx = createContext<(tone: Toast["tone"], text: string) => void>(() => {});

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast["tone"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col items-end gap-2 sm:left-auto sm:right-6">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            className={cx(
              "animate-rise pointer-events-auto flex max-w-sm items-start gap-2.5 rounded-[var(--radius-md)] border px-4 py-3 text-[14.5px] shadow-float",
              t.tone === "success" && "border-forest bg-forest text-ivory",
              t.tone === "error" && "border-red/30 bg-red-soft text-ink",
              t.tone === "info" && "border-line bg-surface text-ink",
            )}
          >
            {t.tone === "success" && <Check size={16} className="mt-0.5 shrink-0 text-lime" aria-hidden="true" />}
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);
