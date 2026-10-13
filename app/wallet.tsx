"use client";
import { useEffect, useRef, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ArrowRight,
  Check,
  CheckCheck,
  Clock,
  Copy,
  ExternalLink,
  Globe,
  Grid2X2,
  Info,
  KeyRound,
  Layers,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Wallet as WalletIcon,
  X,
} from "lucide-react";
import type { Dashboard, CheckoutView } from "../services/wallet/view";
import NetworksPanel from "./networks/panel";
import PurchasePanel from "./purchases/panel";
import SwapPanel from "./swaps/panel";
import SeaportPanel from "./seaport/panel";
type Tab =
  | "Wallet"
  | "Checkout"
  | "Sponsor"
  | "Apps"
  | "Purchases"
  | "Seaport"
  | "Tokens"
  | "Activity"
  | "Privacy";
const short = (v: string, n = 6) => `${v.slice(0, n)}…${v.slice(-4)}`;
const units = (v: string, decimals = 8) => {
  const x = BigInt(v),
    neg = x < 0n,
    abs = neg ? -x : x,
    base = 10n ** BigInt(decimals);
  return `${neg ? "−" : ""}${abs / base}${abs % base ? "." + (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "") : ""}`;
};
const time = (n: number) =>
  new Date(n * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
const icons = {
  Wallet: WalletIcon,
  Checkout: Layers,
  Activity: Clock,
  Privacy: ShieldCheck,
  Sponsor: KeyRound,
  Apps: Globe,
  Purchases: Grid2X2,
  Tokens: ArrowRight,
  Seaport: Layers,
};
function Seal({ small = false }: { small?: boolean }) {
  return (
    <div className={`seal ${small ? "seal-small" : ""}`} aria-hidden="true">
      <span>Ƶ</span>
      <i />
      <i />
      <i />
    </div>
  );
}
function NFTArt() {
  return (
    <div className="nft-art">
      <div className="art-top">
        <span>ZECONE</span>
        <span>TESTNET EDITION</span>
      </div>
      <Seal />
      <div className="art-bottom">
        <span>
          PRIVATE ORIGIN.
          <br />
          PUBLIC PROOF.
        </span>
        <span>↗</span>
      </div>
    </div>
  );
}
function Badge({
  children,
  publicActivity = false,
}: {
  children: React.ReactNode;
  publicActivity?: boolean;
}) {
  return (
    <span className={`badge ${publicActivity ? "public" : ""}`}>
      {publicActivity ? <Globe size={12} /> : <ShieldCheck size={12} />}{" "}
      {children}
    </span>
  );
}
function TxLink({ hash }: { hash: string }) {
  return (
    <a
      className="text-link"
      href={`https://sepolia.basescan.org/tx/${hash}`}
      target="_blank"
      rel="noreferrer"
    >
      View on Base explorer <ExternalLink size={13} />
    </a>
  );
}
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="icon-button"
      aria-label={label}
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check size={16} /> : <Copy size={16} />}
    </button>
  );
}
function Dialog({
  title,
  children,
  onClose,
  error,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  error?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog ref={ref} onCancel={onClose} aria-labelledby="dialog-title">
      <div className="dialog-title">
        <h2 id="dialog-title">{title}</h2>
        <button
          onClick={onClose}
          className="icon-button"
          aria-label="Close dialog"
        >
          <X size={20} />
        </button>
      </div>
      {error && (
        <p className="error notice" role="alert">
          {error}
        </p>
      )}
      {children}
    </dialog>
  );
}
export default function Wallet() {
  const [session, setSession] = useState<{
      csrf: string;
      connected: boolean;
    } | null>(null),
    [data, setData] = useState<Dashboard | null>(null),
    [tab, setTab] = useState<Tab>("Wallet");
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [pairCode, setPairCode] = useState("");
  const [apps, setApps] = useState<{
    connections: { origin: string; created: number }[];
    requests: {
      origin: string;
      method: string;
      state: string;
      txHash: string | null;
      created: number;
    }[];
  } | null>(null);
  const [actionDraft, setActionDraft] = useState<{
    id: string;
    intent: Record<string, unknown>;
    digest: string;
    description: string;
  } | null>(null);
  const [challenge, setChallenge] = useState<{
      id: string;
      message: string;
    } | null>(null),
    [modal, setModal] = useState<"order" | "pay" | null>(null),
    [selected, setSelected] = useState<string | null>(null);
  const createId = useRef<string | null>(null);
  async function call(path: string, body?: unknown, csrf = session?.csrf) {
    const r = await fetch(`/api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers:
        body === undefined
          ? {}
          : {
              "Content-Type": "application/json",
              ...(csrf ? { "x-zecone-csrf": csrf } : {}),
            },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    const result = await r.json();
    if (!r.ok) {
      if (r.status === 401) {
        setSession(null);
        setData(null);
      }
      throw Error(result.error ?? "Request failed.");
    }
    return result;
  }
  async function task(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The operation could not finish.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function load() {
    setData(await call("dashboard"));
  }
  async function loadApps() {
    setApps(await call("dapps/list"));
  }
  useEffect(() => {
    let active = true;
    const token = new URLSearchParams(location.hash.slice(1)).get("pair");
    (async () => {
      try {
        if (token) history.replaceState(null, "", "/");
        const s = token ? await call("pair", { token }) : await call("session");
        if (active) {
          setSession(s);
          setData(await call("dashboard"));
        }
      } catch (e) {
        if (active && token)
          setError(e instanceof Error ? e.message : "Could not unlock wallet.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => {
      load().catch((e) => setError(e.message));
    }, 5000);
    return () => clearInterval(timer);
  }, [session]);
  const checkout =
    data?.checkouts.find((c) => c.id === selected) ?? data?.checkouts[0];
  const activeCheckout = data?.checkouts.find(
    (c) => !["Completed", "Failed"].includes(c.status),
  );
  async function connect() {
    await task(async () => setChallenge(await call("challenge", {})));
  }
  async function refresh() {
    await task(async () => {
      await call("refresh", {});
      await load();
    });
  }
  async function lockWallet() {
    await task(async () => {
      await call("logout", {});
      setSession(null);
      setData(null);
    });
  }
  async function quote(c: CheckoutView) {
    await task(async () => {
      await call("quote", { id: c.id });
      setSelected(c.id);
      await load();
      setModal("pay");
    });
  }
  const header = (
    <>
      <div className="brand">
        <span className="brand-mark">Ƶ</span>
        <span>
          ZecOne<span className="brand-dot">.</span>
        </span>
      </div>
      <span className="testnet-tag">
        <span /> TESTNET ONLY
      </span>
    </>
  );
  if (loading)
    return (
      <main className="unlock">
        <div className="unlock-card">
          {header}
          <p className="muted" role="status">
            Opening your local wallet…
          </p>
        </div>
      </main>
    );
  if (!session)
    return (
      <main className="unlock">
        <div className="unlock-card">
          {header}
          <div className="unlock-symbol">
            <LockKeyhole size={30} />
          </div>
          <p className="eyebrow">ON YOUR DEVICE</p>
          <h1>
            Your wallet.
            <br />
            Your keys.
          </h1>
          <p className="muted">
            Open <strong>Launch-ZecOne.cmd</strong> to securely connect this
            browser to your local testnet wallet.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              task(async () => {
                const s = await call("pair", { token: pairCode.trim() });
                setPairCode("");
                setSession(s);
                await load();
              });
            }}
          >
            <label htmlFor="pair-code">Have a local pairing code?</label>
            <input
              id="pair-code"
              type="password"
              value={pairCode}
              onChange={(e) => setPairCode(e.target.value)}
              autoComplete="off"
              placeholder="Enter your one-time code"
            />
            <button className="primary full" disabled={busy || !pairCode}>
              Unlock wallet <ArrowRight size={16} />
            </button>
          </form>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="unlock-foot">
            <ShieldCheck size={15} /> Keys stay on this computer. No cloud
            account.
          </div>
        </div>
      </main>
    );
  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        {header}
        <nav aria-label="Main navigation">
          {(
            [
              "Wallet",
              "Checkout",
              "Sponsor",
              "Apps",
              "Purchases",
              "Tokens",
              "Seaport",
              "Activity",
              "Privacy",
            ] as Tab[]
          ).map((t) => {
            const Icon = icons[t];
            return (
              <button
                key={t}
                className={tab === t ? "nav-item active" : "nav-item"}
                aria-current={tab === t ? "page" : undefined}
                onClick={() => setTab(t)}
              >
                <Icon size={19} />
                <span>{t}</span>
                {t === tab && <span className="nav-dot" />}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-note">
            <span className="local-dot" />
            <div>
              <strong>Local by design</strong>
              <p>Connected to your device</p>
            </div>
          </div>
          <button
            className="lock-button"
            onClick={() =>
              task(async () => {
                await call("logout", {});
                setSession(null);
                setData(null);
              })
            }
          >
            <LockKeyhole size={16} /> Lock wallet
          </button>
          <p className="version">ZecOne · Phase 1</p>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span className="topbar-label">Your local wallet</span>
          <div className="account-controls">
            <button
              className="icon-button mobile-lock"
              aria-label="Lock wallet"
              onClick={lockWallet}
            >
              <LockKeyhole size={17} />
            </button>
            <span className="network-pill">
              <span /> Base Sepolia
            </span>
            <button
              className={`account-pill ${session.connected ? "verified" : ""}`}
              onClick={connect}
              disabled={busy}
            >
              {session.connected ? (
                <ShieldCheck size={16} />
              ) : (
                <KeyRound size={16} />
              )}
              <span>{data ? short(data.address) : "Local account"}</span>
              <span className="desktop-only">
                {session.connected ? "Verified" : "Verify ownership"}
              </span>
            </button>
          </div>
        </header>
        <main id="main" className="main">
          <div className="page-heading">
            <div>
              <p className="eyebrow">
                {tab === "Wallet"
                  ? "YOUR ASSETS, TOGETHER"
                  : tab === "Checkout"
                    ? "FROM PRIVATE PAYMENT TO PUBLIC OWNERSHIP"
                    : tab === "Sponsor"
                      ? "A FIXED ACTION, PAID FROM SHIELDED ZEC"
                      : tab === "Apps"
                        ? "ORIGIN-BOUND EVM PERMISSIONS"
                        : tab === "Purchases"
                          ? "PRIVATE PAYMENT, PUBLIC NFT OWNERSHIP"
                          : tab === "Tokens"
                            ? "PRIVATE PAYMENT, PUBLIC TOKEN OWNERSHIP"
                          : tab === "Seaport" ? "PRIVATE PAYMENT, DIRECT SEAPORT DELIVERY" : tab === "Activity"
                            ? "A CLEAR RECORD"
                            : "UNDERSTAND YOUR WALLET"}
              </p>
              <h1>
                {tab === "Wallet"
                  ? "Wallet overview"
                  : tab === "Checkout"
                    ? "Cross-chain checkout"
                    : tab === "Sponsor"
                      ? "ZEC-funded test action"
                      : tab === "Apps"
                        ? "Connected applications"
                        : tab === "Purchases"
                          ? "Your marketplace purchases"
                          : tab === "Tokens"
                            ? "Your token purchases"
                          : tab === "Seaport"
                            ? "Your Seaport purchases"
                          : tab === "Activity"
                            ? "Recent activity"
                            : "Privacy, in plain language"}
              </h1>
              <p className="subtitle">
                {tab === "Wallet"
                  ? "Shielded where it matters. Connected when you choose."
                  : tab === "Checkout"
                    ? "Pay with shielded test ZEC. Receive an NFT on Base."
                    : tab === "Sponsor"
                      ? "Approve one immutable Base Sepolia action before you pay."
                      : tab === "Apps"
                        ? "Each website gets access only after you approve its exact origin."
                        : tab === "Purchases"
                          ? "Track shielded payments, NFT delivery and recovery."
                          : tab === "Tokens"
                            ? "Review an AMM quote and fund a bounded swap with test ZEC."
                          : tab === "Seaport"
                            ? "Review a genuine Seaport listing and fund its exact fulfillment with test ZEC."
                          : tab === "Activity"
                            ? "Transactions tracked by your local ZecOne wallet."
                            : "Know what stays private, and what becomes public."}
              </p>
            </div>
            <button
              className="refresh"
              onClick={refresh}
              disabled={busy || data?.health.busy}
              aria-label="Refresh wallet data"
            >
              <RefreshCw
                size={17}
                className={data?.health.busy ? "spinning" : ""}
              />
              <span>Refresh</span>
            </button>
          </div>
          {error && (
            <div className="error notice" role="alert">
              <Info size={18} />
              <span>{error}</span>
              <button
                className="icon-button"
                onClick={() => setError("")}
                aria-label="Dismiss error"
              >
                <X size={16} />
              </button>
            </div>
          )}
          {!session.connected && (
            <div className="connect-banner">
              <KeyRound size={19} />
              <div>
                <strong>Make this wallet yours</strong>
                <p>
                  Approve a local signature to verify your Base account. No
                  funds are moved.
                </p>
              </div>
              <button className="secondary" onClick={connect} disabled={busy}>
                Verify ownership <ArrowRight size={15} />
              </button>
            </div>
          )}
          {!data ? (
            <p role="status">Loading wallet data…</p>
          ) : (
            <>
              {tab === "Wallet" && session?.connected && <NetworksPanel />}
              {tab === "Wallet" && (
                <>
                  <section className="balances" aria-label="Wallet balances">
                    <div className="balance-card shielded">
                      <div className="card-top">
                        <div className="asset-label">
                          <span className="asset-symbol">Ƶ</span>
                          <div>
                            <h2>Shielded Zcash</h2>
                            <p>Zcash Testnet</p>
                          </div>
                        </div>
                        <Badge>Shielded</Badge>
                      </div>
                      <div className="balance-value">
                        {data.zcash ? units(data.zcash.totalZatoshis) : "—"}
                        <span>TAZ</span>
                      </div>
                      <p className="balance-detail">
                        {data.zcash
                          ? `${units(data.zcash.spendableZatoshis)} TAZ available to spend`
                          : "Waiting for a verified wallet sync"}
                      </p>
                      <div className="balance-footer">
                        <span>
                          <LockKeyhole size={13} /> Your balance is private
                        </span>
                        <button onClick={() => setTab("Checkout")}>
                          Use test ZEC <ArrowUpRight size={17} />
                        </button>
                      </div>
                    </div>
                    <div className="balance-card base">
                      <div className="card-top">
                        <div className="asset-label">
                          <span className="base-symbol">━</span>
                          <div>
                            <h2>Base Sepolia</h2>
                            <p>Ethereum test network</p>
                          </div>
                        </div>
                        <Badge publicActivity>Public</Badge>
                      </div>
                      <div className="balance-value">
                        {data.base ? units(data.base.wei, 18) : "—"}
                        <span>ETH</span>
                      </div>
                      <p className="balance-detail">
                        Test ETH · No monetary value
                      </p>
                      <div className="balance-footer">
                        <span className="mono">{short(data.address, 10)}</span>
                        <CopyButton
                          value={data.address}
                          label="Copy Base wallet address"
                        />
                      </div>
                    </div>
                  </section>
                  <div className="health-strip">
                    <div>
                      <span
                        className={`status-dot ${data.health.zcash !== "Synced" ? "pending" : ""}`}
                      />
                      <strong>Zcash</strong>
                      <span>
                        {data.zcash
                          ? `Block ${data.zcash.scanned.toLocaleString()}`
                          : "Syncing wallet"}
                      </span>
                    </div>
                    <div>
                      <span
                        className={`status-dot ${data.health.base !== "Connected" ? "pending" : ""}`}
                      />
                      <strong>Base</strong>
                      <span>
                        {data.base
                          ? `Block ${Number(data.base.block).toLocaleString()}`
                          : "Connecting"}
                      </span>
                    </div>
                    <span className="health-time">
                      {data.health.busy
                        ? "Checking networks…"
                        : data.zcash
                          ? `Zcash synced at ${time(data.zcash.observedAt)}`
                          : "Initial sync in progress"}
                    </span>
                  </div>
                  {(data.health.zcash.includes("unavailable") ||
                    data.health.base.includes("unavailable")) && (
                    <p className="notice error" role="status">
                      {data.health.zcash.includes("unavailable")
                        ? data.health.zcash
                        : data.health.base}
                      . Check the last sync time before relying on these
                      balances.
                    </p>
                  )}
                  <section className="section">
                    <div className="section-heading">
                      <div>
                        <h2>
                          Your collectibles{" "}
                          <span className="count">{data.nfts.length}</span>
                        </h2>
                        <p>
                          Verified ownership in the ZecOne collection on Base
                          Sepolia.
                        </p>
                      </div>
                      <button
                        className="text-link"
                        onClick={() => setTab("Checkout")}
                      >
                        Mint a test NFT <ArrowRight size={16} />
                      </button>
                    </div>
                    <div className="collectibles">
                      {data.nfts.map((n, i) => (
                        <article className="nft-card" key={n.tokenId}>
                          <NFTArt />
                          <div className="nft-info">
                            <div>
                              <h3>ZecOne Phase 0</h3>
                              <p>Testnet collectible · {short(n.tokenId, 5)}</p>
                            </div>
                            <ShieldCheck size={20} />
                          </div>
                          <div className="nft-footer">
                            <span>
                              <Check size={13} /> Ownership verified
                            </span>
                            <a
                              href={`https://sepolia.basescan.org/token/${data.contract}?a=${n.tokenId}`}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={`View collectible ${i + 1} on Base explorer`}
                            >
                              <ArrowUpRight size={18} />
                            </a>
                          </div>
                        </article>
                      ))}
                      <article className="mint-callout">
                        <div className="callout-icon">
                          <Layers size={25} />
                        </div>
                        <h3>
                          Start private.
                          <br />
                          Arrive connected.
                        </h3>
                        <p>
                          One shielded payment. One NFT in your wallet. Base gas
                          is covered by the testnet relayer.
                        </p>
                        <button
                          className="secondary"
                          onClick={() => setTab("Checkout")}
                        >
                          Explore checkout <ArrowRight size={16} />
                        </button>
                        <span className="tiny">
                          0.01 TAZ + Zcash network fee
                        </span>
                      </article>
                    </div>
                  </section>
                  <section className="section">
                    <div className="section-heading">
                      <h2>Latest activity</h2>
                      <button
                        className="text-link"
                        onClick={() => setTab("Activity")}
                      >
                        View all <ArrowRight size={16} />
                      </button>
                    </div>
                    <Activity data={data} compact />
                  </section>
                </>
              )}
              {tab === "Checkout" && (
                <div className="checkout-layout">
                  <div>
                    <div className="checkout-product">
                      <NFTArt />
                      <div className="product-info">
                        <Badge publicActivity>Base Sepolia · ERC-721</Badge>
                        <h2>ZecOne Phase 0</h2>
                        <p>
                          A real testnet collectible proving a shielded payment
                          can authorize a mint on Base.
                        </p>
                        <div className="price">
                          <strong>
                            0.01 <span>TAZ</span>
                          </strong>
                          <span>+ Zcash network fee</span>
                        </div>
                        <p className="tiny">
                          Collection artwork shown here is a local illustration.
                          The contract supplies a name and description, with no
                          image.
                        </p>
                      </div>
                    </div>
                    <div className="privacy-note">
                      <ShieldCheck size={22} />
                      <div>
                        <h3>Private payment. Public collectible.</h3>
                        <p>
                          Zcash shields the payment. Your NFT, wallet address
                          and Base transaction are public. The trusted local
                          operator can link this checkout across networks.
                        </p>
                      </div>
                    </div>
                  </div>
                  <section className="checkout-panel">
                    {data.checkouts.length > 1 && (
                      <label className="saved-checkouts">
                        Saved checkout
                        <select
                          value={checkout?.id ?? ""}
                          onChange={(e) => setSelected(e.target.value)}
                        >
                          {data.checkouts.map((c) => (
                            <option key={c.id} value={c.id}>
                              {new Date(c.created * 1000).toLocaleString()} ·{" "}
                              {c.status}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <p className="eyebrow">
                      {checkout ? "YOUR CHECKOUT" : "REVIEW YOUR MINT"}
                    </p>
                    <h2>
                      {checkout
                        ? checkout.status
                        : "A collectible, funded by Zcash"}
                    </h2>
                    <dl className="review-list">
                      <div>
                        <dt>Pay from</dt>
                        <dd>Shielded Zcash Testnet</dd>
                      </div>
                      <div>
                        <dt>Receive on</dt>
                        <dd>Base Sepolia</dd>
                      </div>
                      <div>
                        <dt>Payment</dt>
                        <dd>0.01 TAZ</dd>
                      </div>
                      <div>
                        <dt>Base gas</dt>
                        <dd>Covered by relayer</dd>
                      </div>
                      <div>
                        <dt>Your wallet</dt>
                        <dd className="mono break">{data.address}</dd>
                      </div>
                      <div>
                        <dt>NFT contract</dt>
                        <dd className="mono break">{data.contract}</dd>
                      </div>
                    </dl>
                    {checkout ? (
                      <>
                        <CheckoutProgress c={checkout} />
                        {checkout.stage === "sending" && (
                          <div className="notice" role="status">
                            <RefreshCw className="spinning" size={18} />
                            <span>
                              Building your shielded proof locally. This may
                              take a few minutes. Your approval is saved; do not
                              pay again.
                            </span>
                          </div>
                        )}
                        {["awaiting", "quoted"].includes(checkout.stage) &&
                          checkout.status === "Awaiting payment" && (
                            <button
                              className="primary full"
                              disabled={busy || !session.connected}
                              onClick={() => quote(checkout)}
                            >
                              {busy
                                ? "Calculating fee…"
                                : "Review payment & fee"}{" "}
                              <ArrowRight size={16} />
                            </button>
                          )}
                        {checkout.recovery && (
                          <div className="notice recovery">
                            <Info size={18} />
                            <p>{checkout.recovery}</p>
                          </div>
                        )}
                        {checkout.baseTx && (
                          <div className="receipt">
                            <TxLink hash={checkout.baseTx} />
                            {checkout.status === "Completed" && (
                              <p>
                                <CheckCheck size={16} /> NFT ownership verified
                                for your wallet.
                              </p>
                            )}
                          </div>
                        )}
                        {checkout.paymentTx && (
                          <details className="payment-reference">
                            <summary>Shielded payment reference</summary>
                            <p className="mono break">{checkout.paymentTx}</p>
                            <p className="tiny">
                              A public transaction ID does not reveal shielded
                              recipients or amounts.
                            </p>
                          </details>
                        )}
                        <button
                          className="secondary full"
                          disabled={busy || data.health.busy}
                          onClick={() =>
                            task(async () => {
                              await call("recheck", { id: checkout.id });
                              await load();
                            })
                          }
                        >
                          Recheck status <RefreshCw size={15} />
                        </button>
                        {["Completed", "Failed"].includes(checkout.status) && (
                          <button
                            className="text-link new-checkout"
                            onClick={() => {
                              createId.current = crypto.randomUUID();
                              setModal("order");
                            }}
                            disabled={!session.connected || busy}
                          >
                            Review a new checkout <ArrowRight size={15} />
                          </button>
                        )}
                        <p className="tiny">
                          {data.health.worker}. Closing this page does not
                          cancel an approved transaction.
                        </p>
                      </>
                    ) : (
                      <>
                        <div className="notice">
                          <Info size={17} />
                          <p>
                            First sign a fixed mint order. Then review the
                            actual Zcash fee and approve payment separately. We
                            wait for 10 confirmations before settlement.
                          </p>
                        </div>
                        <button
                          className="primary full"
                          onClick={() => {
                            createId.current ??= crypto.randomUUID();
                            setModal("order");
                          }}
                          disabled={busy || !session.connected}
                        >
                          {session.connected
                            ? "Review & create order"
                            : "Verify ownership to continue"}{" "}
                          <ArrowRight size={16} />
                        </button>
                      </>
                    )}
                    <p className="checkout-disclaimer">
                      Testnet assets only. This is a trusted payment-to-mint
                      service, not a bridge. No automatic refunds.
                    </p>
                  </section>
                </div>
              )}
              {tab === "Sponsor" && (
                <section className="checkout-panel">
                  <p className="eyebrow">FIXED TEST ACTION · BASE SEPOLIA</p>
                  <h2>
                    {checkout?.kind === "action"
                      ? checkout.status
                      : "Create a reviewed action"}
                  </h2>
                  <p>
                    This records one fixed note for your user-controlled EOA. It
                    does not mint an NFT or allow an arbitrary contract call.
                    The local service uses prefunded test ETH; the ZEC payment
                    is a testnet service price, not an exchange or bridge.
                  </p>
                  {actionDraft ? (
                    <>
                      <dl className="review-list">
                        <div>
                          <dt>Website action</dt>
                          <dd>Record one fixed ZecOne test note</dd>
                        </div>
                        <div>
                          <dt>Network</dt>
                          <dd>Base Sepolia · 84532</dd>
                        </div>
                        <div>
                          <dt>Your account</dt>
                          <dd className="mono break">
                            {String(actionDraft.intent.recipient)}
                          </dd>
                        </div>
                        <div>
                          <dt>Contract</dt>
                          <dd className="mono break">
                            {String(actionDraft.intent.contract)}
                          </dd>
                        </div>
                        <div>
                          <dt>Calldata</dt>
                          <dd className="mono break">
                            {String(actionDraft.intent.data)}
                          </dd>
                        </div>
                        <div>
                          <dt>Value / gas budget</dt>
                          <dd>
                            0 ETH / 0.005 ETH execution cap; Base L1 data fees
                            may be additional
                          </dd>
                        </div>
                        <div>
                          <dt>Shielded payment</dt>
                          <dd>
                            {units(String(actionDraft.intent.zatoshis))} TAZ
                          </dd>
                        </div>
                        <div>
                          <dt>Expiry</dt>
                          <dd>
                            {new Date(
                              Number(actionDraft.intent.expiry) * 1000,
                            ).toLocaleString()}
                          </dd>
                        </div>
                      </dl>
                      <div className="notice">
                        <Info size={18} />
                        <p>
                          {actionDraft.description} The local operator can
                          correlate your shielded payment and public Base
                          action.
                        </p>
                      </div>
                      <button
                        className="primary full"
                        disabled={busy}
                        onClick={() =>
                          task(async () => {
                            const c = await call("action-approve", {
                              id: actionDraft.id,
                              digest: actionDraft.digest,
                              approved: true,
                            });
                            setSelected(c.id);
                            setActionDraft(null);
                            await load();
                          })
                        }
                      >
                        Approve these exact terms <ArrowRight size={16} />
                      </button>
                    </>
                  ) : checkout?.kind === "action" ? (
                    <>
                      <p>
                        Payment status: <strong>{checkout.status}</strong> ·{" "}
                        {checkout.confirmations}/10 confirmations
                      </p>
                      {checkout.baseTx && <TxLink hash={checkout.baseTx} />}
                      {checkout.status === "Awaiting payment" && (
                        <button
                          className="primary full"
                          disabled={busy}
                          onClick={() =>
                            checkout.quote ? setModal("pay") : quote(checkout)
                          }
                        >
                          {checkout.quote
                            ? "Open payment review"
                            : "Review shielded payment and fee"}{" "}
                          <ArrowRight size={16} />
                        </button>
                      )}
                      {checkout.recovery && (
                        <div className="notice recovery">
                          <Info size={18} />
                          <p>{checkout.recovery}</p>
                        </div>
                      )}
                      <button
                        className="secondary full"
                        disabled={busy || data.health.busy}
                        onClick={() =>
                          task(async () => {
                            await call("recheck", { id: checkout.id });
                            await load();
                          })
                        }
                      >
                        Recheck status
                      </button>
                    </>
                  ) : (
                    <>
                      <p>
                        The configured action contract and exact calldata will
                        appear in the approval summary before you sign.
                      </p>
                      <p className="tiny">
                        The action contract must be deployed locally before a
                        quote can be created. Its deployment is a separate Base
                        Sepolia transaction performed by the local relayer.
                      </p>
                      <button
                        className="primary full"
                        disabled={busy || !session.connected}
                        onClick={() =>
                          task(async () =>
                            setActionDraft(await call("action-draft", {})),
                          )
                        }
                      >
                        {session.connected
                          ? "Review fixed action terms"
                          : "Verify ownership to continue"}
                      </button>
                    </>
                  )}
                </section>
              )}
              {tab === "Apps" && (
                <section className="checkout-panel">
                  <div className="card-top">
                    <h2>Approved websites</h2>
                    <button
                      className="secondary"
                      onClick={() => task(loadApps)}
                    >
                      Refresh list
                    </button>
                  </div>
                  <p>
                    Compatible dApps must include the public EIP-1193 connector
                    and open a ZecOne approval popup. This local wallet does not
                    inject into unrelated sites.
                  </p>
                  <div className="activity-list">
                    {(apps?.connections ?? []).map((app) => (
                      <div className="activity-row" key={app.origin}>
                        <div className="activity-icon">
                          <Globe size={18} />
                        </div>
                        <div className="activity-name">
                          <strong>{app.origin}</strong>
                          <span>
                            Public EVM address access · approved{" "}
                            {new Date(app.created).toLocaleString()}
                          </span>
                        </div>
                        <button
                          className="secondary"
                          onClick={() =>
                            task(async () => {
                              await call("dapps/revoke", {
                                origin: app.origin,
                              });
                              await loadApps();
                            })
                          }
                        >
                          Disconnect
                        </button>
                      </div>
                    ))}
                  </div>
                  {!apps?.connections.length && (
                    <p className="empty">
                      No dApps are connected. Opening a request still requires
                      your approval.
                    </p>
                  )}
                  <h3>Recent requests</h3>
                  <div className="activity-list">
                    {(apps?.requests ?? []).slice(0, 20).map((r, i) => (
                      <div
                        className="activity-row"
                        key={`${r.origin}-${r.created}-${i}`}
                      >
                        <div className="activity-name">
                          <strong>{r.origin}</strong>
                          <span>
                            {r.method} · {r.state} ·{" "}
                            {new Date(r.created).toLocaleString()}
                          </span>
                        </div>
                        {r.txHash && (
                          <a
                            className="text-link"
                            href={`https://sepolia.basescan.org/tx/${r.txHash}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Transaction
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {tab === "Purchases" && <PurchasePanel />}
              {tab === "Tokens" && <SwapPanel />}
              {tab === "Seaport" && <SeaportPanel />}
              {tab === "Activity" && (
                <>
                  <div className="activity-intro">
                    <Badge>Shielded Zcash</Badge>
                    <Badge publicActivity>Public Base</Badge>
                    <span>Local wallet history + ZecOne mint receipts</span>
                  </div>
                  <Activity data={data} />
                  <p className="tiny activity-foot">
                    Coverage: this local Zcash wallet and mints recorded by
                    ZecOne. This is not a complete index of Base transfers or
                    other NFT collections.
                  </p>
                </>
              )}
              {tab === "Privacy" && (
                <div className="privacy-grid">
                  {[
                    {
                      icon: LockKeyhole,
                      title: "Your keys stay here",
                      text: "Zcash spending keys and your Base key are stored on this computer. The browser receives no key or seed phrase. A separate local signer handles your approvals.",
                    },
                    {
                      icon: ShieldCheck,
                      title: "Zcash is shielded",
                      text: "Shielded payments hide recipients and amounts on the public Zcash ledger. Your authenticated local interface can still show your own balance and history.",
                    },
                    {
                      icon: Globe,
                      title: "Base is public",
                      text: "NFT ownership, your Base address, transaction timing and contract interactions are visible to everyone. An explorer link opens an external site only when you choose it.",
                    },
                    {
                      icon: Layers,
                      title: "A trusted operator connects them",
                      text: "The local verifier observes your payment and authorizes a prefunded relayer to mint. The operator knows the checkout relationship. Timing, fixed price and RPC metadata can also correlate activity.",
                    },
                    {
                      icon: KeyRound,
                      title: "Approval comes before action",
                      text: "Connecting proves account ownership only. Mint authorization and shielded spending require separate approval. A fee ceiling, stable payment reference and on-chain replay protection prevent accidental duplicate execution.",
                    },
                    {
                      icon: Info,
                      title: "A local prototype, with limits",
                      text: "This supports the existing local wallet only. Keys are protected by Windows file permissions, not a hardware wallet. Software running as your OS user could access them. Failed checkouts need manual recovery; automatic refunds are not implemented.",
                    },
                  ].map(({ icon: Icon, title, text }) => (
                    <article className="privacy-card" key={title}>
                      <Icon size={24} />
                      <h2>{title}</h2>
                      <p>{text}</p>
                    </article>
                  ))}
                </div>
              )}
              <footer className="page-footer">
                <span>
                  <ShieldCheck size={14} /> Local connection · No analytics ·
                  Testnets only
                </span>
                <span>Built around your choice.</span>
              </footer>
            </>
          )}
        </main>
      </div>
      {challenge && (
        <Dialog
          error={error}
          title="Verify your wallet"
          onClose={() => {
            if (!busy) setChallenge(null);
          }}
        >
          <div className="dialog-symbol">
            <KeyRound size={25} />
          </div>
          <p>
            Approve a local signature to prove that you control this Base
            Sepolia account. This does not spend funds or authorize a mint.
          </p>
          <pre className="challenge-message">{challenge.message}</pre>
          <p className="tiny">
            Signed on this computer by your user wallet. The relayer does not
            receive your private key.
          </p>
          <button
            className="primary full"
            disabled={busy}
            onClick={() =>
              task(async () => {
                await call("connect", { id: challenge.id, approved: true });
                setSession((s) => (s ? { ...s, connected: true } : null));
                setChallenge(null);
              })
            }
          >
            {busy ? "Verifying…" : "Approve connection signature"}{" "}
            <Check size={16} />
          </button>
        </Dialog>
      )}
      {modal === "order" && data && (
        <Dialog
          error={error}
          title="Approve mint authorization"
          onClose={() => {
            if (!busy) setModal(null);
          }}
        >
          <p>
            Sign one fixed order for <strong>ZecOne Phase 0</strong>. This
            signature permits the trusted relayer to mint exactly one NFT after
            a verified payment.
          </p>
          <dl className="review-list">
            <div>
              <dt>Source → destination</dt>
              <dd>Zcash Testnet → Base Sepolia</dd>
            </div>
            <div>
              <dt>Payment</dt>
              <dd>0.01 TAZ</dd>
            </div>
            <div>
              <dt>Signature fee</dt>
              <dd>None · payment fee reviewed next</dd>
            </div>
            <div>
              <dt>Receive at</dt>
              <dd className="mono break">{data.address}</dd>
            </div>
            <div>
              <dt>Contract</dt>
              <dd className="mono break">{data.contract}</dd>
            </div>
            <div>
              <dt>Order validity</dt>
              <dd>24 hours · one mint</dd>
            </div>
          </dl>
          <div className="notice">
            <ShieldCheck size={18} />
            <p>
              Your Base ownership is public. The operator can connect this order
              to your shielded payment. Base gas is paid by the prefunded
              relayer.
            </p>
          </div>
          <button
            className="primary full"
            disabled={busy || !!activeCheckout}
            onClick={() =>
              task(async () => {
                const c = await call("checkout", {
                  id:
                    createId.current ??
                    (createId.current = crypto.randomUUID()),
                  approved: true,
                });
                setSelected(c.id);
                await load();
                setModal(null);
                createId.current = null;
              })
            }
          >
            {busy ? "Creating your order…" : "Approve & sign order"}{" "}
            <ArrowRight size={16} />
          </button>
          {activeCheckout && (
            <p role="status">
              Finish your existing checkout before creating another.
            </p>
          )}
        </Dialog>
      )}
      {modal === "pay" && checkout?.quote && data && (
        <Dialog
          error={error}
          title={
            checkout.kind === "action"
              ? "Approve ZEC-funded action payment"
              : "Approve shielded payment"
          }
          onClose={() => {
            if (!busy) setModal(null);
          }}
        >
          <div className="approval-amount">
            {units(checkout.quote.totalZatoshis)} <span>TAZ</span>
          </div>
          <p className="muted center">Total leaving your shielded wallet</p>
          <dl className="review-list">
            <div>
              <dt>Payment</dt>
              <dd>0.01 TAZ</dd>
            </div>
            <div>
              <dt>Maximum network fee</dt>
              <dd>{units(checkout.quote.feeZatoshis)} TAZ</dd>
            </div>
            <div>
              <dt>Source → destination</dt>
              <dd>Zcash Testnet → Base Sepolia</dd>
            </div>
            <div>
              <dt>
                {checkout.kind === "action"
                  ? "Action account"
                  : "NFT recipient"}
              </dt>
              <dd className="mono break">{data.address}</dd>
            </div>
            <div>
              <dt>
                {checkout.kind === "action"
                  ? "Allowlisted action contract"
                  : "NFT contract"}
              </dt>
              <dd className="mono break">
                {checkout.kind === "action"
                  ? checkout.actionTarget
                  : data.contract}
              </dd>
            </div>
            <div>
              <dt>Base gas</dt>
              <dd>Covered by trusted relayer</dd>
            </div>
            <div>
              <dt>Expected result</dt>
              <dd>
                {checkout.kind === "action"
                  ? "One fixed test action after 10 Zcash confirmations; no NFT"
                  : "One NFT after 10 Zcash confirmations"}
              </dd>
            </div>
          </dl>
          <div className="notice">
            <Info size={18} />
            <p>
              This sends a real testnet payment. The operator sees this checkout
              association; your Base NFT is public. Sending cannot be undone.
              Failed settlements require manual review, with no automatic
              refund.
            </p>
          </div>
          <p className="tiny">
            Fee approval expires at{" "}
            {new Date(checkout.quote.expires).toLocaleTimeString()}. A higher
            fee cannot be silently charged.
          </p>
          <button
            className="primary full"
            disabled={busy || Date.now() >= checkout.quote.expires}
            onClick={() =>
              task(async () => {
                await call("pay", {
                  id: checkout.id,
                  quoteId: checkout.quote!.id,
                  approved: true,
                });
                setModal(null);
                await load();
              })
            }
          >
            {busy ? "Saving approval…" : "Approve & send test ZEC"}{" "}
            <ShieldCheck size={17} />
          </button>
        </Dialog>
      )}
    </div>
  );
}
function CheckoutProgress({ c }: { c: CheckoutView }) {
  const steps =
    c.kind === "action"
      ? [
          "Payment approved",
          "10 confirmations",
          "Payment settled",
          "Fixed action",
          "Confirmed",
        ]
      : [
          "Payment approved",
          "10 confirmations",
          "Payment settled",
          "Base mint",
          "NFT received",
        ];
  let index =
    c.status === "Completed"
      ? 5
      : c.status === "Executing"
        ? 3
        : c.status === "Settled"
          ? 3
          : c.confirmations >= 10
            ? 2
            : c.paymentTx || c.stage === "sending"
              ? 1
              : 0;
  return (
    <div className="progress-section" aria-live="polite">
      <div className="progress-title">
        <strong>{c.status}</strong>
        <span>
          {c.confirmations} / {c.requiredConfirmations} confirmations
        </span>
      </div>
      <p className="tiny">Received {units(c.receivedZatoshis)} / 0.01 TAZ</p>
      <div
        className="progress-track"
        role="progressbar"
        aria-label="Zcash payment confirmations"
        aria-valuemin={0}
        aria-valuemax={10}
        aria-valuenow={Math.min(c.confirmations, 10)}
      >
        <span style={{ width: `${Math.min(c.confirmations, 10) * 10}%` }} />
      </div>
      <ol className="steps">
        {steps.map((s, i) => (
          <li key={s} className={index > i ? "done" : ""}>
            <span>{index > i ? <Check size={12} /> : i + 1}</span>
            {s}
          </li>
        ))}
      </ol>
    </div>
  );
}
function Activity({
  data,
  compact = false,
}: {
  data: Dashboard;
  compact?: boolean;
}) {
  const z = (data.zcash?.history ?? []).map((t) => ({
    key: t.txid,
    title:
      BigInt(t.deltaZatoshis) > 0n
        ? "Received shielded Zcash"
        : "Shielded payment",
    network: "Zcash Testnet",
    amount: `${BigInt(t.deltaZatoshis) > 0n ? "+" : ""}${units(t.deltaZatoshis)} TAZ`,
    status: t.expired
      ? "Expired · unmined"
      : t.height
        ? `${Math.max(0, (data.zcash?.tip ?? 0) - t.height + 1)} confirmations`
        : "Pending confirmation",
    private: true,
    failed: t.expired,
    hash: t.txid,
    incoming: BigInt(t.deltaZatoshis) > 0n,
  }));
  const b = data.baseActivity.map((t) => ({
    key: t.hash,
    title: t.kind === "action" ? "ZecOne sponsored action" : "ZecOne NFT mint",
    network: "Base Sepolia",
    amount: t.kind === "action" ? "1 fixed action" : "1 NFT",
    status: t.status,
    private: false,
    failed: t.status === "Reverted",
    hash: t.hash,
    incoming: true,
  }));
  const rows = compact
    ? [...b.slice(-1), ...z.slice(0, 2)]
    : [...b.reverse(), ...z];
  return (
    <div className="activity-list">
      {rows.length ? (
        rows.map((r) => (
          <div className="activity-row" key={r.key}>
            <div className={`activity-icon ${r.private ? "" : "blue"}`}>
              {r.private ? (
                r.incoming ? (
                  <ArrowDownLeft size={20} />
                ) : (
                  <ArrowUpRight size={20} />
                )
              ) : (
                <Grid2X2 size={20} />
              )}
            </div>
            <div className="activity-name">
              <strong>{r.title}</strong>
              <span>
                {r.network} <span className="separator">·</span>{" "}
                {r.private ? "Shielded" : "Public"}
              </span>
            </div>
            <div className="activity-status">
              <span className={r.failed ? "status-failed" : ""}>
                {r.status}
              </span>
              <span className="mono">{short(r.hash, 8)}</span>
            </div>
            <div className="activity-amount">
              <strong>{r.failed ? "—" : r.amount}</strong>
              {!r.private && (
                <a
                  href={`https://sepolia.basescan.org/tx/${r.hash}`}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="View NFT mint transaction"
                >
                  <ArrowUpRight size={15} />
                </a>
              )}
            </div>
          </div>
        ))
      ) : (
        <p className="empty">No tracked transactions available yet.</p>
      )}
    </div>
  );
}
