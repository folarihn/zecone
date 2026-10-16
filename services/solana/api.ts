import type { IncomingMessage, ServerResponse } from "node:http";
import { type Sessions, requireLocal, ApiError } from "../wallet/security.ts";
import { Accounts } from "./accounts.ts";
import { Devnet, GENESIS, json, SolanaError } from "./network.ts";
import { portfolio } from "./tokens.ts";
import { prepare } from "./transactions.ts";
import { type SolanaJournal } from "./journal.ts";
import { type SolanaPermissions } from "./provider.ts";
export function solanaApi(
  sessions: Sessions,
  journal: SolanaJournal,
  permissions: SolanaPermissions,
  net = new Devnet(),
) {
  const attempts = new Map<string, { at: number; n: number }>();
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    try {
      const mutation = req.method !== "GET";
      requireLocal(req.headers as Record<string, string | undefined>, mutation);
      const session = sessions.get(req.headers.cookie);
      if (mutation)
        sessions.csrf(session, req.headers["x-zecone-csrf"] as string);
      const a = attempts.get(session.id),
        next =
          !a || Date.now() - a.at > 60000
            ? { at: Date.now(), n: 1 }
            : { ...a, n: a.n + 1 };
      attempts.set(session.id, next);
      if (next.n > 30) throw new ApiError(429, "Rate limit. Wait one minute.");
      if (attempts.size > 1000) attempts.clear();
      let raw = "";
      for await (const c of req) {
        raw += c;
        if (raw.length > 8192) throw new ApiError(413, "Request too large");
      }
      const body = raw ? JSON.parse(raw) : {};
      const path = req.url?.split("?")[0];
      const accounts = Accounts.list();
      let result: unknown;
      if (req.method === "GET" && path === "/api/solana/accounts")
        result = {
          accounts,
          network: "solana:devnet",
          locked: true,
          signingEnabled: false,
          broadcastEnabled: false,
        };
      else if (req.method === "POST" && path === "/api/solana/balance") {
        const selected = accounts.find((a) => a.address === body.address);
        if (!selected) throw new SolanaError("INVALID_ACCOUNT");
        result = await portfolio(net, selected.address);
      } else if (req.method === "POST" && path === "/api/solana/prepare") {
        if (!session.connected)
          throw new ApiError(403, "Unlock the disposable account first.");
        const owner = accounts.find((a) => a.address === body.owner),
          recipient = accounts.find((a) => a.address === body.recipient);
        if (!owner || !recipient) throw new SolanaError("INVALID_ACCOUNT");
        const existing = journal.get(String(body.id));
        if (existing)
          throw new SolanaError("DUPLICATE_REQUEST_USE_SAVED_PREVIEW");
        const p = await prepare(
          net,
          {
            family: "solana",
            network: "solana:devnet",
            genesis: GENESIS,
            owner: owner.address,
            recipient: recipient.address,
            asset: body.asset ?? { kind: "SOL" },
            amount: String(body.amount),
            feeCap: "10000",
          },
          accounts.map((a) => a.address),
        );
        journal.save(String(body.id), p);
        result = { id: body.id, ...p, wire: undefined };
      } else if (req.method === "POST" && path === "/api/solana/request") {
        if (!session.connected)
          throw new ApiError(403, "Unlock the disposable account first.");
        result = permissions.request(
          String(body.origin),
          session.id,
          String(body.method),
        );
      } else if (req.method === "POST" && path === "/api/solana/approve") {
        if (!session.connected) throw new ApiError(403, "Unlock required");
        result = permissions.approve(
          String(body.id),
          session.id,
          String(body.account),
          body.approved === true,
        );
      } else if (req.method === "POST" && path === "/api/solana/revoke") {
        permissions.revoke(String(body.origin));
        result = { revoked: true };
      } else if (req.method === "GET" && path === "/api/solana/permissions")
        result = {
          permissions: permissions.db
            .prepare("SELECT origin,account FROM solana_permissions")
            .all(),
        };
      else throw new ApiError(404, "Unsupported Solana operation.");
      res.end(json(result));
    } catch (e) {
      res.statusCode = e instanceof ApiError ? e.status : 400;
      res.end(
        json({
          error:
            e instanceof ApiError || e instanceof SolanaError
              ? e.message
              : "Solana operation unavailable",
          code:
            e instanceof SolanaError && e.code === "USER_REJECTED"
              ? 4001
              : 4100,
        }),
      );
    }
  };
}
