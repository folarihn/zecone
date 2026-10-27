"use client";
// Merchant dashboard. Sign-in is an EIP-4361 signature from the payout wallet;
// the resulting session lives in an httpOnly cookie scoped to /api/merchant.
// The API key is displayed once (on registration or rotation) for the merchant
// to copy into their own server environment. It is never stored in the browser.
// Presentation only was redesigned; every call below goes to the same
// /api/merchant/* routes with the same bodies as before.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, KeyRound, Link2, Loader2, LogOut, RefreshCw, ShieldCheck, Wallet, Webhook } from "lucide-react";
import { qrSvg } from "../../sdk/src/checkout.ts";
import { BASE_MAINNET, BASE_SEPOLIA, chainLabel, friendly, useBaseWallet } from "../lib/use-base-wallet";
import { Callout, Container, DataList, EmptyState, Field, ModeBadge, Pill, StateBadge, buttonClass, inputClass } from "../ui";
import { CopyButton, Dialog, useToast } from "../components/ui-client";

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
const when = (t: number) => new Date(t * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

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
    <main className="bg-canvas">
      {checking ? (
        <Container className="py-16">
          <div className="flex items-center gap-2 text-[15px] text-muted" role="status">
            <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Loading your dashboard…
          </div>
        </Container>
      ) : merchant ? (
        <SignedIn merchant={merchant} apiKey={apiKey} onKey={setApiKey} onChange={loadMe} onSignOut={signOut} />
      ) : (
        <Container className="py-12 sm:py-16">
          <div className="grid items-start gap-12 lg:grid-cols-[1fr_0.95fr] lg:gap-16">
            <div>
              <p className="mb-4 text-[14px] font-semibold text-lime-deep">Merchant dashboard</p>
              <h1 className="zc-title text-ink">Accept shielded ZEC</h1>
              <p className="zc-lead mt-4 max-w-lg text-ink-soft">
                Sign in with the Base wallet that should receive your payouts. The signature proves you control that address. It
                is not a transaction and costs no gas.
              </p>
              <ol className="mt-10 grid gap-6">
                {[
                  ["Connect your Base wallet", "Coinbase Wallet, MetaMask or any EVM wallet in this browser."],
                  ["Sign the ownership message", "ZecOne verifies the signature on its server before creating your account."],
                  ["Copy your API key", "Shown once. Put it in your server's environment as ZECONE_API_KEY."],
                ].map(([t, d], i) => (
                  <li key={t} className="grid grid-cols-[36px_1fr] gap-4">
                    <span className="grid h-9 w-9 place-items-center rounded-full bg-forest font-mono text-[14px] text-lime">{i + 1}</span>
                    <span>
                      <span className="block text-[16px] font-semibold text-ink">{t}</span>
                      <span className="block text-[15px] leading-relaxed text-muted">{d}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
            <section aria-labelledby="signin" className="rounded-[var(--radius-xl)] border border-line bg-surface p-6 shadow-float sm:p-8">
              <h2 id="signin" className="zc-h3 text-ink">
                Sign in or create a merchant account
              </h2>
              <div className="mt-6">
                <Field label="Business name (new accounts)" htmlFor="merchant-name" hint="Shown to customers on your checkout.">
                  <input
                    id="merchant-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={80}
                    placeholder="e.g. Pixel Pass"
                    className={inputClass}
                  />
                </Field>
              </div>
              <div className="mt-5 flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-line bg-canvas px-4 py-3 text-[14.5px]">
                {wallet.address ? (
                  <>
                    <span className="font-mono text-ink">{short(wallet.address)}</span>
                    <Pill tone={wallet.onBase ? "green" : "amber"} dot>
                      {chainLabel(wallet.chainId) ?? "Unknown network"}
                    </Pill>
                  </>
                ) : (
                  <span className="text-muted">{wallet.available ? "No wallet connected yet." : "No browser wallet detected."}</span>
                )}
              </div>
              {wallet.address && !wallet.onBase && (
                <button type="button" onClick={() => void wallet.switchTo(BASE_MAINNET)} className={buttonClass("secondary", "md", "mt-3 w-full")}>
                  Switch to Base
                </button>
              )}
              <button type="button" onClick={signIn} disabled={signing} className={buttonClass("primary", "lg", "mt-4 w-full")}>
                {signing ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Wallet size={16} aria-hidden="true" />}
                {signing ? "Waiting for your wallet…" : wallet.address ? "Sign in with this wallet" : "Connect wallet and sign in"}
              </button>
              {(error || wallet.error) && (
                <Callout tone="danger" className="mt-4">
                  <span role="alert">{error ?? wallet.error}</span>
                </Callout>
              )}
              <p className="mt-5 text-[14px] leading-relaxed text-muted">
                Your payout address can only be changed by signing again from the new address. ZecOne never asks for token
                approvals or transactions here.
              </p>
            </section>
          </div>
        </Container>
      )}
    </main>
  );
}

const SECTIONS = [
  ["overview", "Overview"],
  ["links", "Payment links"],
  ["payments", "Payments"],
  ["developers", "API keys and webhooks"],
  ["payout", "Payout"],
] as const;

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
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api<{ payments: PaymentRow[] }>("payments?limit=25");
      setPayments(r.payments);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  const counts = useMemo(() => {
    const c = { completed: 0, open: 0, total: payments.length, usd: 0 };
    for (const p of payments) {
      if (p.state === "COMPLETED") {
        c.completed++;
        c.usd += Number(p.request.amountUsd);
      } else if (!["EXPIRED", "FAILED"].includes(p.state)) c.open++;
    }
    return c;
  }, [payments]);

  return (
    <>
      <div className="border-b border-line bg-canvas">
        <Container className="flex flex-wrap items-end justify-between gap-5 pb-8 pt-10">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <ModeBadge mode="demo" />
              {merchant.payoutVerification === "siwe" && (
                <Pill tone="green">
                  <ShieldCheck size={13} aria-hidden="true" /> Payout wallet verified
                </Pill>
              )}
            </div>
            <h1 className="zc-title mt-4 break-words text-ink">{merchant.name}</h1>
            <p className="mt-2 text-[15px] text-muted">
              Payouts go to <span className="font-mono text-ink">{merchant.payoutAddress ? short(merchant.payoutAddress) : "not set"}</span> on Base
            </p>
          </div>
          <button type="button" onClick={onSignOut} className={buttonClass("secondary", "sm")}>
            <LogOut size={14} aria-hidden="true" /> Sign out
          </button>
        </Container>
      </div>

      <Container className="grid gap-10 py-10 lg:grid-cols-[200px_1fr]">
        <nav aria-label="Dashboard sections" className="hidden lg:block">
          <ul className="sticky top-24 grid gap-0.5 text-[15px]">
            {SECTIONS.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`} className="block rounded-[10px] px-3 py-2 text-ink-soft hover:bg-ink/5 hover:text-ink">
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="grid min-w-0 gap-8">
          <section id="overview" aria-label="Overview" className="scroll-mt-24">
            <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-xl)] border border-line bg-line sm:grid-cols-4">
              {[
                ["Completed", String(counts.completed)],
                ["Open", String(counts.open)],
                ["Recent requests", String(counts.total)],
                ["Completed value", `$${counts.usd.toFixed(2)}`],
              ].map(([l, n]) => (
                <div key={l} className="bg-surface px-5 py-5">
                  <dt className="text-[14px] text-muted">{l}</dt>
                  <dd className="mt-1 font-display text-[30px] font-semibold tabular-nums leading-none text-ink">{loaded ? n : "…"}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-[13.5px] text-muted">Counts cover your 25 most recent payment requests. Demo payments are simulated.</p>
          </section>

          <PaymentLinkForm onCreated={refresh} />

          <section id="payments" aria-labelledby="payments-h" className="scroll-mt-24 overflow-hidden rounded-[var(--radius-xl)] border border-line bg-surface shadow-card">
            <div className="flex items-center justify-between gap-3 border-b border-line px-6 py-4">
              <h2 id="payments-h" className="zc-h3 text-ink">
                Payments
              </h2>
              <button type="button" onClick={refresh} className={buttonClass("ghost", "sm")} aria-label="Refresh payments">
                <RefreshCw size={15} aria-hidden="true" /> Refresh
              </button>
            </div>
            {loadError ? (
              <div className="p-6">
                <Callout tone="danger" title="Payments could not be loaded">
                  {loadError}
                </Callout>
              </div>
            ) : !loaded ? (
              <p className="px-6 py-8 text-[15px] text-muted">Loading payments…</p>
            ) : payments.length === 0 ? (
              <div className="p-6">
                <EmptyState title="No payments yet" icon={<Link2 size={18} />}>
                  Create a payment link above, or call <code className="font-mono text-[14px] text-ink">payments.create</code> from your
                  server.
                </EmptyState>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-[14.5px]" data-testid="payments">
                  <thead className="bg-canvas text-[13.5px] text-muted">
                    <tr>
                      <th scope="col" className="px-6 py-3 font-semibold">
                        Payment
                      </th>
                      <th scope="col" className="px-3 py-3 font-semibold">
                        Amount
                      </th>
                      <th scope="col" className="px-3 py-3 font-semibold">
                        Status
                      </th>
                      <th scope="col" className="px-3 py-3 font-semibold">
                        Created
                      </th>
                      <th scope="col" className="px-6 py-3 text-right font-semibold">
                        <span className="sr-only">Checkout</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {payments.map((p) => (
                      <tr key={p.id} className="hover:bg-canvas/60">
                        <td className="max-w-[260px] px-6 py-3.5">
                          <span className="block truncate font-medium text-ink">{p.description ?? "Payment"}</span>
                          <span className="block truncate font-mono text-[12.5px] text-muted">{p.id}</span>
                        </td>
                        <td className="whitespace-nowrap px-3 py-3.5">
                          <span className="block font-semibold tabular-nums text-ink">${p.request.amountUsd}</span>
                          {p.quote && <span className="block font-mono text-[12.5px] text-muted">{p.quote.zecAmount} ZEC</span>}
                        </td>
                        <td className="px-3 py-3.5">
                          <StateBadge state={p.state} />
                          {p.evidenceKind && <span className="mt-1 block text-[12.5px] text-muted">Simulated</span>}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3.5 text-muted">{when(p.createdAt)}</td>
                        <td className="px-6 py-3.5 text-right">
                          <a
                            href={`/pay/${p.id}?t=${p.checkoutToken}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[13.5px] font-semibold text-ink hover:bg-ink/5"
                            aria-label={`Open checkout for ${p.id}`}
                          >
                            Open <ExternalLink size={13} aria-hidden="true" />
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <DeveloperSettings merchant={merchant} onKey={onKey} onChange={onChange} />

          <section id="payout" aria-labelledby="payout-h" className="scroll-mt-24 rounded-[var(--radius-xl)] border border-line bg-surface p-6 shadow-card sm:p-7">
            <h2 id="payout-h" className="zc-h3 text-ink">
              Payout
            </h2>
            <p className="mt-1 text-[15px] text-muted">Where ZecOne sends ETH when one of your payments completes.</p>
            <DataList
              className="mt-4"
              items={[
                ["Payout address", <span key="a" className="break-all font-mono text-[14px]">{merchant.payoutAddress ?? "Not set"}</span>],
                ["Network", "Base"],
                ["Verified by", merchant.payoutVerification === "siwe" ? "Wallet signature (EIP-4361)" : merchant.payoutVerification ?? "Not verified"],
                ["Merchant id", <span key="m" className="font-mono text-[14px]">{merchant.id}</span>],
                ["Automatic payouts", <Pill key="p" tone="amber">Disabled in this build</Pill>],
              ]}
            />
            <p className="mt-4 text-[14px] leading-relaxed text-muted">
              To change it, sign from the new wallet within a dashboard session (
              <code className="font-mono text-[13.5px] text-ink">POST /api/v1/merchant/payout-address</code>). See the{" "}
              <a href="/docs#onboarding" className="font-semibold text-ink underline underline-offset-4">
                onboarding guide
              </a>
              .
            </p>
          </section>
        </div>
      </Container>

      <Dialog
        open={!!apiKey}
        onClose={() => onKey(null)}
        title="Your secret API key, shown once"
        footer={
          <button type="button" onClick={() => onKey(null)} className={buttonClass("primary", "md")}>
            I&apos;ve stored it
          </button>
        }
      >
        <p>
          Store it on your server, for example as <code className="font-mono text-[14px] text-ink">ZECONE_API_KEY</code>. Never put it in
          browser code. ZecOne keeps only a hash, so it cannot show this key again; you can rotate it at any time.
        </p>
        {apiKey && (
          <div className="mt-4 rounded-[var(--radius-md)] border border-gold/50 bg-gold-soft/60 p-3">
            <code className="block break-all font-mono text-[13.5px] text-ink" data-testid="api-key">
              {apiKey}
            </code>
            <CopyButton value={apiKey} label="Copy key" className="mt-2" />
          </div>
        )}
      </Dialog>
    </>
  );
}

function PaymentLinkForm({ onCreated }: { onCreated: () => void }) {
  const toast = useToast();
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
      toast("success", "Payment link created");
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="links" aria-labelledby="links-h" className="scroll-mt-24 rounded-[var(--radius-xl)] border border-line bg-surface p-6 shadow-card sm:p-7">
      <h2 id="links-h" className="zc-h3 text-ink">
        Create a payment link
      </h2>
      <p className="mt-1 text-[15px] text-muted">Share it with a customer. It opens a hosted checkout with live status.</p>
      <div className="mt-5 grid gap-4 sm:grid-cols-[0.7fr_1.3fr_auto] sm:items-end">
        <Field label="Amount (USD)" htmlFor="link-amount">
          <input
            id="link-amount"
            value={amount}
            inputMode="decimal"
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
            className={`${inputClass} font-semibold tabular-nums`}
          />
        </Field>
        <Field label="What it's for" htmlFor="link-desc">
          <input
            id="link-desc"
            value={description}
            maxLength={200}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Invoice #1042"
            className={inputClass}
          />
        </Field>
        <button type="button" onClick={create} disabled={busy} className={buttonClass("primary", "md", "w-full sm:w-auto")}>
          {busy && <Loader2 size={15} className="animate-spin" aria-hidden="true" />} Create link
        </button>
      </div>
      {error && (
        <Callout tone="danger" className="mt-4">
          <span role="alert">{error}</span>
        </Callout>
      )}
      {created && link && qr && (
        <div className="mt-6 grid gap-5 rounded-[var(--radius-lg)] border border-line bg-canvas p-4 sm:grid-cols-[auto_1fr] sm:p-5">
          <svg
            viewBox={`0 0 ${qr.size} ${qr.size}`}
            width={120}
            height={120}
            className="rounded-[10px] border border-line bg-white p-1"
            shapeRendering="crispEdges"
            role="img"
            aria-label="QR code for the payment link"
          >
            <path d={qr.path} fill="#102820" />
          </svg>
          <div className="min-w-0">
            <p className="font-display text-[18px] font-semibold text-ink">
              ${created.request.amountUsd} <span className="font-mono text-[14px] font-normal text-muted">{created.quote?.zecAmount} ZEC</span>
            </p>
            <p className="mt-2 break-all rounded-[10px] bg-surface px-3 py-2 font-mono text-[13px] text-ink-soft" data-testid="payment-link">
              {link}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <CopyButton value={link} label="Copy link" />
              <a href={link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[13px] font-semibold text-ink hover:bg-ink/5">
                Open checkout <ExternalLink size={13} aria-hidden="true" />
              </a>
            </div>
            <p className="mt-2 text-[13.5px] text-muted">Expires 15 minutes after creation if unpaid.</p>
          </div>
        </div>
      )}
    </section>
  );
}

function DeveloperSettings({ merchant, onKey, onChange }: { merchant: Merchant; onKey: (k: string) => void; onChange: () => void }) {
  const toast = useToast();
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
    <section id="developers" aria-label="API keys and webhooks" className="grid scroll-mt-24 gap-8 xl:grid-cols-2">
      <div className="rounded-[var(--radius-xl)] border border-line bg-surface p-6 shadow-card sm:p-7">
        <div className="flex items-center gap-2.5">
          <KeyRound size={18} aria-hidden="true" className="text-lime-deep" />
          <h2 className="zc-h3 text-ink">API keys</h2>
        </div>
        <p className="mt-1 text-[15px] text-muted">Keys are stored hashed. Rotate if a key may have leaked.</p>
        <ul className="mt-4 divide-y divide-line border-y border-line text-[14.5px]">
          {merchant.apiKeys.map((k) => (
            <li key={k.keyId} className="flex items-center justify-between gap-3 py-3">
              <span className="min-w-0">
                <span className="block truncate font-mono text-ink">{k.keyId}_…</span>
                <span className="block text-[13px] text-muted">Created {when(k.createdAt)}</span>
              </span>
              <Pill tone={k.active ? "green" : "neutral"} dot>
                {k.active ? "Active" : "Revoked"}
              </Pill>
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
              toast("success", "New key issued. Older keys are revoked.");
            })
          }
          className={buttonClass("secondary", "md", "mt-5")}
        >
          {busy === "rotate" ? "Rotating…" : "Rotate key and revoke old ones"}
        </button>
        <p className="mt-4 text-[14px] leading-relaxed text-muted">
          Next: follow the{" "}
          <a href="/docs#quickstart" className="font-semibold text-ink underline underline-offset-4">
            quickstart
          </a>{" "}
          to create payments from your server.
        </p>
      </div>

      <div className="rounded-[var(--radius-xl)] border border-line bg-surface p-6 shadow-card sm:p-7">
        <div className="flex items-center gap-2.5">
          <Webhook size={18} aria-hidden="true" className="text-lime-deep" />
          <h2 className="zc-h3 text-ink">Webhook endpoint</h2>
        </div>
        <p className="mt-1 text-[15px] text-muted">
          ZecOne sends signed events such as <code className="font-mono text-[14px] text-ink">payment.completed</code> here and retries
          failures with backoff.
        </p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <label htmlFor="webhook-url" className="sr-only">
            Webhook URL
          </label>
          <input
            id="webhook-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://your-app.example/api/zecone/webhook"
            className={`${inputClass} min-w-0 flex-1 font-mono text-[13.5px]`}
          />
          <button
            type="button"
            disabled={!!busy}
            onClick={() =>
              run("save", async () => {
                const r = await api<{ webhook: { secret: string } }>("webhook", { url });
                setSecret(r.webhook.secret);
                onChange();
                toast("success", "Webhook endpoint saved");
              })
            }
            className={buttonClass("primary", "md")}
          >
            Save
          </button>
        </div>
        {secret && (
          <div className="mt-3 rounded-[var(--radius-md)] border border-gold/50 bg-gold-soft/60 p-3">
            <p className="text-[14px] font-semibold text-ink">Signing secret, shown once</p>
            <code className="mt-1 block break-all font-mono text-[13px] text-ink">{secret}</code>
            <CopyButton value={secret} label="Copy secret" className="mt-1" />
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
          className={buttonClass("ghost", "sm", "mt-3 -ml-3")}
        >
          {busy === "test" ? "Sending…" : "Send a test event"}
        </button>
        {deliveries.length > 0 ? (
          <ul className="mt-3 divide-y divide-line border-t border-line text-[14px]" aria-label="Recent deliveries">
            {deliveries.slice(0, 6).map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <span className="font-mono text-[13.5px] text-ink">{d.eventType}</span>
                <span className="flex items-center gap-2 text-muted">
                  <Pill tone={d.status === "delivered" ? "green" : d.status === "failed" ? "red" : "amber"} dot>
                    {d.status}
                  </Pill>
                  {d.lastStatus ? `HTTP ${d.lastStatus}, ` : ""}
                  {d.attempts} attempt{d.attempts === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-[14px] text-muted">No deliveries yet.</p>
        )}
      </div>
      {msg && (
        <p className="text-[14.5px] text-ink-soft xl:col-span-2" role="status">
          {msg}
        </p>
      )}
    </section>
  );
}
