import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError, requireLocal, Sessions } from "./security.ts";
import { uuid, type Engine } from "./engine.ts";
import type { Dapps } from './dapps.ts';
import { RpcError, originOf } from './dapp-policy.ts';
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
>;
export function api(sessions: Sessions, engine: Backend, dapps?: Dapps) {
  const attempts = new Map<string, { at: number; count: number }>();
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
          if (length > (path?.startsWith('/api/dapps/') ? 32768 : 8192)) throw new ApiError(413, "Request too large.");
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
        if (next.count > (path?.startsWith('/api/dapps/') ? 200 : 40))
          throw new ApiError(429, "Too many requests. Please wait a minute.");
      }
      let data: unknown;
      if(path?.startsWith('/api/dapps/') && dapps){
        if(!session.connected) throw new ApiError(403,'Verify wallet ownership first.');
        switch(`${method} ${path}`){
          case 'GET /api/dapps/list': data=dapps.list(); break;
          case 'POST /api/dapps/request': data=await dapps.request(session,body); break;
          case 'POST /api/dapps/status': data=dapps.status(session,uuid(body.id)); break;
          case 'POST /api/dapps/approve': data=await dapps.approve(session,uuid(body.id),String(body.reviewHash),body.approved); break;
          case 'POST /api/dapps/revoke': dapps.revoke(originOf(body.origin)); data={revoked:true}; break;
          default: throw new ApiError(404,'Operation not available.');
        }
        send(200,data);return;
      }
      switch (`${method} ${path}`) {
        case "GET /api/session":
          data = { csrf: session.csrf, connected: !!session.connected };
          break;
        case "GET /api/dashboard":
          data = engine.dashboard();
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
        case 'POST /api/action-draft':
          data=(engine as Engine).actionDraft(session);break;
        case 'POST /api/action-approve':
          data=await (engine as Engine).createAction(session,uuid(body.id),String(body.digest),body.approved);break;
        case "POST /api/checkout":
          data = await engine.create(session, uuid(body.id), body.approved);
          break;
        case "POST /api/quote":
          data = await engine.quote(session, uuid(body.id));
          break;
        case "POST /api/pay":
          data = engine.pay(
            session,
            uuid(body.id),
            uuid(body.quoteId),
            body.approved,
          );
          break;
        case "POST /api/recheck":
          data = await engine.recheck(session, uuid(body.id));
          engine.refresh();
          break;
        case "POST /api/logout":
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
      send(error instanceof RpcError ? 400 : error instanceof ApiError ? error.status : 503, {
        ...(error instanceof RpcError ? {code:error.code} : {}),
        error:
          error instanceof ApiError || error instanceof RpcError
            ? error.message
            : "The local operation could not finish. Your saved checkout is preserved. Recheck status before retrying.",
      });
    }
  };
}
