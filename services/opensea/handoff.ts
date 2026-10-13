import { getAddress } from "viem";
/** Parse only; never fetch caller URLs or turn a mainnet URL into execution. */
export function listingHandoff(input: unknown) {
  if (
    typeof input !== "string" ||
    input.length > 512 ||
    input !== input.trim() ||
    /[\\%\u0000-\u0020]/.test(input) ||
    /\/\.\.?(\/|$)/.test(input)
  )
    throw Error("invalid_opensea_url");
  const u = new URL(input);
  if (
    u.protocol !== "https:" ||
    !["opensea.io", "www.opensea.io"].includes(u.hostname) ||
    u.username ||
    u.password ||
    u.port ||
    u.search ||
    u.hash
  )
    throw Error("invalid_opensea_url");
  const m =
    /^\/(?:item|assets)\/ethereum\/(0x[0-9a-fA-F]{40})\/(0|[1-9][0-9]{0,77})$/.exec(
      u.pathname,
    );
  if (!m || BigInt(m[2]!) >= 2n ** 256n)
    throw Error("unsupported_opensea_listing");
  return {
    chainId: 1 as const,
    nft: getAddress(m[1]!),
    tokenId: m[2]!,
    executable: false as const,
    paymentAddress: null,
    requiresAuthoritativeOrderLookup: true as const,
  };
}
