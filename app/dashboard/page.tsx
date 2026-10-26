"use client";
// Merchant dashboard. Sign-in is an EIP-4361 signature from the payout wallet;
// the resulting session lives in an httpOnly cookie scoped to /api/merchant.
// The API key is displayed once (on registration or rotation) for the merchant
// to copy into their own server environment — it is never stored in the browser.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, ExternalLink, Loader2, LogOut, RefreshCw, Wallet } from "lucide-react";
import { qrSvg } from "../../sdk/src/checkout.ts";
import { BASE_MAINNET, BASE_SEPOLIA, chainLabel, friendly, useBaseWallet } from "../lib/use-base-wallet";
import { Container, Pill } from "../ui";

type Merchant = {
  id: string;
  name: string;
  payoutAddress: string | null;
  payoutVerification: string | null;
  ownerAddress: string | null;
  webhookUrl: string | null;
  apiKeys: { keyId: string; createdAt: number; active: boolean }[];
};
type PaymentRow = {
  id: string;
  state: string;
  mode: string;
  request: { amountUsd: string };
  description: string | null;
  quote: { zecAmount: string } | null;
  checkoutUrl: string;
  checkoutToken: string;
  payoutTxHash: string | null;
  createdAt: number;
  evidenceKind: string | null;
};
type Delivery = { id: number; eventType: string; status: string; attempts: number; lastStatus: number | null; createdAt: number };

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/merchant/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message ?? `Request failed (${res.status})`) as Error & { status?: number; code?: string };
    err.status = res.status;
    err.code = data.error?.code;
    throw err;
  }
  return data as T;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const tone = (s: string) =>
  s === "COMPLETED" ? "green" : s === "EXPIRED" || s === "FAILED" ? "red" : s === "MANUAL_REVIEW" ? "amber" : "blue";

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(value).catch(() => undefined);
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink hover:border-ink/30"
    >
      {done ? <Check size={13} /> : <Copy size={13} />} {done ? "Copied" : label}
    </button>
  );
}

export default function Dashboard() {
  const wallet = useBaseWallet();
  const [merchant, setMerchant] = useState<Merchant | null>(null);
  const [checking, setChecking] = useState(true);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMe = useCallback(async () => {
    try {
      const r = await api<{ merchant: Merchant }>("me");
      setMerchant(r.merchant);
    } catch {
      setMerchant(null);
    } finally {
      setChecking(false);
    }
  }, []);
  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  async function signIn() {
    setError(null);
    setSigning(true);
    try {
      const address = wallet.address ?? (await wallet.connect());
      if (!address) return;
      let chainId = wallet.chainId;
      if (chainId !== BASE_MAINNET && chainId !== BASE_SEPOLIA) {
        const ok = await wallet.switchTo(BASE_MAINNET);
        if (!ok) throw new Error("Switch your wallet to Base to continue.");
        chainId = BASE_MAINNET;
      }
      const { challenge } = await api<{ challenge: { message: string } }>("challenge", {
        address,
        chainId: chainId ?? BASE_MAINNET,
        purpose: "register",
      });
      const signature = await wallet.signMessage(challenge.message, address);
      const r = await api<{ merchant: Merchant; apiKey: string | null }>("verify", {
        message: challenge.message,
        signature,
        name: name.trim() || undefined,
      });
      setMerchant(r.merchant);
      setApiKey(r.apiKey);
    } catch (e) {
      setError(friendly(e));
    } finally {
      setSigning(false);
    }
  }

  async function signOut() {
    await api("logout", {}).catch(() => undefined);
    setMerchant(null);
    setApiKey(null);
    wallet.disconnect();
  }

  return (
    <main>
      <Container className="py-12 sm:py-16">
        {checking ? (
          <div className="flex items-center gap-2 text-[14px] text-muted">
            <Loader2 size={16} className="animate-spin" /> Loading your dashboard…
          </div>
        ) : merchant ? (
          <SignedIn merchant={merchant} apiKey={apiKey} onKey={setApiKey} onChange={loadMe} onSignOut={signOut} />
        ) : (
          <div className="grid gap-12 lg:grid-cols-[1fr_0.9fr]">
            <div>
              <h1 className="text-[40px] font-semibold tracking-tight text-ink sm:text-[48px]">Accept shielded ZEC</h1>
              <p className="mt-3 max-w-lg text-[16px] leading-relaxed text-muted">
                Sign in with the Base wallet that should receive your payouts. The signature proves you control that
                address — it is not a transaction and costs no gas.
              </p>
              <ol className="mt-8 space-y-5">
                {[
                  ["Connect your Base wallet", "Coinbase Wallet, MetaMask or any EVM wallet in this browser."],
                  ["Sign the ownership message", "ZecOne verifies the signature server-side before creating your account."],
                  ["Copy your API key", "Shown once. Put it in your server's environment as ZECONE_API_KEY."],
                ].map(([t, d], i) => (
                  <li key={t} className="flex gap-4">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-ink text-[13px] font-semibold text-white">
                      {i + 1}
                    </span>
                    <span>
                      <span className="block text-[15px] font-semibold text-ink">{t}</span>
                      <span className="block text-[14px] text-muted">{d}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
            <div className="rounded-3xl border border-line bg-surface p-6 shadow-card sm:p-8">
              <h2 className="text-[18px] font-semibold text-ink">Sign in or create a merchant account</h2>
              <label className="mt-5 block text-[13px] font-medium text-ink" htmlFor="merchant-name">
                Business name <span className="font-normal text-muted">(new accounts)</span>
              </label>
              <input
                id="merchant-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                placeholder="e.g. Pixel Pass"
                className="mt-1.5 w-full rounded-xl border border-line bg-canvas px-4 py-3 text-[15px] text-ink outline-none focus:border-ink/40"
              />
              <div className="mt-5 rounded-2xl border border-line bg-canvas p-4 text-[13.5px]">
                {wallet.address ? (
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-ink">{short(wallet.address)}</span>
                    <span className={wallet.onBase ? "text-green" : "text-amber"}>{chainLabel(wallet.chainId)}</span>
                  </div>
                ) : (
                  <span className="text-muted">{wallet.available ? "No wallet connected yet." : "No browser wallet detected."}</span>
                )}
              </div>
              {wallet.address && !wallet.onBase && (
                <button
                  type="button"
                  onClick={() => void wallet.switchTo(BASE_MAINNET)}
                  className="mt-3 w-full rounded-full border border-line-strong py-2.5 text-[14px] font-semibold text-ink hover:bg-canvas"
                >
                  Switch to Base
                </button>
              )}
              <button
                type="button"
                onClick={signIn}
                disabled={signing}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-full bg-ink py-3.5 text-[15px] font-semibold text-white hover:bg-navy disabled:opacity-60"
              >
                {signing ? <Loader2 size={16} className="animate-spin" /> : <Wallet size={16} />}
                {signing ? "Waiting for your wallet…" : wallet.address ? "Sign in with this wallet" : "Connect wallet and sign in"}
              </button>
              {(error || wallet.error) && (
                <p className="mt-3 text-[13px] text-red" role="alert">
                  {error ?? wallet.error}
                </p>
              )}
              <p className="mt-5 text-[12.5px] leading-relaxed text-muted">
                Your payout address can only be changed by signing again from the new address. ZecOne never asks for
                token approvals or transactions here.
              </p>
            </div>
          </div>
        )}
      </Container>
    </main>
  );
}

function SignedIn({
  merchant,
  apiKey,
  onKey,
  onChange,
  onSignOut,
}: {
  merchant: Merchant;
  apiKey: string | null;
  onKey: (k: string | null) => void;
  onChange: () => void;
  onSignOut: () => void;
}) {
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api<{ payments: PaymentRow[] }>("payments?limit=25");
      setPayments(r.payments);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  const counts = useMemo(() => {
    const c = { completed: 0, open: 0, total: payments.length };
    for (const p of payments) {
      if (p.state === "COMPLETED") c.completed++;
      else if (!["EXPIRED", "FAILED"].includes(p.state)) c.open++;
    }
    return c;
  }, [payments]);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Pill tone="amber">Demo mode · live payouts off</Pill>
          <h1 className="mt-3 text-[36px] font-semibold tracking-tight text-ink">{merchant.name}</h1>
          <p className="mt-1 text-[14px] text-muted">
            Payouts go to <span className="font-mono text-ink">{merchant.payoutAddress ? short(merchant.payoutAddress) : "—"}</span>
            {merchant.payoutVerification === "siwe" ? " · verified by wallet signature" : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={onSignOut}
          className="inline-flex items-center gap-2 rounded-full border border-line-strong px-4 py-2 text-[13.5px] font-medium text-ink hover:bg-surface"
        >
          <LogOut size={14} /> Sign out
        </button>
      </div>

      {apiKey && (
        <div className="mt-6 rounded-2xl border border-gold/30 bg-gold-soft p-5" role="status">
          <div className="text-[15px] font-semibold text-ink">Your secret API key — shown once</div>
          <p className="mt-1 text-[13.5px] text-ink-soft">
            Store it on your server (for example <code>ZECONE_API_KEY</code>). Never put it in browser code. You can rotate it
            below.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-lg bg-surface px-3 py-2 font-mono text-[12.5px] text-ink" data-testid="api-key">
              {apiKey}
            </code>
            <CopyButton value={apiKey} />
            <button type="button" onClick={() => onKey(null)} className="text-[13px] font-medium text-ink-soft hover:text-ink">
              I&apos;ve stored it
            </button>
          </div>
        </div>
      )}

      <dl className="mt-8 grid grid-cols-3 divide-x divide-line rounded-2xl border border-line bg-surface">
        {[
          ["Completed", counts.completed],
          ["Open", counts.open],
          ["Recent requests", counts.total],
        ].map(([l, n]) => (
          <div key={l as string} className="px-5 py-4">
            <dt className="text-[12.5px] text-muted">{l}</dt>
            <dd className="mt-1 text-[26px] font-semibold tabular-nums text-ink">{n}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-8 grid items-start gap-8 lg:grid-cols-[0.9fr_1.1fr]">
        <PaymentLinkForm onCreated={refresh} />
        <section className="overflow-hidden rounded-3xl border border-line bg-surface shadow-card">
          <div className="flex items-center justify-between border-b border-line px-5 py-4">
            <h2 className="text-[16px] font-semibold text-ink">Payments</h2>
            <button type="button" onClick={refresh} className="text-muted hover:text-ink" aria-label="Refresh payments">
              <RefreshCw size={15} />
            </button>
          </div>
          {loadError ? (
            <p className="px-5 py-8 text-[13.5px] text-red">{loadError}</p>
          ) : payments.length === 0 ? (
            <p className="px-5 py-10 text-center text-[14px] text-muted">
              No payments yet. Create a payment link, or call <code className="text-ink">payments.create</code> from your
              server.
            </p>
          ) : (
            <ul className="divide-y divide-line" data-testid="payments">
              {payments.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-5 py-3.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-medium text-ink">
                      ${p.request.amountUsd}
                      <span className="font-normal text-muted"> · {p.description ?? "Payment"}</span>
                    </div>
                    <div className="truncate font-mono text-[11.5px] text-muted">
                      {p.id} · {new Date(p.createdAt * 1000).toLocaleString()}
                    </div>
                  </div>
                  <Pill tone={tone(p.state) as "green"}>{p.state.replaceAll("_", " ").toLowerCase()}</Pill>
                  <a
                    href={`/pay/${p.id}?t=${p.checkoutToken}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-muted hover:text-ink"
                    aria-label={`Open checkout for ${p.id}`}
                  >
                    <ExternalLink size={15} />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <DeveloperSettings merchant={merchant} onKey={onKey} onChange={onChange} />
    </div>
  );
}

function PaymentLinkForm({ onCreated }: { onCreated: () => void }) {
  const [amount, setAmount] = useState("10.00");
  const [description, setDescription] = useState("");
  const [created, setCreated] = useState<PaymentRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const link = created ? `${window.location.origin}/pay/${created.id}?t=${created.checkoutToken}` : null;
  const qr = useMemo(() => (link ? qrSvg(link) : null), [link]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ payment: PaymentRow }>("payments", { amountUsd: amount, description: description || undefined });
      setCreated(r.payment);
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-3xl border border-line bg-surface p-6 shadow-card">
      <h2 className="text-[16px] font-semibold text-ink">Create a payment link</h2>
      <p className="mt-1 text-[13.5px] text-muted">Share it with a customer; it shows a QR code and live status.</p>
      <div className="mt-4 grid grid-cols-[0.8fr_1.2fr] gap-3">
        <label className="text-[12.5px] font-medium text-ink">
          Amount (USD)
          <input
            value={amount}
            inputMode="decimal"
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
            className="mt-1 w-full rounded-xl border border-line bg-canvas px-3 py-2.5 text-[15px] font-semibold text-ink outline-none focus:border-ink/40"
          />
        </label>
        <label className="text-[12.5px] font-medium text-ink">
          What it&apos;s for
          <input
            value={description}
            maxLength={200}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Invoice #1042"
            className="mt-1 w-full rounded-xl border border-line bg-canvas px-3 py-2.5 text-[15px] text-ink outline-none focus:border-ink/40"
          />
        </label>
      </div>
      <button
        type="button"
        onClick={create}
        disabled={busy}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-full bg-ink py-3 text-[14.5px] font-semibold text-white hover:bg-navy disabled:opacity-60"
      >
        {busy && <Loader2 size={15} className="animate-spin" />} Create link
      </button>
      {error && (
        <p className="mt-3 text-[13px] text-red" role="alert">
          {error}
        </p>
      )}
      {created && link && qr && (
        <div className="mt-5 flex gap-4 rounded-2xl border border-line bg-canvas p-4">
          <svg viewBox={`0 0 ${qr.size} ${qr.size}`} width={104} height={104} className="shrink-0 rounded-lg bg-white" shapeRendering="crispEdges" role="img" aria-label="QR code for the payment link">
            <path d={qr.path} fill="#0f1b2d" />
          </svg>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-ink">
              ${created.request.amountUsd} · {created.quote?.zecAmount} ZEC
            </div>
            <div className="mt-1 break-all font-mono text-[11.5px] text-muted" data-testid="payment-link">
              {link}
            </div>
            <div className="mt-2 flex gap-2">
              <CopyButton value={link} label="Copy link" />
              <a href={link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12.5px] font-medium text-blue-deep hover:underline">
                Open <ExternalLink size={12} />
              </a>
            </div>
            <p className="mt-2 text-[12px] text-muted">Expires 15 minutes after creation if unpaid.</p>
          </div>
        </div>
      )}
    </section>
  );
}

function DeveloperSettings({ merchant, onKey, onChange }: { merchant: Merchant; onKey: (k: string) => void; onChange: () => void }) {
  const [url, setUrl] = useState(merchant.webhookUrl ?? "");
  const [secret, setSecret] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadHooks = useCallback(async () => {
    const r = await api<{ deliveries: Delivery[] }>("webhook").catch(() => ({ deliveries: [] }));
    setDeliveries(r.deliveries);
  }, []);
  useEffect(() => {
    void loadHooks();
    const t = setInterval(loadHooks, 6000);
    return () => clearInterval(t);
  }, [loadHooks]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mt-8 grid gap-8 lg:grid-cols-2">
      <div className="rounded-3xl border border-line bg-surface p-6 shadow-card">
        <h2 className="text-[16px] font-semibold text-ink">Webhook endpoint</h2>
        <p className="mt-1 text-[13.5px] text-muted">
          ZecOne POSTs signed events (for example <code>payment.completed</code>) here and retries failures with backoff.
        </p>
        <div className="mt-4 flex gap-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://your-app.example/api/zecone/webhook"
            className="min-w-0 flex-1 rounded-xl border border-line bg-canvas px-3 py-2.5 font-mono text-[12.5px] text-ink outline-none focus:border-ink/40"
          />
          <button
            type="button"
            disabled={!!busy}
            onClick={() =>
              run("save", async () => {
                const r = await api<{ webhook: { secret: string } }>("webhook", { url });
                setSecret(r.webhook.secret);
                onChange();
              })
            }
            className="rounded-full bg-ink px-4 text-[13.5px] font-semibold text-white hover:bg-navy disabled:opacity-60"
          >
            Save
          </button>
        </div>
        {secret && (
          <div className="mt-3 rounded-xl border border-gold/30 bg-gold-soft p-3">
            <div className="text-[12.5px] font-semibold text-ink">Signing secret — shown once</div>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all font-mono text-[12px] text-ink">{secret}</code>
              <CopyButton value={secret} />
            </div>
          </div>
        )}
        <button
          type="button"
          disabled={!!busy || !merchant.webhookUrl}
          onClick={() =>
            run("test", async () => {
              const r = await api<{ outcome: string }>("webhook/test", {});
              setMsg(r.outcome === "delivered" ? "Test event delivered." : `Test event ${r.outcome}. Check your endpoint.`);
              void loadHooks();
            })
          }
          className="mt-3 text-[13px] font-semibold text-blue-deep hover:underline disabled:text-muted disabled:no-underline"
        >
          {busy === "test" ? "Sending…" : "Send a test event"}
        </button>
        {deliveries.length > 0 && (
          <ul className="mt-4 divide-y divide-line border-t border-line text-[12.5px]">
            {deliveries.slice(0, 6).map((d) => (
              <li key={d.id} className="flex justify-between gap-3 py-2">
                <span className="font-mono text-ink">{d.eventType}</span>
                <span className={d.status === "delivered" ? "text-green" : d.status === "failed" ? "text-red" : "text-amber"}>
                  {d.status}
                  {d.lastStatus ? ` · HTTP ${d.lastStatus}` : ""} · {d.attempts} attempt{d.attempts === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-3xl border border-line bg-surface p-6 shadow-card">
        <h2 className="text-[16px] font-semibold text-ink">API keys</h2>
        <p className="mt-1 text-[13.5px] text-muted">Keys are stored hashed. Rotate if a key may have leaked.</p>
        <ul className="mt-4 divide-y divide-line border-y border-line text-[13px]">
          {merchant.apiKeys.map((k) => (
            <li key={k.keyId} className="flex items-center justify-between py-2.5">
              <span className="font-mono text-ink">{k.keyId}_…</span>
              <span className={k.active ? "text-green" : "text-muted"}>{k.active ? "active" : "revoked"}</span>
            </li>
          ))}
        </ul>
        <button
          type="button"
          disabled={!!busy}
          onClick={() =>
            run("rotate", async () => {
              const r = await api<{ apiKey: string }>("keys", { revokeOthers: true });
              onKey(r.apiKey);
              onChange();
              window.scrollTo({ top: 0, behavior: "smooth" });
            })
          }
          className="mt-4 rounded-full border border-line-strong px-4 py-2 text-[13.5px] font-semibold text-ink hover:bg-canvas disabled:opacity-60"
        >
          {busy === "rotate" ? "Rotating…" : "Rotate key and revoke old ones"}
        </button>
        <p className="mt-4 text-[12.5px] leading-relaxed text-muted">
          Next: follow the <a href="/docs#quickstart" className="font-semibold text-blue-deep hover:underline">quickstart</a> to
          create payments from your server.
        </p>
      </div>
      {msg && (
        <p className="text-[13px] text-ink-soft lg:col-span-2" role="status">
          {msg}
        </p>
      )}
    </section>
  );
}
