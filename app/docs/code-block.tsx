"use client";
// Readable code samples: labelled header, language tag, copy button and a small
// dependency-free highlighter (comments, strings, keywords, numbers). It only
// colours text; the code shown is exactly the code copied.
import { CopyButton } from "../components/ui-client";

type Lang = "ts" | "tsx" | "shell" | "html";

const KEYWORDS =
  /\b(import|from|export|const|let|var|function|async|await|return|if|else|try|catch|throw|new|type|interface|default|of|for|in|true|false|null|undefined)\b/;

type Tok = { t: string; c?: string };

function tokenize(code: string, lang: Lang): Tok[] {
  const out: Tok[] = [];
  const comment = lang === "shell" ? /#.*$/m : lang === "html" ? /<!--[\s\S]*?-->|\/\/.*$/m : /\/\/.*$|\/\*[\s\S]*?\*\//m;
  const re = new RegExp(
    [comment.source, /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/.source, KEYWORDS.source, /\b\d[\d_.]*\b/.source].map((s) => `(${s})`).join("|"),
    "gm",
  );
  let last = 0;
  for (const m of code.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ t: code.slice(last, i) });
    const cls = m[1] ? "text-[#9fb3a8] italic" : m[2] ? "text-[#e8c97a]" : m[3] ? "text-lime" : "text-[#f2b38a]";
    out.push({ t: m[0], c: lang === "shell" && m[3] ? undefined : cls });
    last = i + m[0].length;
  }
  if (last < code.length) out.push({ t: code.slice(last) });
  return out;
}

const LABEL: Record<Lang, string> = { ts: "TypeScript", tsx: "TSX", shell: "Shell", html: "HTML" };

export default function CodeBlock({ code, title, lang = "ts" }: { code: string; title?: string; lang?: Lang }) {
  return (
    <figure className="overflow-hidden rounded-[var(--radius-lg)] border border-forest bg-forest">
      <figcaption className="flex items-center justify-between gap-3 border-b border-ivory/10 py-1.5 pl-4 pr-2">
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="truncate text-[14px] font-medium text-ivory/90">{title ?? "Example"}</span>
          <span className="shrink-0 rounded-md bg-ivory/10 px-1.5 py-0.5 font-mono text-[12px] text-ivory/70">{LABEL[lang]}</span>
        </span>
        <CopyButton value={code} tone="dark" label="Copy" />
      </figcaption>
      <pre className="overflow-x-auto px-4 py-4 font-mono text-[13.5px] leading-[1.7] text-ivory/90">
        <code>
          {tokenize(code, lang).map((tok, i) =>
            tok.c ? (
              <span key={i} className={tok.c}>
                {tok.t}
              </span>
            ) : (
              tok.t
            ),
          )}
        </code>
      </pre>
    </figure>
  );
}
