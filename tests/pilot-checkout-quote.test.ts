import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  OperatorPilotQuoteEngine,
  buildCheckoutPilotQuoteStatement,
  signCheckoutPilotQuote,
} from "../services/payments/pilot-quote.ts";

const RECIPIENT = "0x4b5750d7675f14eB844B74477015302Bf31AE2dB";
const OTHER = "0x000000000000000000000000000000000000dEaD";
const NOW = 1_800_000_000;
const observations = [
  { provider: "coingecko", ethUsd: "2500.00", zecUsd: "50.00", at: NOW },
  { provider: "coinpaprika", ethUsd: "2501.00", zecUsd: "50.10", at: NOW },
];

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const engine = new OperatorPilotQuoteEngine({
    authority: "pilot-operator",
    publicKey: publicKey.export({ format: "der", type: "spki" }),
    recipient: RECIPIENT,
    ttlSeconds: 300,
  });
  const statement = buildCheckoutPilotQuoteStatement({
    authority: "pilot-operator",
    recipient: RECIPIENT,
    amountUsd: "0.01",
    observations,
    createdAt: NOW,
    expiresAt: NOW + 300,
  });
  return { engine, privateKey, publicKey, envelope: signCheckoutPilotQuote(statement, privateKey) };
}

test("signed checkout quote binds exact amount, recipient, providers and conservative economics", () => {
  const f = fixture();
  assert.equal(f.engine.accept(f.envelope, NOW).expiresAt, NOW + 300);
  assert.throws(
    () => f.engine.quote({ amountUsd: "0.01", payoutChain: "base", recipient: OTHER, now: NOW }),
    /PILOT_QUOTE_NOT_AVAILABLE/,
  );
  const quote = f.engine.quote({ amountUsd: "0.01", payoutChain: "base", recipient: RECIPIENT, now: NOW });
  assert.equal(quote.rateSource, "live-authority");
  assert.match(quote.authorityDigest!, /^[a-f0-9]{64}$/);
  assert.equal(quote.zecAmountZat, "20000");
  assert.equal(quote.ethPayoutWei, "4000000000000");
  assert.equal(quote.expiresAt, NOW + 300);
  assert.throws(() => f.engine.accept(f.envelope, NOW), /PILOT_QUOTE_REPLAYED/);
  assert.throws(
    () => f.engine.quote({ amountUsd: "0.01", payoutChain: "base", recipient: RECIPIENT, now: NOW }),
    /PILOT_QUOTE_NOT_AVAILABLE/,
  );
});

test("signed checkout quote rejects tampering, stale data, duplicate sources and wrong identity", () => {
  const f = fixture();
  assert.throws(
    () => f.engine.accept({ ...f.envelope, signature: Buffer.alloc(64).toString("base64") }, NOW),
    /PILOT_QUOTE_SIGNATURE_INVALID/,
  );
  assert.throws(() => f.engine.accept(f.envelope, NOW + 91), /PILOT_PRICE_STALE|PILOT_QUOTE_STATEMENT_INVALID/);
  assert.throws(
    () => buildCheckoutPilotQuoteStatement({
      authority: "pilot-operator",
      recipient: RECIPIENT,
      amountUsd: "0.01",
      observations: [observations[0], { ...observations[1], provider: "CoinGecko" }],
      createdAt: NOW,
      expiresAt: NOW + 300,
    }),
    /PILOT_QUOTE_SOURCES_INVALID/,
  );
  const wrong = new OperatorPilotQuoteEngine({
    authority: "another-operator",
    publicKey: f.publicKey.export({ format: "der", type: "spki" }),
    recipient: RECIPIENT,
    ttlSeconds: 300,
  });
  assert.throws(() => wrong.accept(f.envelope, NOW), /PILOT_QUOTE_STATEMENT_INVALID/);
});
