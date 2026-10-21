// Optional local wallet route. Production startup must supply a fresh isolated
// public profile. This endpoint cannot create orders or authorize execution.
import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError, requireLocal, type Sessions } from "./security.ts";
import { privacyError } from "./privacy.ts";
import type { DeliveryRequest, SettlementReview } from "./settlement-review.ts";
import type { SolanaTransferFlow } from "../settlement/solana-transfer-flow.ts";
import type { Hex } from "viem";
export function settlementReviewApi(
  sessions: Sessions,
  review: Pick<
    SettlementReview,
    "review" | "authorize" | "status" | "paymentRequest" | "financialAction"
  >,
  profile: Omit<DeliveryRequest, "recipient" | "lamports">,
  recipients: readonly string[],
  options: {
    financialCreationEnabled?: boolean;
    flow?: SolanaTransferFlow;
  } = {},
) {
  const pinned = structuredClone(profile),
    allowed = new Set(recipients),
    financialCreationEnabled = options.financialCreationEnabled === true;
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
            financialCreationEnabled,
            spl: "spl" in pinned,
            network: "solana:devnet",
            executionAuthorized: false,
            userSignatureRequired: !!options.flow,
          }),
        );
        return;
      }
      if (req.method === "GET" && req.url === "/api/settlement-review/status") {
        const session = sessions.get(req.headers.cookie);
        if (!session.connected)
          throw new ApiError(403, "Verify local session.");
        res.end(
          JSON.stringify({
            reviews: review.status(session.id).map((r) => ({
              ...r,
              ...(options.flow && r.orderId && r.state === "CREATED"
                ? {
                    settlement: options.flow.scopedState(session.id, r.orderId),
                  }
                : {}),
            })),
            financialCreationEnabled,
            executionAuthorized: false,
          }),
        );
        return;
      }
      if (
        ![
          "/api/settlement-review",
          "/api/settlement-review/authorize",
        ].includes(req.url ?? "") ||
        req.method !== "POST"
      )
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
      if (req.url === "/api/settlement-review/authorize") {
        if (!financialCreationEnabled)
          throw new ApiError(403, "Financial creation is disabled.");
        if (
          !b ||
          Array.isArray(b) ||
          Object.keys(b).some(
            (k) =>
              ![
                "id",
                "digest",
                "approved",
                ...(options.flow ? ["signature"] : []),
              ].includes(k),
          ) ||
          typeof b.id !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            b.id,
          ) ||
          typeof b.digest !== "string" ||
          !/^[a-f0-9]{64}$/.test(b.digest) ||
          b.approved !== true
        )
          throw new ApiError(400, "Exact review authorization required.");
        if (review.financialAction(session.id, b.id) !== "transfer")
          throw new ApiError(
            400,
            "This review is not a validated SOL delivery.",
          );
        const assertContext = () => {
          const current = sessions.get(req.headers.cookie);
          if (!current.connected || current.id !== session.id)
            throw new ApiError(403, "Session expired.");
        };
        if (
          options.flow &&
          (typeof b.signature !== "string" ||
            !/^0x[a-fA-F0-9]{130}$/.test(b.signature))
        )
          throw new ApiError(400, "Public authorization signature required.");
        const result = options.flow
          ? await options.flow.authorizeSigned(
              session.id,
              b.id,
              b.digest,
              b.signature as Hex,
              assertContext,
            )
          : await review.authorize(
              session.id,
              b.id,
              b.digest,
              true,
              true,
              assertContext,
            );
        const current = sessions.get(req.headers.cookie);
        if (!current.connected || current.id !== session.id)
          throw new ApiError(403, "Session expired.");
        res.end(
          JSON.stringify({
            ...result,
            paymentRequest: review.paymentRequest(session.id, result.orderId),
            notice:
              "A financial order exists. No payment, signing or broadcast occurred.",
          }),
        );
        return;
      }
      if (
        !b ||
        Array.isArray(b) ||
        Object.keys(b).some(
          (k) => !["recipient", "lamports", "action"].includes(k),
        ) ||
        !allowed.has(b.recipient) ||
        !["transfer", "spl-transfer", "swap"].includes(b.action)
      )
        throw new ApiError(400, "Unsupported settlement review.");
      // Dedicated historical swap adapters retain their separate policies.
      if (financialCreationEnabled && b.action !== "transfer")
        throw new ApiError(
          400,
          "Only validated SOL delivery is enabled in this runtime.",
        );
      const result = await (options.flow ?? review).review(
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
