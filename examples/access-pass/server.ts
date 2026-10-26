// ZecOne Access Pass: reference merchant DApp.
//
// A merchant sells 30-day access to a members-only page. Customers pay with
// shielded ZEC through ZecOne; the merchant is paid ETH on Base.
//
// This file is the MERCHANT BACKEND. It shows the complete integration:
//   1. Onboarding: the merchant connects a Base wallet in the browser and signs
//      ZecOne's EIP-4361 challenge. This server relays it and stores the issued
//      API key and webhook secret server-side (.state/access-pass.json).
//   2. Orders: @zecone/sdk creates a payment per order (idempotent by order id).
//   3. Checkout: the browser gets only the read-only checkout token and embeds
//      ZecOne's checkout (iframe) or links to the hosted page.
//   4. Fulfilment: content unlocks ONLY after a signature-verified
//      payment.completed webhook AND a server-side re-read of the payment.
//
// Nothing in the browser can mark an order paid. In demo mode ZecOne's own
// server replays recorded mainnet evidence; no funds move.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { ZecOne, ZecOneError, constructEvent, type Payment } from "../../sdk/dist/index.js";

const PORT = Number(process.env.ACCESS_PASS_PORT ?? 4333);
const HOST = process.env.ACCESS_PASS_HOST ?? "127.0.0.1";
const ZECONE_URL = (process.env.ZECONE_BASE_URL ?? "http://127.0.0.1:4321").replace(/\/+$/, "");
const ZECONE_WEB = (process.env.ZECONE_WEB_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const PUBLIC_URL = (process.env.ACCESS_PASS_PUBLIC_URL ?? `http://${HOST}:${PORT}`).replace(/\/+$/, "");
const STATE_FILE = resolve(process.env.ACCESS_PASS_STATE ?? ".state/access-pass.json");
const PRICE_USD = process.env.ACCESS_PASS_PRICE_USD ?? "1.00";
const PRODUCT = "Access Pass · 30 days";

type Order = {
  id: string;
  paymentId: string;
  buyerHash: string;
  amountUsd: string;
  createdAt: number;
  status: "pending" | "paid" | "expired" | "failed";
  paidAt: number | null;
  verifiedBy: string | null;
};
type State = {
  merchant: { id: string; name: string; payoutAddress: string } | null;
  apiKey: string | null;
  webhookSecret: string | null;
  orders: Record<string, Order>;
  processedEvents: string[];
};

let state: State = loadState();
function loadState(): State {
  if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  return { merchant: null, apiKey: process.env.ZECONE_API_KEY ?? null, webhookSecret: process.env.ZECONE_WEBHOOK_SECRET ?? null, orders: {}, processedEvents: [] };
}
let saving = Promise.resolve();
function save(): Promise<void> {
  saving = saving.then(async () => {
    await mkdir(dirname(STATE_FILE), { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(tmp, STATE_FILE);
  });
  return saving;
}

const client = () => (state.apiKey ? new ZecOne({ apiKey: state.apiKey, baseUrl: ZECONE_URL }) : null);

// ---------------------------------------------------------------------------
const send = (res: ServerResponse, status: number, v: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(v));
};
const fail = (res: ServerResponse, status: number, code: string, message: string) => send(res, status, { error: { code, message } });

async function rawBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await rawBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function cookies(req: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    (req.headers.cookie ?? "")
      .split(";")
      .map((c) => c.trim().split("="))
      .filter((p) => p.length === 2)
      .map(([k, v]) => [k, decodeURIComponent(v)]),
  );
}
const hash = (s: string) => Buffer.from(s).toString("base64url");

/** The buyer proves ownership of an order with an httpOnly cookie set when it was created. */
function ownedOrder(req: IncomingMessage, orderId: string | null): Order | null {
  if (!orderId) return null;
  const order = state.orders[orderId];
  const secret = cookies(req)[`ap_${orderId.slice(0, 8)}`];
  if (!order || !secret) return null;
  const a = Buffer.from(hash(secret));
  const b = Buffer.from(order.buyerHash);
  return a.length === b.length && timingSafeEqual(a, b) ? order : null;
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return !!origin && new URL(origin).host === req.headers.host;
}

/**
 * Server-side settlement check: the order is paid only if ZecOne's API (called
 * with our secret key) says COMPLETED and the payment matches this order.
 */
async function confirmSettlement(order: Order, verifiedBy: string): Promise<Payment | null> {
  const z = client();
  if (!z) return null;
  const p = await z.payments.retrieve(order.paymentId);
  const matches =
    p.state === "COMPLETED" &&
    p.metadata?.orderId === order.id &&
    p.request.amountUsd === order.amountUsd &&
    p.request.recipient.toLowerCase() === state.merchant?.payoutAddress.toLowerCase();
  if (!matches) return null;
  if (order.status !== "paid") {
    order.status = "paid";
    order.paidAt = Math.floor(Date.now() / 1000);
    order.verifiedBy = verifiedBy;
    await save();
  }
  return p;
}

// ---------------------------------------------------------------------------
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  const url = new URL(req.url ?? "/", PUBLIC_URL);
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && (path === "/" || path === "/app.js")) {
    const file = path === "/" ? "index.html" : "app.js";
    res.writeHead(200, {
      "Content-Type": path === "/" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
      "Content-Security-Policy": `default-src 'self'; frame-src ${ZECONE_WEB}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'`,
    });
    res.end(await readFile(new URL(`./${file}`, import.meta.url)));
    return;
  }

  if (path === "/api/config" && method === "GET") {
    return send(res, 200, {
      service: "zecone-access-pass",
      pid: process.pid,
      zeconeApi: ZECONE_URL,
      configured: !!(state.apiKey && state.merchant),
      webhookConfigured: !!state.webhookSecret,
      merchant: state.merchant,
      product: { name: PRODUCT, amountUsd: PRICE_USD },
      zeconeWeb: ZECONE_WEB,
      mode: "demo",
    });
  }

  // ---- 1. merchant onboarding (wallet ownership proof relayed to ZecOne) ----
  if (path === "/api/setup/challenge" && method === "POST") {
    if (!sameOrigin(req)) return fail(res, 403, "forbidden", "cross-origin request");
    const body = await jsonBody(req);
    try {
      const challenge = await ZecOne.onboarding.challenge(ZECONE_URL, {
        address: String(body.address ?? ""),
        chainId: Number(body.chainId) === 84532 ? 84532 : 8453,
        domain: req.headers.host ?? `${HOST}:${PORT}`,
        uri: `${PUBLIC_URL}/`,
      });
      return send(res, 201, { message: challenge.message });
    } catch (e) {
      const z = e as ZecOneError;
      return fail(res, z.status || 502, z.code ?? "zecone_error", z.message);
    }
  }

  if (path === "/api/setup/verify" && method === "POST") {
    if (!sameOrigin(req)) return fail(res, 403, "forbidden", "cross-origin request");
    const body = await jsonBody(req);
    try {
      const r = await ZecOne.onboarding.verify(ZECONE_URL, {
        message: String(body.message ?? ""),
        signature: String(body.signature ?? ""),
        name: "Access Pass",
      });
      let apiKey = r.apiKey;
      if (!apiKey) {
        // Existing ZecOne merchant (e.g. re-running setup): mint a fresh key for this
        // server using the wallet-verified session. Old keys stay valid.
        const k = await fetch(`${ZECONE_URL}/api/v1/merchant/keys`, {
          method: "POST",
          headers: { Authorization: `Bearer ${r.session.token}`, "Content-Type": "application/json" },
          body: "{}",
        }).then((x) => x.json() as Promise<{ apiKey?: string }>);
        apiKey = k.apiKey ?? null;
      }
      if (!apiKey) return fail(res, 502, "no_key", "ZecOne did not issue an API key");
      state.apiKey = apiKey;
      state.merchant = { id: r.merchant.id, name: r.merchant.name, payoutAddress: r.merchant.payoutAddress ?? "" };
      // 2. Register our webhook endpoint; keep the signing secret server-side.
      const wh = await new ZecOne({ apiKey, baseUrl: ZECONE_URL }).webhooks.register(`${PUBLIC_URL}/webhooks/zecone`);
      state.webhookSecret = wh.secret;
      await save();
      return send(res, 200, { merchant: state.merchant, webhookConfigured: true });
    } catch (e) {
      const z = e as ZecOneError;
      return fail(res, z.status || 502, z.code ?? "zecone_error", z.message);
    }
  }

  // ---- 2. orders ----
  if (path === "/api/orders" && method === "POST") {
    if (!sameOrigin(req)) return fail(res, 403, "forbidden", "cross-origin request");
    const z = client();
    if (!z || !state.merchant) return fail(res, 409, "not_configured", "Merchant setup is not complete.");
    const orderId = randomUUID();
    try {
      const payment = await z.payments.create({
        amountUsd: PRICE_USD,
        description: PRODUCT,
        metadata: { orderId, product: "access-pass" },
        idempotencyKey: `access-pass:${orderId}`,
      });
      const buyerSecret = randomBytes(24).toString("base64url");
      state.orders[orderId] = {
        id: orderId,
        paymentId: payment.id,
        buyerHash: hash(buyerSecret),
        amountUsd: PRICE_USD,
        createdAt: Math.floor(Date.now() / 1000),
        status: "pending",
        paidAt: null,
        verifiedBy: null,
      };
      await save();
      return send(
        res,
        201,
        {
          orderId,
          paymentId: payment.id,
          // Browser-safe: read-only checkout capability + links. No API key.
          checkoutToken: payment.checkoutToken,
          hostedUrl: `${ZECONE_WEB}/pay/${payment.id}?t=${payment.checkoutToken}`,
          embedUrl: `${ZECONE_WEB}/embed/${payment.id}?t=${payment.checkoutToken}`,
          zecAmount: payment.quote?.zecAmount,
          expiresAt: payment.expiresAt,
        },
        { "Set-Cookie": `ap_${orderId.slice(0, 8)}=${buyerSecret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` },
      );
    } catch (e) {
      const err = e as ZecOneError;
      const friendly =
        err.code === "checkout_busy"
          ? "Another customer is mid-checkout. ZecOne supports one active checkout at a time. Try again in a few seconds."
          : err.message;
      return fail(res, err.status || 502, err.code ?? "zecone_error", friendly);
    }
  }

  const om = /^\/api\/orders\/([0-9a-f-]{36})$/.exec(path);
  if (om && method === "GET") {
    const order = ownedOrder(req, om[1]);
    if (!order) return fail(res, 404, "not_found", "order not found");
    // Status for the progress UI comes from our server, which asks ZecOne.
    let paymentState: string | null = null;
    try {
      const p = await client()!.payments.retrieve(order.paymentId);
      paymentState = p.state;
      if (p.state === "EXPIRED" && order.status === "pending") {
        order.status = "expired";
        await save();
      }
    } catch {
      /* transient */
    }
    return send(res, 200, { orderId: order.id, status: order.status, paymentState, paidAt: order.paidAt, verifiedBy: order.verifiedBy });
  }

  // ---- 4. server-side entitlement ----
  if (path === "/api/content" && method === "GET") {
    const order = ownedOrder(req, url.searchParams.get("order"));
    if (!order) return fail(res, 404, "not_found", "order not found");
    if (order.status !== "paid") return send(res, 403, { unlocked: false, status: order.status });
    // Defence in depth: re-confirm with ZecOne before serving.
    const p = await confirmSettlement(order, order.verifiedBy ?? "webhook").catch(() => null);
    if (!p) return send(res, 403, { unlocked: false, status: "unverified" });
    return send(res, 200, {
      unlocked: true,
      content: {
        title: "Welcome to the members' room",
        body: "This page was unlocked by the Access Pass server after ZecOne's signed payment.completed webhook and a fresh API read both confirmed settlement.",
        evidence: p.evidenceKind === "recorded-mainnet-replay" ? "Demo: settlement references are a replay of recorded mainnet transactions." : "Live settlement.",
        payoutTx: p.payoutTxHash,
        validUntil: (order.paidAt ?? 0) + 30 * 24 * 3600,
      },
    });
  }

  // ---- 3. signed webhooks from ZecOne ----
  if (path === "/webhooks/zecone" && method === "POST") {
    const raw = await rawBody(req);
    if (!state.webhookSecret) return fail(res, 503, "not_configured", "no webhook secret");
    let event;
    try {
      event = constructEvent(raw, req.headers["x-zecone-signature"] as string | undefined, state.webhookSecret);
    } catch {
      return fail(res, 401, "invalid_signature", "signature verification failed");
    }
    if (state.processedEvents.includes(event.id)) return send(res, 200, { ok: true, duplicate: true });
    if (event.type === "payment.completed" && event.payment) {
      const order = Object.values(state.orders).find((o) => o.paymentId === event.payment!.id);
      if (order) {
        const confirmed = await confirmSettlement(order, `webhook:${event.id}`).catch(() => null);
        // 503 makes ZecOne retry the delivery with backoff.
        if (!confirmed) return fail(res, 503, "unconfirmed", "API did not confirm settlement yet; retry");
      }
    }
    if (event.type === "payment.expired" && event.payment) {
      const order = Object.values(state.orders).find((o) => o.paymentId === event.payment!.id);
      if (order && order.status === "pending") order.status = "expired";
    }
    state.processedEvents = [...state.processedEvents.slice(-500), event.id];
    await save();
    return send(res, 200, { ok: true });
  }

  fail(res, 404, "not_found", "not found");
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error("[access-pass]", e);
    if (!res.headersSent) fail(res, 500, "internal", "internal error");
  });
});
server.on("error", (e: NodeJS.ErrnoException) => {
  console.error(
    e.code === "EADDRINUSE"
      ? `[access-pass] port ${PORT} on ${HOST} is already in use. Stop the other process or set ACCESS_PASS_PORT (and ACCESS_PASS_PUBLIC_URL).`
      : `[access-pass] cannot listen on ${HOST}:${PORT}: ${e.message}`,
  );
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`[access-pass] ${PUBLIC_URL} (demo mode) · ZecOne API ${ZECONE_URL} · checkout UI ${ZECONE_WEB}`);
  console.log(`[access-pass] state: ${STATE_FILE} (API key + webhook secret stay here, server-side)`);
});
