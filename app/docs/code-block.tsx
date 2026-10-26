"use client";
import { useState } from "react";
import { Check, Copy } from "lucide-react";

export default function CodeBlock({ code, title }: { code: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="overflow-hidden rounded-2xl border border-ink/10 bg-ink">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
        <span className="font-mono text-[12px] text-white/60">{title ?? ""}</span>
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(code).catch(() => undefined);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
          className="inline-flex items-center gap-1.5 text-[12px] font-medium text-white/70 hover:text-white"
          aria-label={`Copy ${title ?? "code"}`}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 text-[12.5px] leading-relaxed text-white/90">
        <code>{code}</code>
      </pre>
    </div>
  );
}
