// Merchant wallet-ownership proofs (EIP-4361 "Sign-In with Ethereum").
//
// The server composes the complete message (domain, URI, chain, nonce, issued-at
// and expiration) and stores it. The client only returns a signature over that
// exact text. Verification requires:
//   1. the nonce exists, is unexpired and has never been consumed (single use);
//   2. the returned message is byte-identical to the stored one;
//   3. the EIP-4361 fields validate (domain, address, nonce, time window);
//   4. the signature recovers to the claimed address (EOA), or — only when a
//      Base RPC is configured — validates through ERC-1271/ERC-6492.
// A merchant credential is never issued from a bare address.
import { randomBytes } from "node:crypto";
import { createPublicClient, getAddress, http, isAddress, verifyMessage, type Hex } from "viem";
import { base, baseSepolia } from "viem/chains";
import { createSiweMessage, parseSiweMessage, validateSiweMessage } from "viem/siwe";
import type { PaymentStore } from "./store.ts";
import { StoreError } from "./store.ts";

export const SUPPORTED_CHAIN_IDS = [8453, 84532] as const;
export type SiwePurpose = "register" | "signin" | `payout:${string}`;

export interface SiweConfig {
  /** RFC 3986 authorities (host[:port]) that may request a signature. */
  allowedDomains: string[];
  /** Challenge lifetime in seconds. */
  ttlSeconds: number;
  /** Optional Base RPC for smart-contract wallet signatures (ERC-1271/6492). */
  baseRpcUrl?: string;
}

export class SiweError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_address"
      | "unsupported_chain"
      | "domain_not_allowed"
      | "challenge_invalid"
      | "message_mismatch"
      | "signature_invalid",
  ) {
    super(message);
    this.name = "SiweError";
  }
}

const STATEMENTS: Record<string, string> = {
  register:
    "Register as a ZecOne merchant and prove control of this Base payout address. This signature does not authorize any transaction or token approval.",
  signin: "Sign in to the ZecOne merchant dashboard. This signature does not authorize any transaction.",
  payout:
    "Set this address as the ZecOne Base payout address for my merchant account. This signature does not authorize any transaction.",
};

export function createChallenge(
  store: PaymentStore,
  config: SiweConfig,
  input: { address: string; chainId: number; domain: string; uri: string; purpose: SiwePurpose; now?: number },
): { message: string; nonce: string; expiresAt: number } {
  if (typeof input.address !== "string" || !isAddress(input.address))
    throw new SiweError("address must be a valid EVM address", "invalid_address");
  if (!SUPPORTED_CHAIN_IDS.includes(input.chainId as 8453))
    throw new SiweError("chainId must be Base (8453) or Base Sepolia (84532)", "unsupported_chain");
  if (!config.allowedDomains.includes(input.domain))
    throw new SiweError(`domain ${input.domain} is not allowed to request merchant signatures`, "domain_not_allowed");
  let uri: URL;
  try {
    uri = new URL(input.uri);
  } catch {
    throw new SiweError("uri must be an absolute URL", "domain_not_allowed");
  }
  if (uri.host !== input.domain) throw new SiweError("uri host must match domain", "domain_not_allowed");
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const address = getAddress(input.address);
  // 128 bits of entropy, alphanumeric as EIP-4361 requires.
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = now + config.ttlSeconds;
  const message = createSiweMessage({
    address,
    chainId: input.chainId,
    domain: input.domain,
    uri: uri.toString(),
    version: "1",
    nonce,
    issuedAt: new Date(now * 1000),
    expirationTime: new Date(expiresAt * 1000),
    statement: STATEMENTS[input.purpose.startsWith("payout:") ? "payout" : input.purpose],
    requestId: input.purpose,
  });
  store.saveChallenge({ nonce, address, purpose: input.purpose, message, expiresAt, now });
  return { message, nonce, expiresAt };
}

export async function verifyChallenge(
  store: PaymentStore,
  config: SiweConfig,
  input: { message: string; signature: string; expectedPurpose?: SiwePurpose; now?: number },
): Promise<{ address: `0x${string}`; chainId: number; purpose: string }> {
  if (typeof input.message !== "string" || typeof input.signature !== "string")
    throw new SiweError("message and signature are required", "challenge_invalid");
  if (!/^0x[0-9a-fA-F]+$/.test(input.signature)) throw new SiweError("signature must be hex", "signature_invalid");
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const fields = parseSiweMessage(input.message);
  if (!fields.nonce || !fields.address || !fields.domain)
    throw new SiweError("not an EIP-4361 message", "challenge_invalid");
  let stored;
  try {
    stored = store.consumeChallenge(fields.nonce, now);
  } catch (e) {
    if (e instanceof StoreError) throw new SiweError(e.message, "challenge_invalid");
    throw e;
  }
  if (stored.message !== input.message) throw new SiweError("message does not match the issued challenge", "message_mismatch");
  if (input.expectedPurpose && stored.purpose !== input.expectedPurpose)
    throw new SiweError("challenge was issued for a different purpose", "challenge_invalid");
  if (!config.allowedDomains.includes(fields.domain)) throw new SiweError("domain not allowed", "domain_not_allowed");
  const valid = validateSiweMessage({
    message: fields,
    address: getAddress(stored.address),
    domain: fields.domain,
    nonce: fields.nonce,
    time: new Date(now * 1000),
  });
  if (!valid) throw new SiweError("message failed EIP-4361 validation (expired or mismatched)", "challenge_invalid");
  const address = getAddress(stored.address);
  const signature = input.signature as Hex;
  let ok = false;
  try {
    ok = await verifyMessage({ address, message: input.message, signature });
  } catch {
    ok = false;
  }
  if (!ok && config.baseRpcUrl) {
    // Smart-contract wallets (e.g. passkey smart wallets) sign via ERC-1271/6492.
    const chain = fields.chainId === 84532 ? baseSepolia : base;
    const client = createPublicClient({ chain, transport: http(config.baseRpcUrl, { timeout: 10_000 }) });
    try {
      ok = await client.verifyMessage({ address, message: input.message, signature });
    } catch {
      ok = false;
    }
  }
  if (!ok) throw new SiweError("signature does not match the payout address", "signature_invalid");
  return { address, chainId: fields.chainId ?? 8453, purpose: stored.purpose };
}
