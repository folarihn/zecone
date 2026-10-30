// Read-only destination evidence. No order, source payment, key or send capability.
import { rpcEndpoint } from "../solana/rpc-reliability.ts";
export type ConfidenceMode =
  "PRIMARY_ONLY" | "DEGRADED" | "CORROBORATED" | "CONFLICTED";
export type Provider = { endpoint: string; operator?: string };
export type VerificationConfig = {
  primary: Provider;
  secondary?: Provider;
  independenceAcknowledged?: boolean;
  requireCorroboration?: boolean;
  timeoutMs?: number;
};
export type Confidence = {
  mode: ConfidenceMode;
  scope: "SOLANA_FINALIZED_TRANSACTION" | "EVM_CANONICAL_DEPTH_RECEIPT";
  reason: string;
  providersChecked: number;
  providerOutcomes: string[];
};
export class EvidenceError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export const canonical = (value: any): string =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : typeof v === "bigint"
        ? v.toString()
        : v,
  );
export function verificationConfig(
  prefix: string,
  fallback: string,
): VerificationConfig {
  const flag = (suffix: string) => {
    const value = process.env[`${prefix}_${suffix}`];
    if (value !== undefined && !["0", "1"].includes(value))
      throw new EvidenceError("INVALID_VERIFICATION_CONFIG");
    return value === "1";
  };
  const primary = process.env[`${prefix}_PRIMARY`] ?? fallback;
  const secondary = process.env[`${prefix}_SECONDARY`];
  return {
    primary: {
      endpoint: primary,
      operator: process.env[`${prefix}_PRIMARY_OPERATOR`],
    },
    secondary: secondary
      ? {
          endpoint: secondary,
          operator: process.env[`${prefix}_SECONDARY_OPERATOR`],
        }
      : undefined,
    independenceAcknowledged: flag("INDEPENDENT"),
    requireCorroboration: flag("REQUIRE_CORROBORATION"),
  };
}
const methods = new Set([
  "getGenesisHash",
  "getSlot",
  "getSignatureStatuses",
  "getTransaction",
  "getBlock",
  "eth_chainId",
  "eth_getTransactionReceipt",
  "eth_blockNumber",
  "eth_getBlockByNumber",
]);
export type ReadRpc = (method: string, params: unknown[]) => Promise<any>;
export class EvidenceReader {
  #config: VerificationConfig;
  #fetch: typeof fetch;
  constructor(config: VerificationConfig, fetcher: typeof fetch = fetch) {
    for (const flag of [
      config.independenceAcknowledged,
      config.requireCorroboration,
    ])
      if (flag !== undefined && typeof flag !== "boolean")
        throw new EvidenceError("INVALID_VERIFICATION_CONFIG");
    if (
      !Number.isSafeInteger(config.timeoutMs ?? 8000) ||
      (config.timeoutMs ?? 8000) < 1 ||
      (config.timeoutMs ?? 8000) > 20000
    )
      throw new EvidenceError("INVALID_VERIFICATION_CONFIG");
    this.#config = {
      ...config,
      primary: {
        ...config.primary,
        endpoint: rpcEndpoint(config.primary.endpoint),
      },
      secondary: config.secondary
        ? {
            ...config.secondary,
            endpoint: rpcEndpoint(config.secondary.endpoint),
          }
        : undefined,
    };
    this.#fetch = fetcher;
  }
  private independent() {
    const { primary: a, secondary: b, independenceAcknowledged } = this.#config;
    return !!(
      b &&
      independenceAcknowledged &&
      a.operator &&
      b.operator &&
      /^[a-z0-9-]{1,60}$/.test(a.operator) &&
      /^[a-z0-9-]{1,60}$/.test(b.operator) &&
      a.operator !== b.operator &&
      new URL(a.endpoint).hostname !== new URL(b.endpoint).hostname
    );
  }
  private rpc(provider: Provider): ReadRpc {
    return async (method, params) => {
      if (!methods.has(method)) throw new EvidenceError("READ_METHOD_REJECTED");
      for (let attempt = 0; attempt < 2; attempt++) {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            (async () => {
              const response = await this.#fetch(provider.endpoint, {
                method: "POST",
                redirect: "error",
                signal: controller.signal,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
              });
              if (!response.ok)
                throw new EvidenceError(
                  response.status === 429
                    ? "RATE_LIMIT"
                    : [401, 403].includes(response.status)
                      ? "ACCESS_DENIED"
                      : "HTTP_UNAVAILABLE",
                );
              const stream = response.body?.getReader();
              if (!stream) throw new EvidenceError("RPC_UNAVAILABLE");
              const chunks: Uint8Array[] = [];
              let size = 0;
              for (;;) {
                const part = await stream.read();
                if (part.done) break;
                size += part.value.byteLength;
                if (size > 2 * 1024 * 1024) {
                  controller.abort();
                  throw new EvidenceError("RESPONSE_TOO_LARGE");
                }
                chunks.push(part.value);
              }
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (
                body.jsonrpc !== "2.0" ||
                body.id !== 1 ||
                body.error ||
                !("result" in body)
              )
                throw new EvidenceError("RPC_RESPONSE_UNAVAILABLE");
              return body.result;
            })(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(new EvidenceError("TIMEOUT"));
              }, this.#config.timeoutMs ?? 8000);
            }),
          ]);
        } catch (e) {
          if (
            attempt === 1 ||
            (e instanceof EvidenceError &&
              ["ACCESS_DENIED", "RESPONSE_TOO_LARGE"].includes(e.code))
          )
            throw new EvidenceError(
              e instanceof EvidenceError
                ? e.code
                : "TRANSPORT_OR_RESPONSE_UNAVAILABLE",
            );
          await new Promise((r) => setTimeout(r, 100));
        } finally {
          clearTimeout(timer);
        }
      }
      throw new EvidenceError("RPC_UNAVAILABLE");
    };
  }
  async verify<T>(
    scope: Confidence["scope"],
    observe: (
      rpc: ReadRpc,
    ) => Promise<{ evidence: T; material: unknown } | null>,
  ) {
    const providers = [
      this.#config.primary,
      ...(this.#config.secondary ? [this.#config.secondary] : []),
    ];
    // A failed peer is never substituted for the named primary evidence.
    const observations = await Promise.allSettled(
      providers.map(async (p) => {
        try {
          return await observe(this.rpc(p));
        } catch (e) {
          if (e instanceof EvidenceError) throw e;
          throw new EvidenceError("INVALID_EVIDENCE");
        }
      }),
    );
    const a = observations[0],
      b = observations[1];
    const bad = observations.some(
      (x) =>
        x.status === "rejected" &&
        x.reason instanceof EvidenceError &&
        ["WRONG_NETWORK", "INVALID_EVIDENCE"].includes(x.reason.code),
    );
    const available = a.status === "fulfilled" ? a.value : null;
    const peer = b?.status === "fulfilled" ? b.value : null;
    let mode: ConfidenceMode, reason: string;
    if (
      bad ||
      (available &&
        peer &&
        canonical(available.material) !== canonical(peer.material))
    ) {
      mode = "CONFLICTED";
      reason = "MATERIAL_DISAGREEMENT_OR_INVALID_IDENTITY";
    } else if (!available) {
      mode = "DEGRADED";
      reason = "PRIMARY_EVIDENCE_UNAVAILABLE";
    } else if (!b) {
      mode = "PRIMARY_ONLY";
      reason = "NO_SECONDARY_CONFIGURED";
    } else if (!peer) {
      mode = "DEGRADED";
      reason = "SECONDARY_CANNOT_CORROBORATE";
    } else if (!this.independent()) {
      mode = "DEGRADED";
      reason = "INDEPENDENCE_NOT_ESTABLISHED";
    } else {
      mode = "CORROBORATED";
      reason = "MATERIAL_EVIDENCE_AGREES";
    }
    const confidence: Confidence = {
      mode,
      reason,
      scope,
      providersChecked: observations.filter(
        (x) => x.status === "fulfilled" && x.value,
      ).length,
      providerOutcomes: observations.map((x) =>
        x.status === "fulfilled"
          ? x.value
            ? "VERIFIED"
            : "MISSING_OR_INSUFFICIENT_FINALITY"
          : x.reason instanceof EvidenceError &&
              [
                "WRONG_NETWORK",
                "INVALID_EVIDENCE",
                "TIMEOUT",
                "RATE_LIMIT",
                "ACCESS_DENIED",
                "HTTP_UNAVAILABLE",
                "RPC_RESPONSE_UNAVAILABLE",
                "RESPONSE_TOO_LARGE",
                "TRANSPORT_OR_RESPONSE_UNAVAILABLE",
                "RPC_UNAVAILABLE",
                "READ_METHOD_REJECTED",
              ].includes(x.reason.code)
            ? x.reason.code
            : "UNAVAILABLE",
      ),
    };
    return {
      confidence,
      evidence: mode === "CONFLICTED" ? null : (available?.evidence ?? null),
    };
  }
  assertAccepted(result: { confidence: Confidence; evidence: unknown }) {
    if (
      !result.evidence ||
      result.confidence.mode === "CONFLICTED" ||
      (this.#config.requireCorroboration &&
        result.confidence.mode !== "CORROBORATED")
    )
      throw new EvidenceError("EVIDENCE_POLICY_NOT_SATISFIED");
  }
}
