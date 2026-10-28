import { test } from "node:test";
import assert from "node:assert/strict";
import { configFromEnv } from "../services/payments/api.ts";

const production: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  ZECONE_PAYMENTS_MODE: "demo",
  ZECONE_DEMO_SECRET: "a".repeat(48),
  ZECONE_PUBLIC_URL: "https://demo.zecone.example",
  ZECONE_ALLOW_HTTP_WEBHOOKS: "0",
  ZECONE_OPERATOR_TOKEN: "",
};

test("public demo production is secret-bearing, HTTPS-only and has no payable address", () => {
  const config = configFromEnv(production);
  assert.equal(config.mode, "demo");
  assert.equal(config.checkoutAddress, "demo:no-payable-address");
  assert.equal(config.allowLoopbackHttpWebhooks, false);
  assert.equal(config.operatorToken, null);
});

test("production refuses default secrets, HTTP, operator routes and weak secrets", () => {
  for (const changed of [
    { ZECONE_DEMO_SECRET: "demo-merchant-secret-change-me" },
    { ZECONE_DEMO_SECRET: "short" },
    { ZECONE_PUBLIC_URL: "http://demo.example" },
    { ZECONE_ALLOW_HTTP_WEBHOOKS: "1" },
    { ZECONE_OPERATOR_TOKEN: "must-not-exist" },
  ])
    assert.throws(() => configFromEnv({ ...production, ...changed }));
});

test("monitor remains separately authorized and requires an explicit receiving address", () => {
  assert.throws(() =>
    configFromEnv({
      NODE_ENV: "test",
      ZECONE_PAYMENTS_MODE: "monitor",
      ZECONE_MONITOR_AUTHORIZED: "I_UNDERSTAND_NO_AUTOMATIC_PAYOUT",
    }),
  );
  const config = configFromEnv({
    NODE_ENV: "test",
    ZECONE_PAYMENTS_MODE: "monitor",
    ZECONE_CHECKOUT_ADDRESS: "u1-explicit-monitor-fixture",
  });
  assert.equal(config.checkoutAddress, "u1-explicit-monitor-fixture");
  assert.equal(config.demoMerchant, null);
});

test("production monitor inherits HTTPS and webhook transport safeguards", () => {
  const base: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    ZECONE_PAYMENTS_MODE: "monitor",
    ZECONE_CHECKOUT_ADDRESS: "u1-explicit-monitor-fixture",
    ZECONE_PUBLIC_URL: "https://pay.zecone.example",
    ZECONE_ALLOW_HTTP_WEBHOOKS: "0",
  };
  assert.equal(configFromEnv(base).mode, "monitor");
  assert.throws(() => configFromEnv({ ...base, ZECONE_PUBLIC_URL: "http://pay.zecone.example" }), /HTTPS/);
  assert.throws(() => configFromEnv({ ...base, ZECONE_ALLOW_HTTP_WEBHOOKS: "1" }), /HTTP_WEBHOOKS/);
});

test("environment-only restricted pilot startup fails closed without a verified quote adapter", () => {
  assert.throws(
    () => configFromEnv({
      NODE_ENV: "production",
      ZECONE_PAYMENTS_MODE: "monitor",
      ZECONE_CHECKOUT_ADDRESS: "u1-explicit-monitor-fixture",
      ZECONE_PUBLIC_URL: "https://pay.zecone.example",
      ZECONE_ALLOW_HTTP_WEBHOOKS: "0",
      ZECONE_PILOT_MERCHANT_OWNER: "0x0000000000000000000000000000000000000001",
    }),
    /PILOT_LIVE_QUOTE_AUTHORITY_NOT_CONFIGURED/,
  );
});
