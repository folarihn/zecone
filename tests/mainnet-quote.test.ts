import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import {
  assertMainnetQuote,
  mainnetQuote,
  mainnetQuoteContext,
  type MainnetQuoteInput,
} from "../services/settlement/mainnet-quote.ts";
import type {
  PriceStatement,
  ProductionProfile,
} from "../services/settlement/production-safety.ts";

const now = 100000;
const profile = (): ProductionProfile => ({
  network: "solana",
  enabled: true,
  providers: [
    { endpoint: "https://first.invalid", operator: "first" },
    { endpoint: "https://second.invalid", operator: "second" },
  ],
  independenceAcknowledged: true,
  relayer: "11111111111111111111111111111112",
  recipients: ["11111111111111111111111111111113"],
  perTransaction: "2000000000",
  daily: "4000000000",
  feeCap: "10000",
  confirmations: 1,
  signer: {
    identity: "synthetic",
    publicKey: String(
      generateKeyPairSync("ed25519").publicKey.export({
        format: "pem",
        type: "spki",
      }),
    ),
    transport: "offline-bundle",
    separateDeviceValidated: true,
    attestationReference: "synthetic",
  },
});
const feed = (operator: string) => {
  const key = generateKeyPairSync("ed25519"),
    statement: PriceStatement = {
      version: 1,
      operator,
      pair: "SOL/ZEC",
      numerator: "2",
      denominator: "1",
      at: now,
      expires: now + 60,
    };
  return {
    price: {
      statement,
      signature: sign(
        null,
        Buffer.from(JSON.stringify(statement)),
        key.privateKey,
      ).toString("base64"),
    },
    publicKey: String(key.publicKey.export({ format: "pem", type: "spki" })),
    bind(context: string) {
      statement.network = "solana-mainnet";
      statement.quoteContext = context;
      this.price.signature = sign(
        null,
        Buffer.from(JSON.stringify(statement)),
        key.privateKey,
      ).toString("base64");
    },
  };
};
const input = (): MainnetQuoteInput => {
  const feeds = [feed("a"), feed("b")];
  const p = profile();
  p.priceAuthorities = feeds.map((f) => ({
    operator: f.price.statement.operator,
    publicKey: f.publicKey,
  }));
  const result: MainnetQuoteInput = {
    network: "solana",
    profile: p,
    pair: "SOL/ZEC",
    feeds: feeds.map(({ price, publicKey }) => ({ price, publicKey })),
    destinationUnits: 1_000_000_000n,
    networkFee: 5000n,
    l1DataFee: 0n,
    serviceFee: 0n,
    now,
    ttlSeconds: 60,
  };
  for (const f of feeds) f.bind(mainnetQuoteContext(result));
  return result;
};

test("production quote binds signed price, fees and exact source spend", () => {
  const i = input(),
    q = mainnetQuote(i);
  assert.equal(q.sourceZatoshis, "200000000");
  assert.equal(q.totalFee, "5000");
  assert.equal(q.maximumDestinationDebit, "1000005000");
  assert.equal(q.maximumSourceSpend, q.sourceZatoshis);
  assert.equal(q.expires, now + 60);
  assert.equal(q.quoteDigest, assertMainnetQuote(q, i, now + 10).quoteDigest);
  assert.throws(
    () => assertMainnetQuote({ ...q, sourceZatoshis: "1" }, i, now + 10),
    /MAINNET_QUOTE_MISMATCH/,
  );
  assert.throws(() => assertMainnetQuote(q, i, now + 61), /EXPIRED/);
});

test("quote rejects over-cap fees, disabled profiles and wrong networks", () => {
  assert.throws(
    () => mainnetQuote({ ...input(), networkFee: 10001n }),
    /QUOTE_EXCEEDS_PROFILE_LIMIT/,
  );
  assert.throws(
    () =>
      mainnetQuote({ ...input(), profile: { ...profile(), enabled: false } }),
    /INVALID_QUOTE_INPUT/,
  );
  assert.throws(
    () => mainnetQuote({ ...input(), network: "base", pair: "SOL/ZEC" }),
    /INVALID_QUOTE_INPUT/,
  );
  assert.throws(
    () => mainnetQuote({ ...input(), l1DataFee: 1n }),
    /INVALID_QUOTE_INPUT/,
  );
});

test("production quotes reject self-selected feed keys, wrong network and replayed contexts", () => {
  const i = input();
  assert.throws(
    () =>
      mainnetQuote({
        ...i,
        profile: { ...i.profile, priceAuthorities: undefined },
      }),
    /AUTHORIZED_PRODUCTION_PRICE_FEEDS_REQUIRED/,
  );
  const attacker = feed("a");
  assert.throws(
    () => mainnetQuote({ ...i, feeds: [attacker, i.feeds![1]] }),
    /UNAUTHORIZED_OR_UNBOUND/,
  );
  assert.throws(
    () => mainnetQuote({ ...i, destinationUnits: i.destinationUnits + 1n }),
    /UNAUTHORIZED_OR_UNBOUND/,
  );
  const f = structuredClone(i.feeds!);
  f[0].price.statement.network = "base-mainnet";
  assert.throws(
    () => mainnetQuote({ ...i, feeds: f }),
    /UNAUTHORIZED_OR_UNBOUND/,
  );
  const q = mainnetQuote(i);
  assert.throws(() => assertMainnetQuote(q, i, now + 61), /EXPIRED/);
});
