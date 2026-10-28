// One-shot merchant registration helper. Disposable test wallets and an
// in-process payments API only; no production key is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newWallet, startHarness } from "./helpers/payments-harness.ts";
import { assertLoopbackApi, registerMerchant } from "../services/payments/merchant-register.ts";

test("registers the signing address as the SIWE-verified payout address", async () => {
  const h = await startHarness();
  try {
    const w = newWallet();
    let signatures = 0;
    const r = await registerMerchant({
      api: h.base + "/",
      domain: "localhost:3000",
      address: w.address,
      name: "Pilot",
      expectedMode: "demo",
      now: () => h.clock.now,
      sign: async (message) => {
        signatures++;
        return w.signMessage({ message });
      },
    });
    assert.equal(signatures, 1);
    assert.equal(r.created, true);
    assert.equal(r.payoutAddress, w.address);
    assert.equal(r.payoutVerification, "siwe");
    assert.match(r.apiKey!, /^zk_/);
  } finally {
    await h.close();
  }
});

test("never signs when the API mode or the challenge is not a plain registration", async () => {
  const h = await startHarness();
  try {
    const w = newWallet();
    const sign = async () => assert.fail("must not sign");
    await assert.rejects(
      registerMerchant({ api: h.base + "/", domain: "localhost:3000", address: w.address, name: "x", expectedMode: "monitor", now: () => h.clock.now, sign }),
      /PAYMENTS_API_MODE_UNEXPECTED/,
    );
    const tamper: typeof fetch = async (url, init) => {
      const r = await fetch(url, init);
      if (!String(url).endsWith("/merchants/challenge")) return r;
      const j = await r.json();
      j.challenge.message = j.challenge.message.replace("does not authorize any transaction or token approval", "authorizes a token approval");
      return new Response(JSON.stringify(j), { status: r.status, headers: { "Content-Type": "application/json" } });
    };
    await assert.rejects(
      registerMerchant({ api: h.base + "/", domain: "localhost:3000", address: w.address, name: "x", expectedMode: "demo", now: () => h.clock.now, fetch: tamper, sign }),
      /CHALLENGE_NOT_A_PLAIN_REGISTRATION/,
    );
  } finally {
    await h.close();
  }
});

test("refuses non-loopback payment APIs", () => {
  assert.throws(() => assertLoopbackApi("https://api.zecone.xyz/"), /LOOPBACK_PAYMENTS_API_REQUIRED/);
  assert.throws(() => assertLoopbackApi("http://10.0.0.5:4321/"), /LOOPBACK_PAYMENTS_API_REQUIRED/);
  assert.equal(assertLoopbackApi("http://127.0.0.1:4321/").port, "4321");
});
