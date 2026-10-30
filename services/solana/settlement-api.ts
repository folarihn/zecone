import type { IncomingMessage, ServerResponse } from "node:http";
import { type Sessions, requireLocal, ApiError } from "../wallet/security.ts";
import { unifiedCheckouts, revealPaymentRequest } from "../wallet/checkouts.ts";
import {
  CheckoutScopes,
  checkoutBrowserView,
  paymentInspection,
  privacyError,
  PrivacyDiagnostics,
  INSPECTION_WARNING,
} from "../wallet/privacy.ts";
import { ScopedHistory, deliveryBrowserView } from "./privacy.ts";
import { type SolanaSettlement } from "./settlement.ts";
import { json } from "./network.ts";
import { digest } from "./transactions.ts";
export function settlementApi(
  sessions: Sessions,
  service: SolanaSettlement,
  profile: any,
  manifest: any,
) {
  const history = new ScopedHistory(service.store.db),
    scopes = new CheckoutScopes(sessions.now),
    diagnostics = new PrivacyDiagnostics();
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const mutation = req.method !== "GET";
      requireLocal(req.headers as Record<string, string | undefined>, mutation);
      if (req.url?.includes("?"))
        throw new ApiError(400, "No query parameters.");
      const s = sessions.get(req.headers.cookie);
      if (!s.connected) throw new ApiError(403, "Verify local account.");
      if (mutation) sessions.csrf(s, req.headers["x-zecone-csrf"] as string);
      let raw = "";
      for await (const c of req) {
        raw += c;
        if (raw.length > 4096) throw new ApiError(413, "Request too large.");
      }
      const b = raw ? JSON.parse(raw) : {},
        path = req.url;
      let result: unknown;
      if (req.method === "POST" && path === "/api/solana-settlement/quote") {
        const id = `0x${digest(`phase7b:${profile.id}:${profile.orderId}`)}`;
        // No silent claim of historical or already-paid orders after session loss.
        if (service.store.get(id) && !history.owns(s.id, id))
          throw new ApiError(403, "Checkout owned by another session.");
        const v = service.quote({
          profileId: profile.id,
          requestId: profile.orderId,
          recipient: String(b.recipient),
          relayer: profile.relayer,
          lamports: String(b.lamports),
          account: manifest.keyId,
          paymentAddress: manifest.address,
        });
        result = deliveryBrowserView(v, history.handle(s.id, v.id));
      } else if (
        req.method === "GET" &&
        path === "/api/solana-settlement/status"
      ) {
        result = {
          orders: history
            .rows(s.id)
            .map((r) =>
              deliveryBrowserView(
                service.view(String(r.order_id)),
                String(r.handle),
              ),
            ),
          broadcastsAutomatic: false,
        };
      } else if (req.method === "GET" && path === "/api/checkouts") {
        const rows = history.rows(s.id).map((r) => {
          const v = service.view(String(r.order_id));
          const row = unifiedCheckouts(
            [
              {
                kind: "solana",
                rows: [
                  {
                    id: v.id,
                    status:
                      v.state === "COMPLETED"
                        ? "Completed"
                        : v.state === "RECOVERY_REQUIRED"
                          ? "Manual review required"
                          : v.signature
                            ? "Executing"
                            : "Awaiting payment",
                    stage:
                      v.state === "RECOVERY_REQUIRED" ? "review" : "quoted",
                    expiry: v.expires,
                    recipient: v.recipient,
                    zatoshis: v.zatoshis,
                    receivedZatoshis: v.receivedZatoshis,
                    confirmations: v.confirmations,
                    requiredConfirmations: 10,
                    paymentTx: v.paymentTxs[0] ?? null,
                    baseTx: v.signature,
                    networkName: "Solana devnet",
                    token: "SOL",
                    minOut: v.lamports,
                    manualRecovery: v.state === "RECOVERY_REQUIRED",
                  },
                ],
              },
            ],
            v.recipient,
          )[0];
          if (v.state === "AWAITING_SOLANA_AUTHORIZATION")
            return {
              ...checkoutBrowserView(row, scopes.handle(s, "solana", v.id)),
              state: "AWAITING_SOLANA_AUTHORIZATION",
            };
          return checkoutBrowserView(
            { ...row, resultVerified: v.state === "COMPLETED" },
            scopes.handle(s, "solana", v.id),
          );
        });
        result = {
          checkouts: rows,
          ...scopes.metadata(s),
          liveRefundsEnabled: false,
        };
      } else if (
        req.method === "POST" &&
        ["/api/checkouts/payment-request", "/api/checkouts/inspect"].includes(
          path ?? "",
        ) &&
        b.kind === "solana"
      ) {
        if (b.reveal !== true)
          throw new ApiError(403, "Explicit reveal required.");
        const id = scopes.resolve(s, b.id, b.kind);
        if (!history.owns(s.id, id))
          throw new ApiError(403, "Checkout owned by another session.");
        const o = service.store.get(id);
        if (!o) throw new ApiError(404, "Unknown checkout.");
        if (path === "/api/checkouts/inspect") {
          if (b.acceptPrivacy !== true)
            throw new ApiError(
              403,
              "Explicit privacy acknowledgement required.",
            );
          result = {
            paymentTx: service.view(id).paymentTxs[0] ?? null,
            privacy: INSPECTION_WARNING,
          };
        } else {
          result = paymentInspection(
            revealPaymentRequest(
              id,
              o,
              service.store.totals(id).received,
              service.now(),
            ),
          );
        }
      } else if (
        req.method === "GET" &&
        path === "/api/solana-settlement/diagnostics"
      )
        result = diagnostics.export();
      else throw new ApiError(404, "Unavailable operation.");
      res.end(json(result));
    } catch (e) {
      diagnostics.record(
        e instanceof ApiError && e.status === 403
          ? "ACCESS_DENIED"
          : "INVALID_REQUEST",
      );
      const safe = privacyError(e);
      res.statusCode = safe.status;
      res.end(json(safe.body));
    }
  };
}
