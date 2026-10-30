// One-shot EIP-4361 merchant registration against a LOCAL payments API.
//
// The caller supplies `sign`, which is invoked at most once and only with a
// challenge that this module has re-parsed and checked: issued for exactly the
// expected address, Base mainnet, the requested domain, the fixed "register"
// statement (which states it authorizes no transaction), no resources and a
// short expiry. Key handling lives in scripts/merchant-siwe-register.ts; this
// module never sees key material.
import { getAddress, isAddress } from "viem";
import { parseSiweMessage } from "viem/siwe";

const REGISTER_STATEMENT =
  "Register as a ZecOne merchant and prove control of this Base payout address. This signature does not authorize any transaction or token approval.";

export interface RegisterInput {
  api: string;
  domain: string;
  address: string;
  name: string;
  expectedMode: "monitor" | "demo";
  sign: (message: string) => Promise<`0x${string}`>;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface RegisterResult {
  created: boolean;
  merchantId: string;
  payoutAddress: string;
  payoutVerification: string | null;
  apiKey: string | null;
}

const fail = (code: string): never => {
  throw Error(code);
};

export function assertLoopbackApi(api: string): URL {
  const u = new URL(api);
  if (u.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) || u.pathname !== "/")
    fail("LOOPBACK_PAYMENTS_API_REQUIRED");
  return u;
}

export async function registerMerchant(input: RegisterInput): Promise<RegisterResult> {
  const http = input.fetch ?? fetch;
  const now = input.now ?? (() => Math.floor(Date.now() / 1000));
  const api = assertLoopbackApi(input.api);
  if (!isAddress(input.address)) fail("ADDRESS_INVALID");
  const address = getAddress(input.address);
  const call = async (path: string, body?: unknown) => {
    const r = await http(new URL(path, api), {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
    });
    const j = (await r.json().catch(() => ({}))) as Record<string, any>;
    if (!r.ok) fail(`PAYMENTS_API_${String(j?.error?.code ?? r.status).toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`);
    return j;
  };

  const health = await call("/api/v1/health");
  if (health.mode !== input.expectedMode || health.livePayoutEnabled !== false) fail("PAYMENTS_API_MODE_UNEXPECTED");

  const uri = `${input.domain.startsWith("localhost") || input.domain.startsWith("127.0.0.1") ? "http" : "https"}://${input.domain}/`;
  const { challenge } = await call("/api/v1/merchants/challenge", {
    address,
    purpose: "register",
    chainId: 8453,
    domain: input.domain,
    uri,
  });
  const message = String(challenge?.message ?? "");
  const f = parseSiweMessage(message);
  const t = now();
  const expires = f.expirationTime ? Math.floor(f.expirationTime.getTime() / 1000) : 0;
  if (
    !f.address ||
    getAddress(f.address) !== address ||
    f.chainId !== 8453 ||
    f.domain !== input.domain ||
    f.uri !== uri ||
    f.version !== "1" ||
    f.statement !== REGISTER_STATEMENT ||
    f.requestId !== "register" ||
    (f.resources && f.resources.length > 0) ||
    f.nonce !== challenge.nonce ||
    expires <= t ||
    expires > t + 900
  )
    fail("CHALLENGE_NOT_A_PLAIN_REGISTRATION");

  const signature = await input.sign(message);
  const v = await call("/api/v1/merchants/verify", { message, signature, name: input.name });
  const m = v.merchant ?? {};
  if (!m.payoutAddress || getAddress(m.payoutAddress) !== address) fail("REGISTERED_PAYOUT_ADDRESS_MISMATCH");
  return {
    created: v.created === true,
    merchantId: String(m.id),
    payoutAddress: getAddress(m.payoutAddress),
    payoutVerification: m.payoutVerification ?? null,
    apiKey: typeof v.apiKey === "string" ? v.apiKey : null,
  };
}
