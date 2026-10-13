// Read-only listing discovery. No signing, posting listings, broadcasting, or Zcash data.
import { existsSync, readFileSync } from "node:fs";
import {
  decodeFunctionData,
  encodeFunctionData,
  toFunctionSignature,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import {
  CHAIN,
  PROTOCOL,
  seaportAbi,
  fulfillment,
  listingTerms,
  eq,
  type Listing,
  type SeaportConfig,
} from "./protocol.ts";
import { verifyListing } from "./adapter.ts";
const ORIGIN = "https://api.opensea.io";
const safe = (v: unknown): any => {
  if (typeof v === "number" && !Number.isSafeInteger(v))
    throw Error("unsafe_api_integer");
  if (Array.isArray(v)) return v.map(safe);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, safe(x)]));
  return v;
};
export function validateFulfillment(
  value: unknown,
  l: Listing,
  c: SeaportConfig,
) {
  const v = safe(value),
    f = v?.fulfillment_data,
    t = f?.transaction,
    d = t?.input_data;
  if (
    v?.protocol !== "seaport" ||
    !t ||
    t.chain !== CHAIN ||
    !eq(t.to, PROTOCOL) ||
    !d ||
    !Array.isArray(f.orders) ||
    f.orders.length !== 1
  )
    throw Error("unsupported_api_fulfillment");
  if (
    t.calldata_suffix !== undefined &&
    t.calldata_suffix !== null &&
    t.calldata_suffix !== "0x"
  )
    throw Error("unsupported_api_attribution_suffix");
  const entry = seaportAbi.find(
    (x) => x.type === "function" && x.name === "fulfillAdvancedOrder",
  )!;
  if (
    t.function !== toFunctionSignature(entry as any) ||
    Object.keys(d).some(
      (k) =>
        ![
          "advancedOrder",
          "criteriaResolvers",
          "fulfillerConduitKey",
          "recipient",
        ].includes(k),
    )
  )
    throw Error("unsupported_api_call");
  const amount = listingTerms(l, c, Math.floor(Date.now() / 1000)).total;
  if (
    t.value !== amount.toString() ||
    (t.value_hex != null && BigInt(t.value_hex) !== amount)
  )
    throw Error("api_value_mismatch");
  if (
    !eq(d.recipient, c.user) ||
    d.fulfillerConduitKey !== zeroHash ||
    !Array.isArray(d.criteriaResolvers) ||
    d.criteriaResolvers.length !== 0
  )
    throw Error("api_recipient_or_route_mismatch");
  const data = encodeFunctionData({
    abi: seaportAbi,
    functionName: "fulfillAdvancedOrder",
    args: [
      d.advancedOrder,
      d.criteriaResolvers,
      d.fulfillerConduitKey,
      d.recipient,
    ],
  });
  if (data !== fulfillment(l, c.user)) throw Error("api_calldata_mismatch");
  const original = f.orders[0];
  if (
    original.signature !== l.signature ||
    Number(original.parameters.totalOriginalConsiderationItems) !==
      l.parameters.consideration.length
  )
    throw Error("api_order_mismatch");
  // Re-encode the separately returned order as well, to catch changed offer/fees/signature.
  const p = original.parameters;
  const { counter, ...parameters } = p;
  const orderData = encodeFunctionData({
    abi: seaportAbi,
    functionName: "fulfillAdvancedOrder",
    args: [
      {
        parameters,
        numerator: 1n,
        denominator: 1n,
        signature: original.signature,
        extraData: "0x",
      },
      [],
      zeroHash,
      c.user,
    ],
  });
  if (orderData !== data || BigInt(counter) !== BigInt(l.parameters.counter))
    throw Error("api_order_mismatch");
  return {
    decoded: decodeFunctionData({ abi: seaportAbi, data }),
    data,
    value: amount,
    protocol: PROTOCOL,
    recipient: c.user,
  };
}
export class OpenSeaDiscovery {
  private retryAt = 0;
  private chainCache: { at: number; value: any } | undefined;
  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly key = process.env.OPENSEA_API_KEY ??
      (existsSync(".secrets/opensea-api-key.txt")
        ? readFileSync(".secrets/opensea-api-key.txt", "utf8").trim()
        : ""),
  ) {}
  async read(path: string, body?: unknown) {
    if (Date.now() < this.retryAt) throw Error("opensea_rate_limited");
    const allowedRead =
      path === "/api/v2/chains" ||
      /^\/api\/v2\/listings\/collection\/[a-z0-9-]+\/all\?limit=10$/.test(
        path,
      ) ||
      /^\/api\/v2\/orders\/chain\/base_sepolia\/protocol\/0x[0-9a-fA-F]{40}\/0x[0-9a-fA-F]{64}$/.test(
        path,
      );
    if (body ? path !== "/api/v2/listings/fulfillment_data" : !allowedRead)
      throw Error("invalid_read_only_api_path");
    const r = await this.request(ORIGIN + path, {
      method: body ? "POST" : "GET",
      headers: {
        accept: "application/json",
        ...(this.key ? { "x-api-key": this.key } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (r.status === 429) {
      const retry = Number(r.headers.get("retry-after")),
        reset = Number(r.headers.get("x-ratelimit-reset"));
      this.retryAt = Math.max(
        Date.now() + Math.max(1, Number.isFinite(retry) ? retry : 60) * 1000,
        Number.isFinite(reset) ? reset * 1000 : 0,
      );
      throw Error("opensea_rate_limited");
    }
    if (r.status === 401 || r.status === 403)
      throw Error("opensea_access_unavailable");
    if (!r.ok) throw Error(`opensea_http_${r.status}`);
    const text = await r.text();
    if (text.length > 1000000) throw Error("opensea_response_too_large");
    return safe(JSON.parse(text));
  }
  async available() {
    if (!this.chainCache || Date.now() - this.chainCache.at > 300000)
      this.chainCache = {
        at: Date.now(),
        value: await this.read("/api/v2/chains"),
      };
    return (
      Array.isArray(this.chainCache.value.chains) &&
      this.chainCache.value.chains.some((c: any) => c.chain === "base_sepolia")
    );
  }
  async supported() {
    if (!(await this.available())) throw Error("opensea_testnet_not_supported");
  }
  async listings(collection: string) {
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(collection))
      throw Error("invalid_collection_slug");
    await this.supported();
    const r = await this.read(
      `/api/v2/listings/collection/${encodeURIComponent(collection)}/all?limit=10`,
    );
    if (!Array.isArray(r.listings)) throw Error("invalid_api_listings");
    return r.listings.filter(
      (l: any) =>
        l.chain === "base_sepolia" && eq(l.protocol_address, PROTOCOL),
    );
  }
  async order(hash: Hex) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw Error("invalid_order_hash");
    await this.supported();
    return this.read(
      `/api/v2/orders/chain/base_sepolia/protocol/${PROTOCOL}/${hash}`,
    );
  }
  async fulfillment(l: Listing, c: SeaportConfig) {
    await this.supported();
    if (l.source !== "opensea-api") throw Error("not_api_listing");
    const r = await this.read("/api/v2/listings/fulfillment_data", {
      listing: {
        chain: "base_sepolia",
        hash: l.orderHash,
        protocol_address: PROTOCOL,
      },
      fulfiller: { address: c.executor },
      recipient: c.user,
      units_to_fill: 1,
      include_optional_creator_fees: false,
    });
    const checked = validateFulfillment(r, l, c);
    await verifyListing(l, c);
    return checked;
  }
}
