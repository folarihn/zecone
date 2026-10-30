// Signed operator pricing for the restricted public pilot. The public service
// holds only a pinned Ed25519 public key. The operator signs two independently
// sourced market observations, exact USD amount, exact Base recipient and
// expiry; this engine verifies and consumes that quote once. It has no signer,
// wallet, relayer key or broadcast capability.
import {
  createHash,
  createPublicKey,
  sign,
  verify,
  type KeyLike,
} from "node:crypto";
import { getAddress, isAddress } from "viem";
import {
  usdToScaled,
  validatePilotObservations,
  type PilotMarketObservation,
} from "../settlement/mainnet-pilot-pricing.ts";
import { formatUnits, parseUnits } from "./money.ts";
import type { QuoteEngine, QuoteInput } from "./quote.ts";
import type { Quote } from "./types.ts";

export const CHECKOUT_PILOT_QUOTE_POLICY = "ZECONE_CHECKOUT_PILOT_QUOTE_V1" as const;
const ALLOWED_PROVIDERS = new Set(["coingecko", "coinpaprika"]);
const MAX_TTL_SECONDS = 300;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ceilDiv = (n: bigint, d: bigint) => (n + d - 1n) / d;

export type CheckoutPilotQuoteStatement = {
  version: 1;
  policy: typeof CHECKOUT_PILOT_QUOTE_POLICY;
  authority: string;
  network: "zcash-mainnet";
  payoutChain: "base";
  recipient: string;
  amountUsd: string;
  observations: PilotMarketObservation[];
  createdAt: number;
  expiresAt: number;
};

export type SignedCheckoutPilotQuote = {
  statement: CheckoutPilotQuoteStatement;
  signature: string;
};

export class PilotQuoteError extends Error {}
const fail = (code: string): never => {
  throw new PilotQuoteError(code);
};

export function buildCheckoutPilotQuoteStatement(input: {
  authority: string;
  recipient: string;
  amountUsd: string;
  observations: PilotMarketObservation[];
  createdAt: number;
  expiresAt: number;
  ttlSeconds?: number;
  maximumSpreadBps?: number;
}): CheckoutPilotQuoteStatement {
  const ttl = input.ttlSeconds ?? MAX_TTL_SECONDS;
  if (!input.authority.trim()) fail("PILOT_QUOTE_AUTHORITY_REQUIRED");
  if (!isAddress(input.recipient)) fail("PILOT_QUOTE_RECIPIENT_INVALID");
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(input.amountUsd) || parseUnits(input.amountUsd, "usd") < 1n)
    fail("PILOT_QUOTE_AMOUNT_INVALID");
  if (
    !Number.isSafeInteger(input.createdAt) ||
    !Number.isSafeInteger(input.expiresAt) ||
    !Number.isSafeInteger(ttl) ||
    ttl < 1 ||
    ttl > MAX_TTL_SECONDS ||
    input.expiresAt <= input.createdAt ||
    input.expiresAt - input.createdAt > ttl
  )
    fail("PILOT_QUOTE_EXPIRY_INVALID");
  validateSources(input.observations);
  validatePilotObservations(
    input.observations,
    input.createdAt,
    input.maximumSpreadBps ?? 200,
  );
  return {
    version: 1,
    policy: CHECKOUT_PILOT_QUOTE_POLICY,
    authority: input.authority.trim(),
    network: "zcash-mainnet",
    payoutChain: "base",
    recipient: getAddress(input.recipient),
    amountUsd: input.amountUsd,
    observations: input.observations.map((o) => ({ ...o, provider: o.provider.trim().toLowerCase() })),
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  };
}

export function signCheckoutPilotQuote(statement: CheckoutPilotQuoteStatement, privateKey: KeyLike) {
  return {
    statement,
    signature: sign(null, Buffer.from(JSON.stringify(statement)), privateKey).toString("base64"),
  } satisfies SignedCheckoutPilotQuote;
}

function validateSources(observations: PilotMarketObservation[]) {
  if (
    !Array.isArray(observations) ||
    observations.length !== 2 ||
    observations.some((o) => !ALLOWED_PROVIDERS.has(o.provider.trim().toLowerCase())) ||
    new Set(observations.map((o) => o.provider.trim().toLowerCase())).size !== 2
  )
    fail("PILOT_QUOTE_SOURCES_INVALID");
}

export class OperatorPilotQuoteEngine implements QuoteEngine {
  readonly enabled = true;
  private pending = new Map<string, SignedCheckoutPilotQuote>();
  private consumed = new Set<string>();
  private readonly key!: ReturnType<typeof createPublicKey>;
  private readonly recipient: string;

  constructor(
    private readonly options: {
      authority: string;
      publicKey: string | Buffer;
      recipient: string;
      ttlSeconds: number;
      maximumSpreadBps?: number;
    },
  ) {
    if (!options.authority.trim()) fail("PILOT_QUOTE_AUTHORITY_REQUIRED");
    if (!isAddress(options.recipient)) fail("PILOT_QUOTE_RECIPIENT_INVALID");
    if (!Number.isSafeInteger(options.ttlSeconds) || options.ttlSeconds < 1 || options.ttlSeconds > MAX_TTL_SECONDS)
      fail("PILOT_QUOTE_EXPIRY_INVALID");
    try {
      this.key = Buffer.isBuffer(options.publicKey)
        ? createPublicKey({ key: options.publicKey, format: "der", type: "spki" })
        : createPublicKey(options.publicKey);
    } catch {
      fail("PILOT_QUOTE_PUBLIC_KEY_INVALID");
    }
    if (this.key.asymmetricKeyType !== "ed25519") fail("PILOT_QUOTE_PUBLIC_KEY_INVALID");
    this.recipient = getAddress(options.recipient);
  }

  accept(envelope: SignedCheckoutPilotQuote, now = Math.floor(Date.now() / 1000)) {
    const s = envelope?.statement;
    if (
      !s ||
      s.version !== 1 ||
      s.policy !== CHECKOUT_PILOT_QUOTE_POLICY ||
      s.authority !== this.options.authority ||
      s.network !== "zcash-mainnet" ||
      s.payoutChain !== "base" ||
      !isAddress(s.recipient) ||
      getAddress(s.recipient) !== this.recipient ||
      !/^\d{1,3}(?:\.\d{1,2})?$/.test(s.amountUsd) ||
      !Number.isSafeInteger(s.createdAt) ||
      !Number.isSafeInteger(s.expiresAt) ||
      s.createdAt > now + 5 ||
      now - s.createdAt > 90 ||
      s.expiresAt <= now ||
      s.expiresAt - s.createdAt > this.options.ttlSeconds ||
      typeof envelope.signature !== "string"
    )
      fail("PILOT_QUOTE_STATEMENT_INVALID");
    validateSources(s.observations);
    validatePilotObservations(s.observations, now, this.options.maximumSpreadBps ?? 200);
    if (!verify(null, Buffer.from(JSON.stringify(s)), this.key, Buffer.from(envelope.signature, "base64")))
      fail("PILOT_QUOTE_SIGNATURE_INVALID");
    const id = digest(s);
    if (this.consumed.has(id)) fail("PILOT_QUOTE_REPLAYED");
    const cacheKey = `${s.amountUsd}:${getAddress(s.recipient)}`;
    const prior = this.pending.get(cacheKey);
    if (prior && prior.statement.createdAt >= s.createdAt && digest(prior.statement) !== id)
      fail("PILOT_QUOTE_SUPERSEDED");
    this.pending.set(cacheKey, structuredClone(envelope));
    return { quoteDigest: id, expiresAt: s.expiresAt };
  }

  quote(input: QuoteInput): Quote {
    const now = input.now ?? Math.floor(Date.now() / 1000);
    const recipient = input.recipient;
    if (!recipient || !isAddress(recipient)) fail("PILOT_QUOTE_RECIPIENT_REQUIRED");
    const cacheKey = `${input.amountUsd}:${getAddress(recipient as string)}`;
    const envelope = this.pending.get(cacheKey);
    if (!envelope) throw new PilotQuoteError("PILOT_QUOTE_NOT_AVAILABLE");
    const s = envelope.statement;
    // Recheck every time. Observations and signed terms must still be fresh at consumption.
    this.accept(envelope, now);
    const id = digest(s);
    this.pending.delete(cacheKey);
    this.consumed.add(id);

    const usd = parseUnits(s.amountUsd, "usd") * 1_000_000n; // USD scaled to 8 decimals.
    const zecPrices = s.observations.map((o) => usdToScaled(o.zecUsd, "ZEC_USD"));
    const ethPrices = s.observations.map((o) => usdToScaled(o.ethUsd, "ETH_USD"));
    const zecUsd = zecPrices[0] < zecPrices[1] ? zecPrices[0] : zecPrices[1];
    const ethUsd = ethPrices[0] < ethPrices[1] ? ethPrices[0] : ethPrices[1];
    const zatoshis = ceilDiv(usd * 100_000_000n, zecUsd);
    const wei = ceilDiv(usd * 1_000_000_000_000_000_000n, ethUsd);
    return {
      id: `q_${id.slice(0, 20)}`,
      network: "zcash-mainnet",
      payoutChain: "base",
      amountUsd: s.amountUsd,
      zecAmount: formatUnits(zatoshis, "zec"),
      zecAmountZat: zatoshis.toString(),
      ethPayout: formatUnits(wei, "eth"),
      ethPayoutWei: wei.toString(),
      feeZat: "10000",
      rate: { numerator: wei.toString(), denominator: zatoshis.toString() },
      rateSource: "live-authority",
      authorityDigest: id,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
    };
  }
}
