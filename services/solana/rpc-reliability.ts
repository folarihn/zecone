// Diagnostics contain provider indexes and classifications only; never URLs/arguments/errors.
export type RpcDiagnostic = {
  provider: number;
  attempt: number;
  category: string;
};
export function rpcCategory(error: unknown, timedOut = false) {
  const e = error as {
    name?: string;
    context?: { statusCode?: number; __code?: number };
  };
  if (timedOut || e?.name === "TimeoutError" || e?.name === "AbortError")
    return "TIMEOUT";
  const status = e?.context?.statusCode;
  if (status === 429) return "RATE_LIMIT";
  if (status === 401 || status === 403) return "ACCESS_DENIED";
  if (status && status >= 500) return "HTTP_SERVER";
  if (status) return "HTTP_CLIENT";
  if (e?.context?.__code) return "RPC_RESPONSE";
  return "TRANSPORT_OR_RESPONSE";
}
export function rpcEndpoint(value: string) {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password || u.hash)
      throw Error("INVALID_RPC_CONFIGURATION");
    return u.href;
  } catch {
    // URL's own TypeError can contain the full credential-bearing input.
    throw Error("INVALID_RPC_CONFIGURATION");
  }
}
