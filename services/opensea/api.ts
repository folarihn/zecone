// Read-only OpenSea API. This module never loads a wallet credential.
import { existsSync, readFileSync } from "node:fs";
export class DiscoveryError extends Error {}
export function credential() {
  if (process.env.OPENSEA_API_KEY)
    return { key: process.env.OPENSEA_API_KEY, expires: Infinity };
  const path = ".secrets/opensea-development-key.json";
  if (!existsSync(path)) return { key: "", expires: 0 };
  const j = JSON.parse(readFileSync(path, "utf8"));
  return {
    key: typeof j.api_key === "string" ? j.api_key : "",
    expires: Date.parse(j.expires_at),
  };
}
export async function limitedText(r: Response, max = 1_000_000) {
  if (Number(r.headers.get("content-length")) > max)
    throw new DiscoveryError("OpenSea response too large");
  const reader = r.body?.getReader();
  if (!reader) throw new DiscoveryError("Empty OpenSea response");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > max) throw new DiscoveryError("OpenSea response too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}
export function safeJson(text: string): any {
  const j = JSON.parse(text);
  const check = (v: any, depth = 0) => {
    if (
      depth > 30 ||
      (typeof v === "number" &&
        (!Number.isFinite(v) || Math.abs(v) > Number.MAX_SAFE_INTEGER))
    )
      throw new DiscoveryError("Unsafe OpenSea response");
    if (v && typeof v === "object")
      for (const x of Object.values(v)) check(x, depth + 1);
  };
  check(j);
  return j;
}
export const slug = (v: unknown) => {
  if (typeof v !== "string" || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(v))
    throw new DiscoveryError("Invalid collection slug");
  return v;
};
export class OpenSeaReadApi {
  private retryAt = 0;
  private nextFulfillment = 0;
  private cache = new Map<string, { until: number; value: any }>();
  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly auth = credential(),
  ) {}
  async read(path: string, body?: unknown) {
    const allowed =
      path === "/api/v2/chains" ||
      /^\/api\/v2\/collections\/[a-z0-9-]{1,100}$/.test(path) ||
      /^\/api\/v2\/listings\/collection\/[a-z0-9-]{1,100}\/nfts\/[0-9]{1,78}\/best$/.test(path) ||
      /^\/api\/v2\/listings\/collection\/[a-z0-9-]{1,100}\/all\?limit=10$/.test(
        path,
      ) ||
      /^\/api\/v2\/orders\/chain\/ethereum\/protocol\/0x[0-9a-fA-F]{40}\/0x[0-9a-fA-F]{64}$/.test(
        path,
      ) ||
      /^\/api\/v2\/chain\/ethereum\/contract\/0x[0-9a-fA-F]{40}\/nfts\/[0-9]{1,78}$/.test(
        path,
      );
    if (
      body === undefined
        ? !allowed
        : path !== "/api/v2/listings/fulfillment_data"
    )
      throw new DiscoveryError("Unsupported read-only OpenSea operation");
    if (!this.auth.key || !(this.auth.expires > Date.now()))
      throw new DiscoveryError("OpenSea API credential missing or expired");
    if (
      Date.now() < this.retryAt ||
      (body !== undefined && Date.now() < this.nextFulfillment)
    )
      throw new DiscoveryError("OpenSea rate limited; wait before retrying");
    const cached = this.cache.get(path);
    if (body === undefined && cached && cached.until > Date.now())
      return structuredClone(cached.value);
    if (body !== undefined) this.nextFulfillment = Date.now() + 12000;
    let r: Response;
    try {
      r = await this.request("https://api.opensea.io" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          accept: "application/json",
          "x-api-key": this.auth.key,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new DiscoveryError("OpenSea connection unavailable");
    }
    const retry = r.headers.get("retry-after"),
      reset = Number(r.headers.get("x-ratelimit-reset"));
    const retryMs =
      retry && /^\d+$/.test(retry)
        ? Number(retry) * 1000
        : retry
          ? Date.parse(retry) - Date.now()
          : 60000;
    if (r.status === 429 || r.headers.get("x-ratelimit-remaining") === "0")
      this.retryAt = Math.max(
        Date.now() + Math.max(1000, Number.isFinite(retryMs) ? retryMs : 60000),
        Number.isFinite(reset) ? reset * 1000 : 0,
      );
    if (r.status === 401 || r.status === 403)
      throw new DiscoveryError("OpenSea API access denied or expired");
    if (r.status === 429)
      throw new DiscoveryError("OpenSea rate limited; wait before retrying");
    if (!r.ok) throw new DiscoveryError(`OpenSea HTTP ${r.status}`);
    let value: any;
    try {
      value = safeJson((await limitedText(r)).toString("utf8"));
    } catch {
      throw new DiscoveryError("Invalid or oversized OpenSea response");
    }
    if (body === undefined) {
      if (this.cache.size >= 50) this.cache.clear();
      this.cache.set(path, {
        until: Date.now() + (path === "/api/v2/chains" ? 300000 : 15000),
        value,
      });
    }
    return structuredClone(value);
  }
  async supported() {
    const r = await this.read("/api/v2/chains");
    if (
      !Array.isArray(r.chains) ||
      !r.chains.some((v: any) => v.chain === "ethereum")
    )
      throw new DiscoveryError("OpenSea Ethereum discovery unavailable");
    return r.chains.map((v: any) => String(v.chain));
  }
  async listings(collection: unknown) {
    const name = slug(collection);
    await this.supported();
    const r = await this.read(
      `/api/v2/listings/collection/${name}/all?limit=10`,
    );
    if (!Array.isArray(r.listings) || r.listings.length > 10)
      throw new DiscoveryError("Invalid OpenSea listing response");
    return r.listings;
  }
}
