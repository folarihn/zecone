import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError, requireLocal, type Sessions } from "./security.ts";
export function snapshotApi(sessions: Sessions, snapshot: any) {
  let attempts = 0;
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
          sessions.disconnect(session);
          return send(200, { ok: true });
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
          ...snapshot.dashboard,
          readOnlyNotice: `Historical snapshot captured ${snapshot.capturedAt}. No Zcash sync performed. Original wallet quarantined: do not spend. SDK spendable values are diagnostic only. Saved app grants are historical, not active connections. Signing and all broadcasts disabled. Account ownership is not verified by this viewer.`,
        },
        "/api/checkouts": {
          checkouts: snapshot.checkouts,
          liveRefundsEnabled: false,
          readOnly: true,
        },
        "/api/networks": { networks: snapshot.networks, readOnly: true },
        "/api/dapps/list": { ...snapshot.dapps, readOnly: true },
        "/api/purchases/list": { purchases: snapshot.lists.purchase },
        "/api/swaps/list": { swaps: snapshot.lists.swap },
        "/api/seaport/list": { purchases: snapshot.lists.seaport },
      };
      if (!path || !Object.hasOwn(routes, path))
        throw new ApiError(404, "Unavailable in snapshot viewer");
      return send(200, routes[path]);
    } catch (e) {
      send(e instanceof ApiError ? e.status : 400, {
        error: e instanceof ApiError ? e.message : "Invalid snapshot request",
      });
    }
  };
}
