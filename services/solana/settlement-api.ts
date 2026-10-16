import type { IncomingMessage, ServerResponse } from "node:http";
import { type Sessions, requireLocal, ApiError } from "../wallet/security.ts";
import { unifiedCheckouts, revealPaymentRequest } from "../wallet/checkouts.ts";
import { type SolanaSettlement } from "./settlement.ts";
import { json, SolanaError } from "./network.ts";
export function settlementApi(
  sessions: Sessions,
  service: SolanaSettlement,
  profile: any,
  manifest: any,
) {
  const browserView = (view: ReturnType<SolanaSettlement["view"]>) => ({
    ...view,
    paymentAddress: undefined,
  });
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    try {
      const mutation = req.method !== "GET";
      requireLocal(req.headers as Record<string, string | undefined>, mutation);
      const s = sessions.get(req.headers.cookie);
      if (!s.connected)
        throw new ApiError(403, "Verify the disposable local account first");
      if (mutation) sessions.csrf(s, req.headers["x-zecone-csrf"] as string);
      let raw = "";
      for await (const c of req) {
        raw += c;
        if (raw.length > 4096) throw new ApiError(413, "Request too large");
      }
      const b = raw ? JSON.parse(raw) : {},
        path = req.url?.split("?")[0];
      let result: unknown;
      if (req.method === "POST" && path === "/api/solana-settlement/quote")
        result = browserView(
          service.quote({
            profileId: profile.id,
            requestId: profile.orderId,
            recipient: String(b.recipient),
            relayer: profile.relayer,
            lamports: String(b.lamports),
            account: manifest.keyId,
            paymentAddress: manifest.address,
          }),
        );
      else if (req.method === "GET" && path === "/api/solana-settlement/status")
        result = {
          orders: service.store
            .all()
            .map((o) => browserView(service.view(o.id))),
          broadcastsAutomatic: false,
        };
      else if (req.method === "GET" && path === "/api/checkouts")
        result = {
          checkouts: service.store.all().map((o) => {
            const v = service.view(o.id),
              proof = service.store.db
                .prepare(
                  "SELECT detail FROM audit WHERE order_id=? AND event='scan_verified' ORDER BY seq DESC LIMIT 1",
                )
                .get(o.id),
              scan = proof ? JSON.parse(String(proof.detail)) : null,
              confirmations = scan?.outputs?.length
                ? Math.min(
                    ...scan.outputs.map((p: any) =>
                      Math.max(0, scan.tip - p.height + 1),
                    ),
                  )
                : 0;
            const row = unifiedCheckouts(
              [
                {
                  kind: "solana",
                  rows: [
                    {
                      id: o.id,
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
                      confirmations,
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
            return {
              ...row,
              state:
                v.state === "AWAITING_SOLANA_AUTHORIZATION"
                  ? "AWAITING_SOLANA_AUTHORIZATION"
                  : row.state,
              resultVerified: v.state === "COMPLETED",
            };
          }),
          liveRefundsEnabled: false,
        };
      else if (
        req.method === "POST" &&
        path === "/api/checkouts/payment-request" &&
        b.kind === "solana"
      ) {
        if (b.reveal !== true)
          throw new ApiError(403, "Explicit reveal required");
        const o = service.store.get(String(b.id));
        if (!o) throw new ApiError(404, "Unknown order");
        result = revealPaymentRequest(
          o.id,
          o,
          service.store.totals(o.id).received,
          Math.floor(Date.now() / 1000),
        );
      } else
        throw new ApiError(
          404,
          "Signing, payment sending, execution and refunds are operator-only or disabled.",
        );
      res.end(json(result));
    } catch (e) {
      res.statusCode = e instanceof ApiError ? e.status : 400;
      res.end(
        json({
          error:
            e instanceof ApiError || e instanceof SolanaError
              ? e.message
              : "Settlement unavailable; preserve and reconcile the order.",
        }),
      );
    }
  };
}
