import { createHash } from "node:crypto";

export type RawBlockProvider = {
  endpoint: string;
  operator: string;
  protocol: "zcash-json-rpc" | "blockchair-rest";
  authHeader?: string;
  authEnv?: string;
};

const HEX = /^[0-9a-f]+$/i;
const MAX_BLOCK_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = MAX_BLOCK_BYTES * 2 + 1024 * 1024;

export function assertRawBlockProviders(
  providers: RawBlockProvider[],
): asserts providers is [RawBlockProvider, RawBlockProvider] {
  if (!Array.isArray(providers) || providers.length !== 2)
    throw Error("zcash_raw_blocks_require_two_providers");
  const hosts = new Set<string>();
  const operators = new Set<string>();
  for (const provider of providers) {
    const url = new URL(provider.endpoint);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      /example|localhost|127\.0\.0\.1|\.invalid|replace/i.test(url.hostname)
    )
      throw Error("zcash_raw_block_provider_invalid");
    if (
      provider.protocol !== "zcash-json-rpc" &&
      provider.protocol !== "blockchair-rest"
    )
      throw Error("zcash_raw_block_protocol_invalid");
    if (
      (provider.authHeader && !provider.authEnv) ||
      (!provider.authHeader && provider.authEnv)
    )
      throw Error("zcash_raw_block_auth_config_invalid");
    if (
      provider.authHeader &&
      !/^[A-Za-z0-9-]{1,64}$/.test(provider.authHeader)
    )
      throw Error("zcash_raw_block_auth_header_invalid");
    if (provider.authEnv && !/^ZECONE_[A-Z0-9_]{1,80}$/.test(provider.authEnv))
      throw Error("zcash_raw_block_auth_env_invalid");
    hosts.add(url.host);
    operators.add(provider.operator);
  }
  if (hosts.size !== 2) throw Error("zcash_raw_block_hosts_must_be_distinct");
  if (operators.size !== 2)
    throw Error("zcash_raw_block_operators_must_be_distinct");
}

function providerHeaders(provider: RawBlockProvider) {
  const headers: Record<string, string> = { accept: "application/json" };
  if (provider.authHeader && provider.authEnv) {
    const secret = process.env[provider.authEnv];
    if (secret) headers[provider.authHeader] = secret;
  }
  return headers;
}

async function readJsonResponse(response: Response, operator: string) {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RESPONSE_BYTES)
      throw Error(`zcash_raw_block_response_invalid_${operator}`);
  }
  if (!response.body)
    throw Error(`zcash_raw_block_response_invalid_${operator}`);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw Error(`zcash_raw_block_response_too_large_${operator}`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    throw Error(`zcash_raw_block_response_invalid_${operator}`);
  }
}

async function fetchJson(
  provider: RawBlockProvider,
  hash: string,
  fetcher: typeof fetch,
) {
  const headers = providerHeaders(provider);
  let response: Response;
  if (provider.protocol === "zcash-json-rpc") {
    headers["content-type"] = "application/json";
    response = await fetcher(provider.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "zecone-read-only",
        method: "getblock",
        params: [hash, 0],
      }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } else {
    response = await fetcher(
      `${provider.endpoint.replace(/\/$/, "")}/${hash}`,
      {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      },
    );
  }
  if (!response.ok)
    throw Error(`zcash_raw_block_http_${provider.operator}_${response.status}`);
  return readJsonResponse(response, provider.operator);
}

function extractRawBlock(
  provider: RawBlockProvider,
  response: Record<string, unknown>,
  hash: string,
) {
  let raw: unknown;
  if (provider.protocol === "zcash-json-rpc") {
    if (response.error) throw Error(`zcash_raw_block_rpc_${provider.operator}`);
    raw = response.result;
  } else {
    const data = response.data as
      Record<string, { raw_block?: unknown }> | undefined;
    raw = data?.[hash.toLowerCase()]?.raw_block;
  }
  if (
    typeof raw !== "string" ||
    raw.length % 2 !== 0 ||
    raw.length < 218 ||
    raw.length > MAX_BLOCK_BYTES * 2 ||
    !HEX.test(raw)
  )
    throw Error(`zcash_raw_block_invalid_${provider.operator}`);
  return raw.toLowerCase();
}

async function fetchWithRetry(
  provider: RawBlockProvider,
  hash: string,
  fetcher: typeof fetch,
) {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return extractRawBlock(
        provider,
        await fetchJson(provider, hash, fetcher),
        hash,
      );
    } catch (error) {
      last = error;
      if (attempt < 2)
        await new Promise((resolve) =>
          setTimeout(resolve, 1_000 * 2 ** attempt),
        );
    }
  }
  throw last;
}

export async function fetchCorroboratedRawBlock(
  providers: RawBlockProvider[],
  hash: string,
  fetcher: typeof fetch = fetch,
) {
  assertRawBlockProviders(providers);
  if (!/^[0-9a-f]{64}$/i.test(hash)) throw Error("zcash_block_hash_invalid");
  const blocks = await Promise.all(
    providers.map((provider) => fetchWithRetry(provider, hash, fetcher)),
  );
  if (blocks[0] !== blocks[1])
    throw Error("zcash_raw_block_provider_disagreement");
  const bytes = Buffer.from(blocks[0], "hex");
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    operators: providers.map((provider) => provider.operator),
    exactByteAgreement: true as const,
  };
}
