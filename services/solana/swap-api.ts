import type { IncomingMessage, ServerResponse } from "node:http";
import { Sessions, requireLocal, ApiError } from "../wallet/security.ts";
import { ScopedHistory, swapBrowserView, PRIVACY_NOTICE } from "./privacy.ts";
import { type SolanaSettlement } from "./settlement.ts";
import { type CpmmPolicy } from "./cpmm.ts";
import { json, SolanaError } from "./network.ts";
export function swapApi(
  sessions: Sessions,
  service: SolanaSettlement,
  policy: CpmmPolicy,
  profile: any,
  manifest: any,
) {
  const history = new ScopedHistory(service.store.db);
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    try {
      const mutation = req.method !== "GET";
      requireLocal(req.headers as Record<string, string | undefined>, mutation);
      // Sensitive local endpoints have no URL parameters or path identifiers.
      if (req.url?.includes("?"))
        throw new ApiError(400, "Query parameters are not allowed");
      const session = sessions.get(req.headers.cookie);
      if (!session.connected)
        throw new ApiError(403, "Verify the disposable local account first");
      if (mutation)
        sessions.csrf(session, req.headers["x-zecone-csrf"] as string);
      let raw = "";
      for await (const c of req) {
        raw += c;
        if (raw.length > 2048) throw new ApiError(413, "Request too large");
      }
      const b = raw ? JSON.parse(raw) : {};
      let result: unknown;
      if (req.method === "GET" && req.url === "/api/solana-swap/config")
        result = {
          freshRecipient: profile.recipient,
          existingRecipients: profile.existingRecipients ?? [],
          privacy: PRIVACY_NOTICE,
          broadcastsAutomatic: false,
          recipientKeyInBackend: false,
        };
      else if (req.method === "POST" && req.url === "/api/solana-swap/quote") {
        if (
          ![profile.recipient, ...(profile.existingRecipients ?? [])].includes(
            b.recipient,
          )
        )
          throw new ApiError(403, "Recipient not locally registered");
        // A single profile belongs to the first authenticated checkout session.
        const owner = service.store.db
          .prepare("SELECT session_id FROM swap_history_handles LIMIT 1")
          .get();
        if (owner && owner.session_id !== session.id)
          throw new ApiError(
            403,
            "Checkout belongs to another session; use operator recovery after session loss",
          );
        const old = service.store.all()[0];
        if (
          !old &&
          (history.reused(b.recipient) ||
            (profile.existingRecipients ?? []).includes(b.recipient)) &&
          b.acceptReuse !== true
        )
          throw new ApiError(
            409,
            "Recipient was already used; explicitly acknowledge address reuse",
          );

        const terms = old ? service.intent(old.id).swap! : await policy.terms();
        const view = service.quote(
          {
            profileId: profile.id,
            requestId: profile.orderId,
            recipient: b.recipient,
            relayer: profile.relayer,
            lamports: "1000000",
            account: manifest.keyId,
            paymentAddress: manifest.address,
          },
          terms,
        );
        const h = history.handle(session.id, view.id);
        history.markRecipient(b.recipient);
        result = swapBrowserView(view, h);
      } else if (
        req.method === "GET" &&
        req.url === "/api/solana-swap/status"
      ) {
        const rows = service.store.db
          .prepare(
            "SELECT handle,order_id FROM swap_history_handles WHERE session_id=?",
          )
          .all(session.id);
        result = {
          orders: rows.map((r) =>
            swapBrowserView(service.view(String(r.order_id)), String(r.handle)),
          ),
        };
      } else if (
        req.method === "POST" &&
        req.url === "/api/solana-swap/payment-request"
      ) {
        if (b.reveal !== true)
          throw new ApiError(403, "Explicit reveal required");
        const id = history.order(session.id, String(b.handle)),
          v = service.view(id);
        if (v.expires <= service.now() || v.receivedZatoshis !== "0")
          throw new ApiError(
            409,
            "Order expired or already paid; do not send another payment",
          );
        result = {
          address: v.paymentAddress,
          zatoshis: v.zatoshis,
          network: "zcash-testnet",
          expires: v.expires,
        };
      } else
        throw new ApiError(
          404,
          "Swaps are operator-approved only; signing, broadcast, arbitrary account queries and refunds are unavailable",
        );
      res.end(json(result));
    } catch (e) {
      res.statusCode = e instanceof ApiError ? e.status : 400;
      res.end(
        json({
          error:
            e instanceof ApiError
              ? e.message
              : e instanceof SolanaError
                ? e.code
                : "Swap unavailable; preserve records and ask the local operator",
        }),
      );
    }
  };
}
