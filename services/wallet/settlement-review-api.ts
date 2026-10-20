// Optional local wallet route. Production startup must supply a fresh isolated
// public profile. This endpoint cannot create orders or authorize execution.
import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError, requireLocal, type Sessions } from "./security.ts";
import { privacyError } from "./privacy.ts";
import type { DeliveryRequest, SettlementReview } from "./settlement-review.ts";
export function settlementReviewApi(
  sessions: Sessions,
  review: Pick<SettlementReview, "review">,
  profile: Omit<DeliveryRequest, "recipient" | "lamports">,
  recipients: readonly string[],
) {
  const pinned = structuredClone(profile),
    allowed = new Set(recipients);
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "private, no-store");
    try {
      requireLocal(
        req.headers as Record<string, string | undefined>,
        req.method !== "GET",
      );
      if (req.method === "GET" && req.url === "/api/settlement-review/config") {
        if (!sessions.get(req.headers.cookie).connected)
          throw new ApiError(403, "Verify local session.");
        res.end(
          JSON.stringify({
            recipients: [...allowed],
            financialCreationEnabled: false,
            network: "solana:devnet",
          }),
        );
        return;
      }
      if (req.method !== "POST" || req.url !== "/api/settlement-review")
        throw new ApiError(404, "Unavailable operation.");
      const session = sessions.get(req.headers.cookie);
      if (!session.connected) throw new ApiError(403, "Verify local account.");
      sessions.csrf(session, req.headers["x-zecone-csrf"] as string);
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 2048) throw new ApiError(413, "Request too large.");
      }
      const b = JSON.parse(raw);
      if (
        !b ||
        Array.isArray(b) ||
        Object.keys(b).some(
          (k) => !["recipient", "lamports", "action"].includes(k),
        ) ||
        !allowed.has(b.recipient) ||
        !["transfer", "swap"].includes(b.action)
      )
        throw new ApiError(400, "Unsupported settlement review.");
      const result = await review.review(
        session.id,
        { ...pinned, recipient: b.recipient, lamports: b.lamports },
        b.action,
      );
      const current = sessions.get(req.headers.cookie);
      if (!current.connected || current.id !== session.id)
        throw new ApiError(403, "Session expired.");
      res.end(JSON.stringify(result));
    } catch (e) {
      const safe = privacyError(e);
      res.statusCode = safe.status;
      res.end(JSON.stringify(safe.body));
    }
  };
}
