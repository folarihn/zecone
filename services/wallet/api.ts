import { portfolio } from "../evm/portfolio.ts";
import { unifiedCheckouts } from "./checkouts.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError, requireLocal, Sessions } from "./security.ts";
import { uuid, type Engine } from "./engine.ts";
import type { Dapps } from "./dapps.ts";
import { RpcError, originOf } from "./dapp-policy.ts";
import type { Purchases } from "../marketplace/service.ts";
import type { Swaps } from "../swaps/service.ts";
import type { SeaportPurchases } from "../seaport/service.ts";
import type { OpenSeaPreviews } from "../opensea/service.ts";
import { DiscoveryError } from "../opensea/api.ts";
import { marketReferences } from "../pricing/service.ts";
import {
  CheckoutScopes,
  checkoutBrowserView,
  dashboardBrowserView,
  listingBrowserView,
  paymentInspection,
  PrivacyDiagnostics,
  privacyError,
  INSPECTION_WARNING,
} from "./privacy.ts";
type Backend = Pick<
  Engine,
  | "dashboard"
  | "refresh"
  | "challenge"
  | "connect"
  | "create"
  | "quote"
  | "pay"
  | "recheck"
  | "paymentRequest"
>;
export function api(
  sessions: Sessions,
  engine: Backend,
  dapps?: Dapps,
  purchases?: Purchases,
  swaps?: Swaps,
  seaport?: SeaportPurchases,
  opensea?: OpenSeaPreviews,
) {
  const attempts = new Map<string, { at: number; count: number }>();
  const scopes = new CheckoutScopes(sessions.now),
    diagnostics = new PrivacyDiagnostics();
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "private, no-store");
    const send = (status: number, data: unknown) => {
      res.statusCode = status;
      res.end(JSON.stringify(data));
    };
    try {
      const method = req.method ?? "",
        path = req.url?.split("?")[0],
        mutation = method !== "GET";
      requireLocal(req.headers as Record<string, string | undefined>, mutation);
      if (method === "GET" && path === "/api/health") {
        send(200, { ok: true });
        return;
      }
      if (!["GET", "POST"].includes(method))
        throw new ApiError(405, "Method not allowed.");
      let body: Record<string, unknown> = {};
      if (mutation) {
        let length = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          length += chunk.length;
          if (length > (path?.startsWith("/api/dapps/") ? 32768 : 8192))
            throw new ApiError(413, "Request too large.");
          chunks.push(chunk);
        }
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          throw new ApiError(400, "Invalid JSON.");
        }
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new ApiError(400, "Invalid request.");
      }
      if (method === "POST" && path === "/api/pair") {
        const key = "pair",
          a = attempts.get(key);
        const next =
          !a || Date.now() - a.at > 60000
            ? { at: Date.now(), count: 1 }
            : { ...a, count: a.count + 1 };
        attempts.set(key, next);
        if (next.count > 5)
          throw new ApiError(
            429,
            "Too many attempts. Wait one minute and reopen the launcher.",
          );
        const { cookie, session } = sessions.pair(body.token);
        res.setHeader(
          "Set-Cookie",
          `zecone_session=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`,
        );
        send(200, { csrf: session.csrf, connected: false });
        return;
      }
      const session = sessions.get(req.headers.cookie);
      const actionId = (kind: string, value: unknown = body.id) => {
        try {
          return uuid(scopes.resolve(session, value, kind));
        } catch {
          return uuid(value);
        } // Existing action results retain their original review IDs.
      };
      if (path?.startsWith("/api/checkouts") && req.url?.includes("?"))
        throw new ApiError(400, "No query parameters.");
      if (mutation) {
        sessions.csrf(
          session,
          req.headers["x-zecone-csrf"] as string | undefined,
        );
        const a = attempts.get(session.id),
          next =
            !a || Date.now() - a.at > 60000
              ? { at: Date.now(), count: 1 }
              : { ...a, count: a.count + 1 };
        attempts.set(session.id, next);
        if (next.count > (path?.startsWith("/api/dapps/") ? 200 : 40))
          throw new ApiError(429, "Too many requests. Please wait a minute.");
      }
      let data: unknown;
      if (
        method === "POST" &&
        ["/api/checkouts/payment-request", "/api/checkouts/inspect"].includes(
          path ?? "",
        )
      ) {
        if (!session.connected || body.reveal !== true)
          throw new ApiError(
            403,
            "Explicit local payment-address reveal required.",
          );
        const source =
          body.kind === "mint" || body.kind === "action"
            ? engine
            : body.kind === "purchase"
              ? purchases
              : body.kind === "swap"
                ? swaps
                : body.kind === "seaport"
                  ? seaport
                  : undefined;
        if (!source) throw new ApiError(400, "Unsupported checkout adapter");
        const id = scopes.resolve(session, body.id, body.kind);
        const owned =
          body.kind === "mint" || body.kind === "action"
            ? (engine as Engine).app?.get(id)?.quote_session === session.id
            : (source as Purchases).store?.row(id)?.session === session.id;
        if (!owned) throw new ApiError(403, "Checkout ownership mismatch.");
        if (path === "/api/checkouts/inspect") {
          if (body.acceptPrivacy !== true)
            throw new ApiError(
              403,
              "Explicit privacy acknowledgement required.",
            );
          const row =
            body.kind === "mint" || body.kind === "action"
              ? engine.dashboard().checkouts.find((r) => r.id === id)
              : (source as Purchases).list().find((r) => r.id === id);
          if (!row) throw new ApiError(404, "Unknown checkout.");
          send(200, {
            paymentTx: row.paymentTx ?? null,
            privacy: INSPECTION_WARNING,
          });
          return;
        }
        send(200, paymentInspection(source.paymentRequest(session, uuid(id))));
        return;
      }
      if (method === "GET" && path === "/api/checkouts") {
        if (!session.connected)
          throw new ApiError(403, "Verify wallet ownership first.");
        const dashboard = engine.dashboard();
        send(200, {
          checkouts: unifiedCheckouts(
            [
              {
                kind: "mint",
                rows: dashboard.checkouts.filter((r) => r.kind !== "action"),
              },
              {
                kind: "action",
                rows: dashboard.checkouts.filter((r) => r.kind === "action"),
              },
              { kind: "purchase", rows: purchases?.list() ?? [] },
              { kind: "swap", rows: swaps?.list() ?? [] },
              { kind: "seaport", rows: seaport?.list() ?? [] },
            ],
            dashboard.address,
          ).map((r) =>
            checkoutBrowserView(r, scopes.handle(session, r.kind, r.id)),
          ),
          ...scopes.metadata(session),
          liveRefundsEnabled: false,
        });
        return;
      }
      if (method === "GET" && path === "/api/privacy/diagnostics") {
        if (!session.connected)
          throw new ApiError(403, "Verify ownership first.");
        send(200, diagnostics.export());
        return;
      }
      if (method === "GET" && path === "/api/reference-prices") {
        if (!session.connected)
          throw new ApiError(403, "Verify wallet ownership first.");
        try {
          send(200, {
            referenceOnly: true,
            changesApprovedPayment: false,
            ...(await marketReferences()),
          });
        } catch {
          send(503, {
            error:
              "Market references unavailable or stale. No payment terms changed.",
          });
        }
        return;
      }
      if (path?.startsWith("/api/opensea/") && opensea) {
        if (!session.connected)
          throw new ApiError(403, "Verify wallet ownership first.");
        try {
          if (method === "POST" && path === "/api/opensea/listings")
            data = await opensea.catalog(body.collection);
          else if (method === "POST" && path === "/api/opensea/preview")
            data = await opensea.preview(body.collection, body.orderHash);
          else if (method === "POST" && path === "/api/opensea/import")
            data = await opensea.importListing(body.url);
          else
            throw new ApiError(404, "Read-only OpenSea operation unavailable.");
        } catch (e) {
          if (e instanceof DiscoveryError) throw new ApiError(422, e.message);
          throw e;
        }
        send(200, data);
        return;
      }
      if (path?.startsWith("/api/seaport/") && seaport) {
        if (!session.connected)
          throw new ApiError(403, "Verify wallet ownership first.");
        switch (`${method} ${path}`) {
          case "GET /api/seaport/catalog":
            data = await seaport.catalog();
            break;
          case "GET /api/seaport/list":
            data = {
              purchases: seaport
                .list()
                .map((r) =>
                  listingBrowserView(
                    r,
                    scopes.handle(session, "seaport", r.id),
                  ),
                ),
            };
            break;
          case "POST /api/seaport/quote":
            data = await seaport.quote(session, body);
            break;
          case "POST /api/seaport/approve":
            if (body.approved !== true)
              throw new ApiError(400, "Exact Seaport approval required.");
            data = await seaport.approve(session, actionId("seaport"));
            break;
          case "POST /api/seaport/cancel": {
            const r = seaport.row(actionId("seaport"));
            if (r.session !== session.id)
              throw new ApiError(403, "Session mismatch");
            seaport.cancelDraft(r.id);
            data = { cancelled: true };
            break;
          }
          case "POST /api/seaport/fee":
            data = await seaport.fee(session, actionId("seaport"));
            break;
          case "POST /api/seaport/pay":
            data = await seaport.pay(
              session,
              actionId("seaport"),
              uuid(body.quoteId),
              body.approved,
            );
            break;
          case "POST /api/seaport/recheck":
            data = await seaport.reconcile(session, actionId("seaport"));
            break;
          default:
            throw new ApiError(404, "Seaport operation unavailable.");
        }
        send(200, data);
        return;
      }
      if (path?.startsWith("/api/swaps/") && swaps) {
        if (!session.connected)
          throw new ApiError(403, "Verify wallet ownership first.");
        switch (`${method} ${path}`) {
          case "GET /api/swaps/assets":
            data = await swaps.assets();
            break;
          case "GET /api/swaps/list":
            data = {
              swaps: swaps
                .list()
                .map((r) =>
                  listingBrowserView(r, scopes.handle(session, "swap", r.id)),
                ),
            };
            break;
          case "POST /api/swaps/quote":
            data = await swaps.quote(session, body);
            break;
          case "POST /api/swaps/approve":
            if (body.approved !== true)
              throw new ApiError(400, "Exact swap approval required.");
            data = await swaps.approve(session, actionId("swap"));
            break;
          case "POST /api/swaps/cancel": {
            const r = swaps.row(actionId("swap"));
            if (r.session !== session.id)
              throw new ApiError(403, "Session mismatch");
            swaps.cancelDraft(r.id);
            data = { cancelled: true };
            break;
          }
          case "POST /api/swaps/fee":
            data = await swaps.fee(session, actionId("swap"));
            break;
          case "POST /api/swaps/pay":
            data = await swaps.pay(
              session,
              actionId("swap"),
              uuid(body.quoteId),
              body.approved,
            );
            break;
          case "POST /api/swaps/recheck":
            data = await swaps.reconcile(session, actionId("swap"));
            break;
          default:
            throw new ApiError(404, "Swap operation unavailable.");
        }
        send(200, data);
        return;
      }
      if (path?.startsWith("/api/purchases/") && purchases) {
        if (!session.connected)
          throw new ApiError(403, "Verify wallet ownership first.");
        switch (`${method} ${path}`) {
          case "GET /api/purchases/list":
            data = {
              purchases: purchases
                .list()
                .map((r) =>
                  listingBrowserView(
                    r,
                    scopes.handle(session, "purchase", r.id),
                  ),
                ),
            };
            break;
          case "POST /api/purchases/fee":
            data = await purchases.fee(session, actionId("purchase"));
            break;
          case "POST /api/purchases/pay":
            data = await purchases.pay(
              session,
              actionId("purchase"),
              uuid(body.quoteId),
              body.approved,
            );
            break;
          case "POST /api/purchases/recheck":
            data = await purchases.reconcile(session, actionId("purchase"));
            break;
          default:
            throw new ApiError(404, "Purchase operation unavailable.");
        }
        send(200, data);
        return;
      }
      if (path?.startsWith("/api/dapps/") && dapps) {
        if (!session.connected)
          throw new ApiError(403, "Verify wallet ownership first.");
        if (
          [
            "/api/dapps/intent-quote",
            "/api/dapps/intent-quote-review",
            "/api/dapps/intent-checkout-preview",
            "/api/dapps/intent-checkout-status",
          ].includes(path)
        ) {
          const allowed =
            path.endsWith("intent-quote") ||
            path.endsWith("intent-checkout-status")
              ? ["id"]
              : ["id", "quoteId", "digest", "approved"];
          if (
            req.url?.includes("?") ||
            Object.keys(body).some((k) => !allowed.includes(k))
          )
            throw new ApiError(400, "Exact local preview fields required.");
        }
        switch (`${method} ${path}`) {
          case "POST /api/dapps/intent-quote":
            data = await dapps.quoteIntent(
              () => sessions.get(req.headers.cookie),
              uuid(body.id),
            );
            break;
          case "POST /api/dapps/intent-quote-review":
            data = dapps.reviewIntentQuote(
              () => sessions.get(req.headers.cookie),
              uuid(body.id),
              uuid(body.quoteId),
              String(body.digest),
              body.approved,
            );
            break;
          case "POST /api/dapps/intent-checkout-preview":
            data = await dapps.createIntentCheckoutPreview(
              () => sessions.get(req.headers.cookie),
              uuid(body.id),
              uuid(body.quoteId),
              String(body.digest),
              body.approved,
            );
            break;
          case "POST /api/dapps/intent-checkout-status":
            data = dapps.intentCheckoutStatus(
              () => sessions.get(req.headers.cookie),
              uuid(body.id),
            );
            break;
          case "GET /api/dapps/list":
            data = dapps.list();
            break;
          case "POST /api/dapps/request":
            data = await dapps.request(session, body);
            break;
          case "POST /api/dapps/status":
            data = dapps.status(session, uuid(body.id));
            break;
          case "POST /api/dapps/approve":
            data = await dapps.approve(
              session,
              uuid(body.id),
              String(body.reviewHash),
              body.approved,
            );
            break;
          case "POST /api/dapps/revoke":
            dapps.revoke(originOf(body.origin));
            data = { revoked: true };
            break;
          default:
            throw new ApiError(404, "Operation not available.");
        }
        send(200, data);
        return;
      }
      switch (`${method} ${path}`) {
        case "GET /api/session":
          data = { csrf: session.csrf, connected: !!session.connected };
          break;
        case "GET /api/networks":
          if (!session.connected || !dapps)
            throw new ApiError(403, "Verify wallet ownership first.");
          data = { networks: await portfolio(dapps.user) };
          break;
        case "GET /api/dashboard":
          data = dashboardBrowserView(
            engine.dashboard(),
            (id) => scopes.handle(session, "mint", id),
            (id) => scopes.handle(session, "mint-quote", id),
          );
          break;
        case "POST /api/refresh":
          engine.refresh();
          data = { refreshing: true };
          break;
        case "POST /api/challenge":
          data = engine.challenge(session);
          break;
        case "POST /api/connect":
          data = await engine.connect(session, uuid(body.id), body.approved);
          break;
        case "POST /api/action-draft":
          data = (engine as Engine).actionDraft(session);
          break;
        case "POST /api/action-approve":
          data = await (engine as Engine).createAction(
            session,
            uuid(body.id),
            String(body.digest),
            body.approved,
          );
          break;
        case "POST /api/checkout":
          data = await engine.create(session, uuid(body.id), body.approved);
          break;
        case "POST /api/quote":
          data = await engine.quote(session, actionId("mint"));
          break;
        case "POST /api/pay":
          data = engine.pay(
            session,
            actionId("mint"),
            actionId("mint-quote", body.quoteId),
            body.approved,
          );
          break;
        case "POST /api/recheck":
          data = await engine.recheck(session, actionId("mint"));
          engine.refresh();
          break;
        case "POST /api/logout":
          scopes.forget(session);
          sessions.disconnect(session);
          res.setHeader(
            "Set-Cookie",
            "zecone_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
          );
          data = { locked: true };
          break;
        default:
          throw new ApiError(404, "Operation not available.");
      }
      send(200, data);
    } catch (error) {
      diagnostics.record(
        error instanceof ApiError && error.status === 403
          ? "ACCESS_DENIED"
          : "INVALID_REQUEST",
      );
      const safe = privacyError(error);
      send(
        error instanceof RpcError
          ? 400
          : error instanceof ApiError
            ? safe.status
            : 503,
        {
          code: error instanceof RpcError ? error.code : undefined,
          error: safe.body.error,
        },
      );
    }
  };
}
