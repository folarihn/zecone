import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError, requireLocal, type Sessions } from "./security.ts";
import { privacyError, paymentInspection } from "./privacy.ts";
import type { EvmTransferRequest } from "../settlement/evm-transfer.ts";
import type { NativeTransferFlow } from "../settlement/native-transfer-flow.ts";
import { getAddress, type Hex } from "viem";
import { nativeIntentHandoff } from "./native-intent-handoff.ts";
import type { IntentContext } from "./intent-checkout.ts";
import type { Session } from "./security.ts";
export function nativeTransferApi(
  sessions: Sessions,
  flow: NativeTransferFlow,
  profile: Omit<EvmTransferRequest, "recipient" | "amount" | "asset">,
  recipients: readonly string[],
  financialCreationEnabled = false,
  intents?: {
    origins: readonly string[];
    context(session: () => Session, id: string): IntentContext;
  },
) {
  const pinned = structuredClone(profile),
    allowed = new Set(recipients.map((a) => getAddress(a)));
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "private, no-store");
    try {
      requireLocal(
        req.headers as Record<string, string | undefined>,
        req.method !== "GET",
      );
      if (req.url?.includes("?"))
        throw new ApiError(400, "No query identifiers.");
      const session = sessions.get(req.headers.cookie);
      const assertContext = () => {
        const s = sessions.get(req.headers.cookie);
        if (!s.connected || s.id !== session.id)
          throw new ApiError(403, "Local session required.");
      };
      assertContext();
      if (req.method === "GET" && req.url === "/api/native-transfer/config") {
        res.end(
          JSON.stringify({
            chainId: flow.settlement.adapter.chainId,
            recipients: [...allowed],
            authorizer: flow.authorizer,
            resume: flow.resume(session.id),
            financialCreationEnabled,
            tokensEnabled: false,
          }),
        );
        return;
      }
      if (req.method !== "POST")
        throw new ApiError(404, "Unavailable operation.");
      sessions.csrf(session, req.headers["x-zecone-csrf"] as string);
      let raw = "";
      for await (const c of req) {
        raw += c;
        if (raw.length > 4096) throw new ApiError(413, "Too large.");
      }
      const b = JSON.parse(raw);
      if (!b || Array.isArray(b) || typeof b !== "object")
        throw new ApiError(400, "Invalid request.");
      const fields = (keys: string[]) => {
        if (Object.keys(b).some((k) => !keys.includes(k)))
          throw new ApiError(400, "Unknown field.");
      };
      let result: unknown;
      if (req.url === "/api/native-transfer/from-intent") {
        fields(["id", "approved"]);
        if (!intents || b.approved !== true)
          throw new ApiError(
            403,
            "Explicit alternate checkout consent required.",
          );
        const context = intents.context(
          () => sessions.get(req.headers.cookie),
          String(b.id),
        );
        const handoff = nativeIntentHandoff(context, intents.origins);
        if (
          handoff.chainId !== flow.settlement.adapter.chainId ||
          getAddress(handoff.source.account) !== getAddress(flow.authorizer) ||
          !allowed.has(handoff.recipient)
        )
          throw new ApiError(
            403,
            "Intent account, network or recipient mismatch.",
          );
        result = await flow.review(
          session.id,
          {
            ...pinned,
            asset: { kind: "native" },
            recipient: handoff.recipient,
            amount: handoff.amount,
          },
          handoff.source,
        );
        const latest = nativeIntentHandoff(context, intents.origins);
        if (JSON.stringify(latest) !== JSON.stringify(handoff))
          throw new ApiError(403, "Intent changed.");
      } else if (req.url === "/api/native-transfer/review") {
        fields(["recipient", "amount"]);
        if (
          !allowed.has(getAddress(b.recipient)) ||
          typeof b.amount !== "string"
        )
          throw new ApiError(400, "Unsupported recipient or amount.");
        result = await flow.review(session.id, {
          ...pinned,
          asset: { kind: "native" },
          recipient: getAddress(b.recipient),
          amount: b.amount,
        });
      } else if (req.url === "/api/native-transfer/authorize") {
        fields(["id", "signature", "approved"]);
        if (
          !financialCreationEnabled ||
          b.approved !== true ||
          !/^0x[0-9a-fA-F]{130}$/.test(b.signature)
        )
          throw new ApiError(403, "Signed financial authorization required.");
        const assertSource = () => {
          assertContext();
          const source = flow.source(session.id, String(b.id));
          if (source) {
            if (!intents)
              throw new ApiError(403, "Intent context unavailable.");
            const current = nativeIntentHandoff(
              intents.context(
                () => sessions.get(req.headers.cookie),
                source.id,
              ),
              intents.origins,
            );
            if (JSON.stringify(current.source) !== JSON.stringify(source))
              throw new ApiError(403, "Intent scope changed.");
          }
        };
        result = await flow.authorize(
          session.id,
          String(b.id),
          b.signature as Hex,
          true,
          assertSource,
        );
      } else if (req.url === "/api/native-transfer/status") {
        fields(["id"]);
        result = flow.status(session.id, String(b.id));
      } else if (req.url === "/api/native-transfer/payment-request") {
        fields(["id", "reveal"]);
        if (b.reveal !== true)
          throw new ApiError(403, "Explicit reveal required.");
        result = paymentInspection(
          flow.paymentRequest(session.id, String(b.id)),
        );
      } else
        throw new ApiError(404, "No signing, broadcast or refund endpoint.");
      assertContext();
      res.end(JSON.stringify(result));
    } catch (e) {
      const safe = privacyError(e);
      res.statusCode = safe.status;
      res.end(JSON.stringify(safe.body));
    }
  };
}
