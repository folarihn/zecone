import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import {
  buildSingleOperatorPilotPriceStatement,
  PILOT_PRICING_POLICY,
  pilotPriceSourceZatoshis,
  signSingleOperatorPilotPrice,
  usdToScaled,
  validatePilotObservations,
  verifySingleOperatorPilotPrice,
  type PilotMarketObservation,
  type SingleOperatorPilotPrice,
} from "../services/settlement/mainnet-pilot-pricing.ts";
import {
  mainnetQuote,
  mainnetQuoteContext,
  type MainnetQuoteInput,
} from "../services/settlement/mainnet-quote.ts";
import type { ProductionProfile } from "../services/settlement/production-safety.ts";

const now = Math.floor(Date.now() / 1000);
const quoteContext = "a".repeat(64);

function authority() {
  return generateKeyPairSync("ed25519");
}

function pilotProfile(): {
  profile: ProductionProfile;
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
} {
  const { publicKey, privateKey } = authority();
  const profile: ProductionProfile = {
    network: "base",
    enabled: true,
    providers: [
      { endpoint: "https://first.invalid", operator: "first" },
      { endpoint: "https://second.invalid", operator: "second" },
    ],
    independenceAcknowledged: true,
    relayer: "0x0000000000000000000000000000000000000001",
    recipients: ["0x0000000000000000000000000000000000000002"],
    perTransaction: "100000000000000000000",
    daily: "200000000000000000000",
    feeCap: "1000000000000000",
    sourceMaximumZatoshis: "2000000",
    confirmations: 1,
    signer: {
      identity: "pilot-signer",
      publicKey: String(
        generateKeyPairSync("ec", { namedCurve: "secp256k1" }).publicKey.export(
          {
            format: "pem",
            type: "spki",
          },
        ),
      ),
      transport: "offline-bundle",
      separateDeviceValidated: false,
      attestationReference: "docs/MAINNET-SINGLE-DEVICE-PILOT.md",
    },
    executionAuthority: {
      identity: "pilot-operator",
      publicKey: String(publicKey.export({ format: "pem", type: "spki" })),
      separateDeviceValidated: false,
      attestationReference: "docs/MAINNET-SINGLE-DEVICE-PILOT.md",
    },
    pilot: {
      enabled: true,
      isolation: "single-device-process-isolation",
      operator: "pilot-operator",
      expires: now + 3600,
      riskAccepted: "docs/MAINNET-SINGLE-DEVICE-PILOT.md",
    },
  };
  return { profile, privateKey };
}

const obs = (
  provider: string,
  ethUsd: string,
  zecUsd: string,
  at = now,
): PilotMarketObservation => ({ provider, ethUsd, zecUsd, at });

function signedPrice(
  profile: ProductionProfile,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  observations: PilotMarketObservation[],
  context = quoteContext,
): SingleOperatorPilotPrice {
  const statement = buildSingleOperatorPilotPriceStatement(
    profile.executionAuthority!.identity,
    context,
    observations,
    now,
    now + 60,
  );
  return {
    statement,
    signature: signSingleOperatorPilotPrice(statement, privateKey).signature,
    publicKey: profile.executionAuthority!.publicKey,
  };
}

function baseInput(
  profile: ProductionProfile,
  destinationUnits = 10_000_000_000_000_000n,
): MainnetQuoteInput {
  return {
    network: "base",
    profile,
    pair: "ETH/ZEC",
    destinationUnits,
    networkFee: 1000n,
    l1DataFee: 0n,
    serviceFee: 0n,
    now,
    ttlSeconds: 60,
  };
}

test("usdToScaled parses decimals with exact precision and rejects malformed input", () => {
  assert.equal(usdToScaled("2370.71").toString(), "237071000000");
  assert.equal(usdToScaled("1165.65").toString(), "116565000000");
  assert.equal(usdToScaled("1").toString(), "100000000");
  // fractional digits beyond 8 decimals are truncated deterministically
  assert.equal(usdToScaled("1213.1551806427276").toString(), "121315518064");
  assert.throws(() => usdToScaled(""), /INVALID_USD/);
  assert.throws(() => usdToScaled("-5"), /INVALID_USD/);
  assert.throws(() => usdToScaled("1.2.3"), /INVALID_USD/);
  assert.throws(() => usdToScaled("abc"), /INVALID_USD/);
  assert.throws(() => usdToScaled("99999999999999"), /OVERFLOW/);
  assert.throws(() => usdToScaled("0"), /INVALID_USD/);
});

test("two independent providers produce a valid signed pilot price", () => {
  const { profile, privateKey } = pilotProfile();
  const price = signedPrice(profile, privateKey, [
    obs("coingecko", "2370.71", "1165.65"),
    obs("coincap", "2371.00", "1166.00"),
  ]);
  const verified = verifySingleOperatorPilotPrice(
    profile,
    price,
    quoteContext,
    10_000_000_000_000_000n,
    now,
  );
  assert.equal(verified.confidence, PILOT_PRICING_POLICY);
  assert.equal(verified.sourceZatoshis.length > 0, true);
});

test("pilot price rejects stale, duplicate-provider and malformed observations", () => {
  const { profile, privateKey } = pilotProfile();
  // stale
  assert.throws(
    () =>
      signedPrice(profile, privateKey, [
        obs("coingecko", "2370.71", "1165.65", now - 120),
        obs("coincap", "2371.00", "1166.00"),
      ]),
    /STALE/,
  );
  // duplicate provider
  assert.throws(
    () =>
      signedPrice(profile, privateKey, [
        obs("coingecko", "2370.71", "1165.65"),
        obs("coingecko", "2371.00", "1166.00"),
      ]),
    /DIFFER/,
  );
  // missing provider
  assert.throws(
    () =>
      signedPrice(profile, privateKey, [
        obs("coingecko", "2370.71", "1165.65"),
        obs("", "2371.00", "1166.00"),
      ]),
    /PROVIDER_REQUIRED/,
  );
  // malformed USD
  assert.throws(
    () =>
      signedPrice(profile, privateKey, [
        obs("coingecko", "not-a-number", "1165.65"),
        obs("coincap", "2371.00", "1166.00"),
      ]),
    /INVALID_ETH_USD/,
  );
});

test("pilot price rejects excessively divergent providers", () => {
  const { profile, privateKey } = pilotProfile();
  assert.throws(
    () =>
      signedPrice(profile, privateKey, [
        obs("coingecko", "2370.71", "1165.65"),
        obs("coincap", "3000.00", "1166.00"), // ~26% ETH divergence
      ]),
    /DISAGREEMENT/,
  );
  assert.throws(
    () =>
      signedPrice(profile, privateKey, [
        obs("coingecko", "2370.71", "1165.65"),
        obs("coincap", "2371.00", "3000.00"), // ~157% ZEC divergence
      ]),
    /DISAGREEMENT/,
  );
});

test("pilot price rejects tampered signature, context mismatch and replay", () => {
  const { profile, privateKey } = pilotProfile();
  const price = signedPrice(profile, privateKey, [
    obs("coingecko", "2370.71", "1165.65"),
    obs("coincap", "2371.00", "1166.00"),
  ]);
  // tampered statement (flip a character) without re-signing
  const tampered: SingleOperatorPilotPrice = {
    ...price,
    statement: { ...price.statement, numerator: "12345" },
  };
  assert.throws(
    () =>
      verifySingleOperatorPilotPrice(
        profile,
        tampered,
        quoteContext,
        10_000_000_000_000_000n,
        now,
      ),
    /SIGNATURE|RATE/,
  );
  // wrong quoteContext (replay against a different order)
  assert.throws(
    () =>
      verifySingleOperatorPilotPrice(
        profile,
        price,
        "b".repeat(64),
        10_000_000_000_000_000n,
        now,
      ),
    /STATEMENT_INVALID/,
  );
  // expired (price expiry now+60, pilot expiry much later)
  assert.throws(
    () =>
      verifySingleOperatorPilotPrice(
        profile,
        price,
        quoteContext,
        10_000_000_000_000_000n,
        now + 61,
      ),
    /STATEMENT_INVALID/,
  );
});

test("pilot price cannot activate without the pilot marker (production stays mandatory)", () => {
  const { profile, privateKey } = pilotProfile();
  const price = signedPrice(profile, privateKey, [
    obs("coingecko", "2370.71", "1165.65"),
    obs("coincap", "2371.00", "1166.00"),
  ]);
  const noPilot: ProductionProfile = { ...profile, pilot: undefined };
  noPilot.signer!.separateDeviceValidated = true;
  noPilot.executionAuthority!.separateDeviceValidated = true;
  assert.throws(
    () =>
      verifySingleOperatorPilotPrice(
        noPilot,
        price,
        quoteContext,
        10_000_000_000_000_000n,
        now,
      ),
    /REQUIRES_ACTIVE_PILOT/,
  );
  // expired pilot marker
  assert.throws(
    () =>
      verifySingleOperatorPilotPrice(
        { ...profile, pilot: { ...profile.pilot!, expires: now - 1 } },
        price,
        quoteContext,
        10_000_000_000_000_000n,
        now,
      ),
    /REQUIRES_ACTIVE_PILOT/,
  );
});

test("mainnetQuote integrates the pilot price and keeps two-operator production", () => {
  const { profile, privateKey } = pilotProfile();
  const input = baseInput(profile);
  const context = mainnetQuoteContext(input);
  const price = signedPrice(
    profile,
    privateKey,
    [
      obs("coingecko", "2370.71", "1165.65"),
      obs("coincap", "2371.00", "1166.00"),
    ],
    context,
  );
  const quote = mainnetQuote({ ...input, pilotPrice: price });
  assert.equal(quote.priceConfidence, "SINGLE_OPERATOR_PILOT_PRICING");
  assert.ok(BigInt(quote.sourceZatoshis) > 0n);

  // Production path still requires two authorized Ed25519 feeds.
  const prod: ProductionProfile = { ...profile, pilot: undefined };
  prod.signer!.separateDeviceValidated = true;
  prod.executionAuthority!.separateDeviceValidated = true;
  assert.throws(
    () =>
      mainnetQuote({
        ...input,
        profile: prod,
        pilotPrice: undefined,
        feeds: undefined,
      }),
    /AUTHORIZED_PRODUCTION_PRICE_FEEDS_REQUIRED/,
  );
});

test("pilotPriceSourceZatoshis enforces a hard 0.02 ZEC source cap via the quote", () => {
  const { profile, privateKey } = pilotProfile();
  const input = baseInput(profile);
  const context = mainnetQuoteContext(input);
  const price = signedPrice(
    profile,
    privateKey,
    [
      obs("coingecko", "2370.71", "1165.65"),
      obs("coincap", "2371.00", "1166.00"),
    ],
    context,
  );
  const quote = mainnetQuote({ ...input, pilotPrice: price });
  assert.ok(BigInt(quote.sourceZatoshis) > 0n);
  // A larger destination (10 ETH) yields a source spend far above the 0.02 ZEC
  // cap; that overage is rejected downstream by mainnetTransferTerms.
  const bigInput = { ...baseInput(profile, 10_000_000_000_000_000_000n) };
  const bigContext = mainnetQuoteContext(bigInput);
  const bigPrice = signedPrice(
    profile,
    privateKey,
    [
      obs("coingecko", "2370.71", "1165.65"),
      obs("coincap", "2371.00", "1166.00"),
    ],
    bigContext,
  );
  const bigQuote = mainnetQuote({ ...bigInput, pilotPrice: bigPrice });
  assert.ok(
    BigInt(bigQuote.sourceZatoshis) > 2_000_000n,
    "10 ETH should exceed the source cap, exercised by terms",
  );
});
