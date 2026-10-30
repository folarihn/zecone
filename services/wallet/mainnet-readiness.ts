// Separate from all execution network registries. Identity reads only.
// No credentials, account queries, transaction calldata, or generic RPC API.
export const MAINNET_IDENTITIES = Object.freeze({
  ethereum: Object.freeze({ method: "eth_chainId", expected: "0x1" }),
  base: Object.freeze({ method: "eth_chainId", expected: "0x2105" }),
  solana: Object.freeze({
    method: "getGenesisHash",
    expected: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  }),
});
export type MainnetNetwork = keyof typeof MAINNET_IDENTITIES;
export type IdentityProvider = { endpoint: string; operator: string };
export async function mainnetIdentity(
  network: MainnetNetwork,
  primary: IdentityProvider,
  secondary?: IdentityProvider,
  fetcher: typeof fetch = fetch,
  independenceAcknowledged = false,
) {
  const policy = MAINNET_IDENTITIES[network];
  if (!policy) throw Error("UNSUPPORTED_READ_NETWORK");
  const read = async (provider: IdentityProvider) => {
    try {
      const u = new URL(provider.endpoint);
      if (
        u.protocol !== "https:" ||
        u.username ||
        u.password ||
        !provider.operator.trim()
      )
        throw Error("INVALID_PROVIDER");
      const response = await fetcher(u, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: policy.method,
          params: [],
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return "UNAVAILABLE";
      const body = await response.text();
      if (body.length > 8192) return "UNAVAILABLE";
      const data = JSON.parse(body);
      if (data.error || data.id !== 1 || data.jsonrpc !== "2.0")
        return "UNAVAILABLE";
      return data.result === policy.expected ? "VERIFIED" : "WRONG_NETWORK";
    } catch {
      return "UNAVAILABLE";
    }
  };
  const results = await Promise.all([
    read(primary),
    ...(secondary ? [read(secondary)] : []),
  ]);
  const hostname = (endpoint: string) => {
    try {
      return new URL(endpoint).hostname;
    } catch {
      return "";
    }
  };
  const independent =
    independenceAcknowledged &&
    !!secondary &&
    primary.operator.trim().toLowerCase() !==
      secondary.operator.trim().toLowerCase() &&
    !!hostname(primary.endpoint) &&
    !!hostname(secondary.endpoint) &&
    hostname(primary.endpoint) !== hostname(secondary.endpoint);
  return {
    network,
    results,
    confidence: results.includes("WRONG_NETWORK")
      ? "CONFLICTED"
      : results[0] !== "VERIFIED"
        ? "DEGRADED"
        : secondary && results[1] === "VERIFIED" && independent
          ? "CORROBORATED"
          : secondary
            ? "DEGRADED"
            : "PRIMARY_ONLY",
    scope: "NETWORK_IDENTITY_ONLY",
    spendingEnabled: false,
    productionReady: false,
  };
}
