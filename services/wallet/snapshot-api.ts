import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError, requireLocal, type Sessions } from "./security.ts";
import {
  CheckoutScopes,
  checkoutBrowserView,
  listingBrowserView,
  dashboardBrowserView,
  INSPECTION_WARNING,
  PrivacyDiagnostics,
  privacyError,
} from "./privacy.ts";
export function snapshotApi(sessions: Sessions, snapshot: any) {
  let attempts = 0;
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
      const path = req.url?.split("?")[0],
        mutation = req.method !== "GET";
      requireLocal(req.headers as Record<string, string | undefined>, mutation);
      if (req.url?.includes("?"))
        throw new ApiError(400, "No query parameters.");
      if (req.method === "GET" && path === "/api/health")
        return send(200, { ok: true, readOnly: true });
      if (req.method === "POST" && path === "/api/pair") {
        if (++attempts > 5)
          throw new ApiError(
            429,
            "Restart the snapshot viewer to issue a new pairing token.",
          );
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 1024) throw new ApiError(413, "Request too large");
        }
        const { cookie, session } = sessions.pair(JSON.parse(body).token);
        res.setHeader(
          "Set-Cookie",
          `zecone_session=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`,
        );
        return send(200, {
          csrf: session.csrf,
          connected: false,
          readOnly: true,
        });
      }
      const session = sessions.get(req.headers.cookie);
      if (mutation) {
        sessions.csrf(
          session,
          req.headers["x-zecone-csrf"] as string | undefined,
        );
        if (req.method === "POST" && path === "/api/logout") {
          scopes.forget(session);
          sessions.disconnect(session);
          return send(200, { ok: true });
        }
        if (req.method === "POST" && path === "/api/checkouts/inspect") {
          let raw = "";
          for await (const c of req) {
            raw += c;
            if (raw.length > 1024)
              throw new ApiError(413, "Request too large.");
          }
          const b = JSON.parse(raw);
          if (b.reveal !== true || b.acceptPrivacy !== true)
            throw new ApiError(403, "Explicit private inspection required.");
          const id = scopes.resolve(session, b.id, b.kind);
          // Pairing is a capability to this one operator-selected snapshot,
          // never proof of spending-key ownership or access to another profile.
          const row = snapshot.checkouts.find(
            (r: any) => r.id === id && r.kind === b.kind,
          );
          if (!row) throw new ApiError(404, "Unknown checkout.");
          return send(200, {
            paymentTx: row.paymentTx ?? null,
            privacy: INSPECTION_WARNING,
          });
        }
        throw new ApiError(
          403,
          "Phase 6C read-only snapshot: signing, payments, approvals, retries and broadcasts are disabled.",
        );
      }
      const routes: Record<string, unknown> = {
        "/api/session": {
          csrf: session.csrf,
          connected: false,
          readOnly: true,
        },
        "/api/dashboard": {
          ...dashboardBrowserView(snapshot.dashboard, (id) =>
            scopes.handle(session, "mint", id),
          ),
          readOnlyNotice: `Historical snapshot captured ${snapshot.capturedAt}. No Zcash sync performed. Original wallet quarantined: do not spend. SDK spendable values are diagnostic only. Saved app grants are historical, not active connections. Signing and all broadcasts disabled. Account ownership is not verified by this viewer.`,
        },
        "/api/checkouts": {
          checkouts: (snapshot.checkouts ?? []).map((r: any) =>
            checkoutBrowserView(r, scopes.handle(session, r.kind, r.id)),
          ),
          ...scopes.metadata(session),
          liveRefundsEnabled: false,
          readOnly: true,
        },
        "/api/networks": {
          networks: (snapshot.networks ?? []).map((r: any) => ({
            chainId: r.chainId,
            name: r.name,
            address: r.address,
            explorer: r.explorer,
            health: r.health,
            wei: r.wei,
            checkedAt: r.checkedAt,
            configured: r.configured,
            nftStatus: r.nftStatus,
            tokenIndexing: r.tokenIndexing,
            nftIndexing: r.nftIndexing,
            tokens:
              r.tokens?.map((t: any) => ({
                address: t.address,
                symbol: t.symbol,
                decimals: t.decimals,
                balance: t.balance,
              })) ?? null,
            nfts:
              r.nfts?.map((n: any) => ({
                address: n.address,
                tokenId: n.tokenId,
              })) ?? null,
          })),
          readOnly: true,
        },
        "/api/dapps/list": {
          connections: (snapshot.dapps?.connections ?? []).map((r: any) => ({
            origin: r.origin,
            created: r.created,
          })),
          requests: (snapshot.dapps?.requests ?? []).map((r: any) => ({
            origin: r.origin,
            method: r.method,
            state: r.state,
            txHash: r.txHash,
            created: r.created,
          })),
          historical: true,
          readOnly: true,
        },
        "/api/purchases/list": {
          purchases: (snapshot.lists.purchase ?? []).map((r: any) =>
            listingBrowserView(r, scopes.handle(session, "purchase", r.id)),
          ),
        },
        "/api/swaps/list": {
          swaps: (snapshot.lists.swap ?? []).map((r: any) =>
            listingBrowserView(r, scopes.handle(session, "swap", r.id)),
          ),
        },
        "/api/seaport/list": {
          purchases: (snapshot.lists.seaport ?? []).map((r: any) =>
            listingBrowserView(r, scopes.handle(session, "seaport", r.id)),
          ),
        },
        "/api/privacy/diagnostics": diagnostics.export(),
      };
      if (!path || !Object.hasOwn(routes, path))
        throw new ApiError(404, "Unavailable in snapshot viewer");
      return send(200, routes[path]);
    } catch (e) {
      diagnostics.record(
        e instanceof ApiError && e.status === 403
          ? "ACCESS_DENIED"
          : "INVALID_REQUEST",
      );
      const safe = privacyError(e);
      send(safe.status, {
        error:
          e instanceof ApiError && e.message.startsWith("Phase 6C read-only")
            ? "Phase 6C read-only snapshot: spending and mutation routes are disabled."
            : safe.body.error,
      });
    }
  };
}
