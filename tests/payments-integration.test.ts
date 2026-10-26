// Merchant integration tests for the ZecOne payment API: wallet-ownership
// onboarding, credential scoping, payment creation/idempotency/expiry,
// single-active-checkout attribution, liquidity guard, signed webhooks with
// retries, the server-side demo observer and the live-mode refusal.
// All synthetic: ephemeral keys, temporary databases, no chain access.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO_PAYOUT, OPERATOR_TOKEN, ORIGIN, newWallet, onboard, startHarness } from "./helpers/payments-harness.ts";
import { createPaymentsApp, DEFAULT_CHECKOUT_ADDRESS } from "../services/payments/api.ts";
import { verifySignature } from "../services/payments/webhooks.ts";
import { MAINNET_EVIDENCE } from "../services/payments/demo.ts";

const PAY = (amountUsd = "1.00", extra: Record<string, unknown> = {}) => ({ amountUsd, payoutChain: "base", ...extra });

test("onboarding: wallet signature issues a merchant key bound to the verified payout address", async () => {
  const h = await startHarness();
  try {
    const { wallet, apiKey, session, merchant } = await onboard(h);
    assert.match(apiKey, /^zk_[0-9a-f]{24}_sk_[0-9a-f]{48}$/);
    assert.match(session, /^zs_[0-9a-f]{24}_[0-9a-f]{64}$/);
    assert.equal(merchant.payoutAddress, wallet.address);
    assert.equal(merchant.payoutVerification, "siwe");
    // The key works and defaults the recipient to the verified address.
    const created = await h.call("/api/v1/payments", { key: apiKey, body: PAY() });
    assert.equal(created.status, 201);
    assert.equal(created.body.payment.request.recipient, wallet.address);
    // Signing in again does not mint a second key.
    const again = await onboard(h, wallet);
    assert.equal(again.apiKey, null);
  } finally {
    await h.close();
  }
});

test("onboarding: forged, replayed, tampered, foreign-domain and expired proofs are rejected", async () => {
  const h = await startHarness();
  try {
    const victim = newWallet();
    const attacker = newWallet();
    // A bare address yields only a challenge, never a credential.
    const ch = await h.call("/api/v1/merchants/challenge", {
      key: null,
      body: { address: victim.address, chainId: 8453, ...ORIGIN },
    });
    assert.equal(ch.status, 201);
    assert.equal(ch.body.apiKey, undefined);
    const message: string = ch.body.challenge.message;
    // Attacker signs the victim's challenge.
    const forged = await h.call("/api/v1/merchants/verify", {
      key: null,
      body: { message, signature: await attacker.signMessage({ message }) },
    });
    assert.equal(forged.status, 401);
    assert.equal(forged.body.error.code, "signature_invalid");
    // The nonce was consumed by the failed attempt: replay with a valid signature fails too.
    const replay = await h.call("/api/v1/merchants/verify", {
      key: null,
      body: { message, signature: await victim.signMessage({ message }) },
    });
    assert.equal(replay.status, 400);
    assert.equal(replay.body.error.code, "challenge_invalid");
    // Tampered message (address swapped) is not the issued challenge.
    const ch2 = await h.call("/api/v1/merchants/challenge", { key: null, body: { address: victim.address, chainId: 8453, ...ORIGIN } });
    const tampered = ch2.body.challenge.message.replace(victim.address, attacker.address);
    const t = await h.call("/api/v1/merchants/verify", {
      key: null,
      body: { message: tampered, signature: await attacker.signMessage({ message: tampered }) },
    });
    assert.equal(t.status, 401);
    assert.equal(t.body.error.code, "message_mismatch");
    // Disallowed domain and unsupported chain.
    const dom = await h.call("/api/v1/merchants/challenge", {
      key: null,
      body: { address: victim.address, chainId: 8453, domain: "evil.example", uri: "https://evil.example/" },
    });
    assert.equal(dom.status, 400);
    assert.equal(dom.body.error.code, "domain_not_allowed");
    const chain = await h.call("/api/v1/merchants/challenge", { key: null, body: { address: victim.address, chainId: 1, ...ORIGIN } });
    assert.equal(chain.body.error.code, "unsupported_chain");
    // Expired challenge.
    const ch3 = await h.call("/api/v1/merchants/challenge", { key: null, body: { address: victim.address, chainId: 8453, ...ORIGIN } });
    h.clock.now += 601;
    const late = await h.call("/api/v1/merchants/verify", {
      key: null,
      body: { message: ch3.body.challenge.message, signature: await victim.signMessage({ message: ch3.body.challenge.message }) },
    });
    assert.equal(late.status, 400);
    assert.equal(late.body.error.code, "challenge_invalid");
  } finally {
    await h.close();
  }
});

test("authorization: keys, sessions, scopes, rotation and cross-merchant isolation", async () => {
  const h = await startHarness();
  try {
    const a = await onboard(h, newWallet(), "A");
    const b = await onboard(h, newWallet(), "B");
    assert.equal((await h.call("/api/v1/payments", { key: null })).status, 401);
    assert.equal((await h.call("/api/v1/payments", { key: "zk_" + "a".repeat(24) + "_nope" })).status, 401);
    // Session-only actions refuse API keys.
    const rot = await h.call("/api/v1/merchant/keys", { key: a.apiKey, body: {} });
    assert.equal(rot.status, 403);
    assert.equal(rot.body.error.code, "session_required");
    // Merchant B cannot read merchant A's payment.
    const pa = await h.call("/api/v1/payments", { key: a.apiKey, body: PAY() });
    assert.equal((await h.call(`/api/v1/payments/${pa.body.payment.id}`, { key: b.apiKey })).status, 404);
    assert.equal((await h.call(`/api/v1/payments/${pa.body.payment.id}`, { key: a.apiKey })).status, 200);
    // History is merchant-specific.
    const listB = await h.call("/api/v1/payments", { key: b.apiKey });
    assert.equal(listB.body.payments.length, 0);
    // Rotation with revokeOthers disables the old key.
    const rotated = await h.call("/api/v1/merchant/keys", { key: a.session, body: { revokeOthers: true } });
    assert.equal(rotated.status, 201);
    assert.equal((await h.call("/api/v1/payments", { key: a.apiKey })).status, 401);
    assert.equal((await h.call("/api/v1/payments", { key: rotated.body.apiKey })).status, 200);
    // Sessions expire.
    h.clock.now += 3601;
    assert.equal((await h.call("/api/v1/merchant", { key: a.session })).status, 401);
  } finally {
    await h.close();
  }
});

test("payments: recipient must be the verified payout address; changing it needs a new wallet proof", async () => {
  const h = await startHarness();
  try {
    const m = await onboard(h);
    const other = newWallet();
    const bad = await h.call("/api/v1/payments", { key: m.apiKey, body: PAY("1.00", { recipient: other.address }) });
    assert.equal(bad.status, 403);
    assert.equal(bad.body.error.code, "recipient_not_verified");
    // Prove control of the new address with the dashboard session.
    const ch = await h.call("/api/v1/merchant/payout-address/challenge", {
      key: m.session,
      body: { address: other.address, chainId: 8453, ...ORIGIN },
    });
    assert.equal(ch.status, 201);
    // Signed by the old wallet: rejected.
    const wrong = await h.call("/api/v1/merchant/payout-address", {
      key: m.session,
      body: { message: ch.body.challenge.message, signature: await m.wallet.signMessage({ message: ch.body.challenge.message }) },
    });
    assert.equal(wrong.status, 401);
    const ch2 = await h.call("/api/v1/merchant/payout-address/challenge", {
      key: m.session,
      body: { address: other.address, chainId: 8453, ...ORIGIN },
    });
    const ok = await h.call("/api/v1/merchant/payout-address", {
      key: m.session,
      body: { message: ch2.body.challenge.message, signature: await other.signMessage({ message: ch2.body.challenge.message }) },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.merchant.payoutAddress, other.address);
    const good = await h.call("/api/v1/payments", { key: m.apiKey, body: PAY("1.00", { recipient: other.address }) });
    assert.equal(good.status, 201);
  } finally {
    await h.close();
  }
});

test("payments: validation and safe errors", async () => {
  const h = await startHarness();
  try {
    for (const [body, code] of [
      [{ amountUsd: 1 }, "invalid_amount"],
      [{ amountUsd: "1.001" }, "invalid_amount"],
      [{ amountUsd: "0.00" }, "invalid_amount"],
      [{ amountUsd: "999.00" }, "amount_too_large"],
      [{ amountUsd: "1.00", payoutChain: "solana" }, "unsupported_chain"],
      [{ amountUsd: "1.00", recipient: "0xnotanaddress" }, "invalid_recipient"],
      [{ amountUsd: "1.00", metadata: "x" }, "invalid_metadata"],
    ] as const) {
      const r = await h.call("/api/v1/payments", { body });
      assert.equal(r.status >= 400 && r.status < 500, true, JSON.stringify(body));
      assert.equal(r.body.error.code, code, JSON.stringify(body));
    }
    const raw = await fetch(`${h.base}/api/v1/payments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${h.app.demoApiKey}`, "Content-Type": "application/json" },
      body: "{not json",
    });
    assert.equal(raw.status, 400);
    assert.equal((await raw.json()).error.code, "invalid_json");
  } finally {
    await h.close();
  }
});

test("payments: idempotency keys return the original payment and reject a different body", async () => {
  const h = await startHarness();
  try {
    const headers = { "Idempotency-Key": "order-42" };
    const a = await h.call("/api/v1/payments", { body: PAY("2.00", { metadata: { orderId: "42" } }), headers });
    const b = await h.call("/api/v1/payments", { body: PAY("2.00", { metadata: { orderId: "42" } }), headers });
    assert.equal(a.status, 201);
    assert.equal(b.status, 200);
    assert.equal(b.body.idempotent, true);
    assert.equal(b.body.payment.id, a.body.payment.id);
    const c = await h.call("/api/v1/payments", { body: PAY("3.00", { metadata: { orderId: "42" } }), headers });
    assert.equal(c.status, 409);
    assert.equal(c.body.error.code, "idempotency_conflict");
    // Concurrent duplicates with one key collapse to a single payment.
    const many = await Promise.all(
      Array.from({ length: 6 }, () => h.call("/api/v1/payments", { body: PAY("2.00", { metadata: { orderId: "42" } }), headers })),
    );
    assert.equal(new Set(many.map((r) => r.body.payment.id)).size, 1);
    const list = await h.call("/api/v1/payments");
    assert.equal(list.body.payments.length, 1);
  } finally {
    await h.close();
  }
});

test("demo checkouts expire and cancel; expiry is recorded and webhooks fire", async () => {
  const h = await startHarness({ demoObserver: { enabled: false, startAfterSeconds: 10, stepSeconds: 2 } });
  try {
    const first = await h.call("/api/v1/payments", { body: PAY("1.00") });
    const second = await h.call("/api/v1/payments", { body: PAY("1.00") });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201); // demo holds no real address, so no allocation conflict
    const canceled = await h.call(`/api/v1/payments/${first.body.payment.id}/cancel`, { method: "POST", body: {} });
    assert.equal(canceled.body.payment.state, "EXPIRED");
    assert.equal((await h.call(`/api/v1/payments/${first.body.payment.id}/cancel`, { method: "POST", body: {} })).body.error.code, "not_cancelable");
    h.clock.now += 901;
    await h.app.tick();
    const after = await h.call(`/api/v1/payments/${second.body.payment.id}`);
    assert.equal(after.body.payment.state, "EXPIRED");
    const events = await h.call(`/api/v1/payments/${second.body.payment.id}/events`);
    assert.equal(events.body.events.at(-1).type, "payment.expired");
    assert.equal(events.body.events.at(-1).data.reason, "quote_expired");
  } finally {
    await h.close();
  }
});

test("demo: only the server-side observer completes payments; no public completion endpoint", async () => {
  const h = await startHarness();
  try {
    const created = await h.call("/api/v1/payments", { body: PAY("1.00") });
    const id = created.body.payment.id;
    // The legacy unauthenticated demo-advance route no longer exists.
    assert.equal((await h.call(`/api/v1/demo/${id}`, { method: "POST", key: null, body: {} })).status, 404);
    // Operator replay needs the operator token.
    assert.equal((await h.call(`/api/v1/operator/demo-replay/${id}`, { method: "POST", key: null, body: {} })).status, 404);
    assert.equal((await h.call(`/api/v1/operator/demo-replay/${id}`, { method: "POST", key: h.app.demoApiKey, body: {} })).status, 404);
    // Receipt does not exist before completion.
    assert.equal((await h.call(`/api/v1/payments/${id}/receipt`)).body.error.code, "not_completed");
    // Observer waits, then replays one recorded step per interval.
    await h.app.tick();
    assert.equal((await h.call(`/api/v1/payments/${id}`)).body.payment.state, "AWAITING_PAYMENT");
    for (let i = 0; i < 12; i++) {
      h.clock.now += 10;
      await h.app.tick();
    }
    const done = (await h.call(`/api/v1/payments/${id}`)).body.payment;
    assert.equal(done.state, "COMPLETED");
    assert.equal(done.evidenceKind, "recorded-mainnet-replay");
    assert.equal(done.payoutTxHash, MAINNET_EVIDENCE.basePayout.txHash);
    const receipt = (await h.call(`/api/v1/payments/${id}/receipt`)).body.receipt;
    assert.equal(receipt.evidenceKind, "recorded-mainnet-replay");
    assert.match(receipt.evidenceNote, /SIMULATED/);
    assert.match(receipt.evidenceNote, /No funds moved/);
    assert.equal(receipt.simulated, true);
    const events = (await h.call(`/api/v1/payments/${id}/events`)).body.events;
    assert.ok(events.filter((e: { state: string }) => e.state !== "CREATED" && e.state !== "QUOTED" && e.state !== "AWAITING_PAYMENT").every((e: { data: { evidence?: string } }) => e.data.evidence === "recorded-mainnet-replay"));
    // Operator replay with the token works for a fresh demo payment.
    const second = await h.call("/api/v1/payments", { body: PAY("1.00") });
    const op = await h.call(`/api/v1/operator/demo-replay/${second.body.payment.id}`, {
      method: "POST",
      key: OPERATOR_TOKEN,
      body: {},
    });
    assert.equal(op.status, 200);
    assert.equal(op.body.payment.state, "COMPLETED");
  } finally {
    await h.close();
  }
});

test("hosted checkout view is token-scoped and leaks no merchant metadata", async () => {
  const h = await startHarness();
  try {
    const created = (await h.call("/api/v1/payments", { body: PAY("1.00", { metadata: { customerEmail: "secret@example.com" } }) })).body
      .payment;
    assert.match(created.checkoutUrl, /^http:\/\/localhost:3000\/pay\/pay_[0-9a-f]{26}\?t=[0-9a-f]{40}$/);
    // Demo checkouts never expose a payable address or payment URI.
    assert.equal(created.paymentUri, null);
    assert.equal(created.zcashAddress, null);
    assert.equal(created.simulated, true);
    const noToken = await h.call(`/api/v1/checkout/${created.id}`, { key: null });
    assert.equal(noToken.status, 404);
    const wrong = await h.call(`/api/v1/checkout/${created.id}?token=${"0".repeat(40)}`, { key: null });
    assert.equal(wrong.status, 404);
    const view = await h.call(`/api/v1/checkout/${created.id}?token=${created.checkoutToken}`, { key: null });
    assert.equal(view.status, 200);
    assert.equal(view.headers.get("access-control-allow-origin"), "*");
    const json = JSON.stringify(view.body);
    assert.ok(!json.includes("secret@example.com"));
    assert.ok(!json.includes("merchantId"));
    assert.equal(view.body.checkout.quote.zecAmount, "0.02");
    assert.equal(view.body.checkout.zcashAddress, null);
    assert.equal(view.body.checkout.simulated, true);
    // Authenticated endpoints expose no CORS headers.
    const authed = await h.call("/api/v1/payments");
    assert.equal(authed.headers.get("access-control-allow-origin"), null);
  } finally {
    await h.close();
  }
});

test("webhooks: signed deliveries, retry with backoff, final failure and ping", async () => {
  const received: { body: string; headers: Record<string, string> }[] = [];
  let failNext = 2;
  const h = await startHarness({}, async (url, init) => {
    const headers = init.headers as Record<string, string>;
    if (url.endsWith("/gone")) return { ok: false, status: 410 };
    if (failNext > 0) {
      failNext--;
      return { ok: false, status: 503 };
    }
    received.push({ body: String(init.body), headers });
    return { ok: true, status: 200 };
  });
  try {
    const m = await onboard(h);
    const reg = await h.call("/api/v1/webhooks", { key: m.apiKey, body: { url: "http://127.0.0.1:9/hook" } });
    assert.equal(reg.status, 201);
    const secret: string = reg.body.webhook.secret;
    assert.match(secret, /^whsec_[0-9a-f]{48}$/);
    assert.equal((await h.call("/api/v1/webhooks", { key: m.apiKey, body: { url: "http://example.com/hook" } })).status, 400);
    const payment = (await h.call("/api/v1/payments", { key: m.apiKey, body: PAY("1.00") })).body.payment;
    // First drain: 503 twice -> retried, not lost.
    await h.app.dispatcher.drain(h.clock.now);
    await h.app.dispatcher.drain(h.clock.now);
    let deliveries = (await h.call("/api/v1/webhooks", { key: m.apiKey })).body.deliveries;
    assert.ok(deliveries.some((d: { status: string; attempts: number }) => d.status === "pending" && d.attempts >= 1));
    // Advance past the backoff window and run the observer to completion.
    for (let i = 0; i < 20; i++) {
      h.clock.now += 10;
      await h.app.tick();
    }
    deliveries = (await h.call("/api/v1/webhooks", { key: m.apiKey })).body.deliveries;
    assert.ok(deliveries.every((d: { status: string }) => d.status === "delivered"));
    const completed = received.find((r) => JSON.parse(r.body).type === "payment.completed");
    assert.ok(completed, "payment.completed delivered");
    const sig = completed!.headers["X-ZecOne-Signature"];
    assert.ok(verifySignature(secret, completed!.body, sig, { now: h.clock.now }));
    assert.equal(verifySignature("whsec_wrong", completed!.body, sig, { now: h.clock.now }), false);
    assert.equal(verifySignature(secret, completed!.body.replace("COMPLETED", "FAILED"), sig, { now: h.clock.now }), false);
    const env = JSON.parse(completed!.body);
    assert.equal(env.payment.id, payment.id);
    assert.equal(env.livemode, false);
    assert.match(env.id, /^evt_\d+$/);
    // Event ids are unique per event (merchants de-duplicate on them).
    const ids = received.map((r) => JSON.parse(r.body).id);
    assert.equal(new Set(ids).size, ids.length);
    // Ping.
    const ping = await h.call("/api/v1/webhooks/test", { key: m.apiKey, body: {} });
    assert.equal(ping.body.outcome, "delivered");
    // A 4xx is final (no retry storm).
    await h.call("/api/v1/webhooks", { key: m.apiKey, body: { url: "http://127.0.0.1:9/gone" } });
    const gone = await h.call("/api/v1/webhooks/test", { key: m.apiKey, body: {} });
    assert.equal(gone.body.outcome, "failed");
    assert.equal(gone.body.delivery.status, "failed");
  } finally {
    await h.close();
  }
});

test("live mode cannot be enabled on the merchant API", () => {
  const dir = mkdtempSync(join(tmpdir(), "zecone-live-"));
  try {
    assert.throws(
      () =>
        createPaymentsApp({
          dbPath: join(dir, "p.sqlite"),
          checkoutAddress: DEFAULT_CHECKOUT_ADDRESS,
          mode: "live",
          siwe: { allowedDomains: [], ttlSeconds: 60 },
          publicCheckoutBaseUrl: "http://localhost:3000",
          exclusiveAllocation: true,
          quoteTtlSeconds: 900,
          maxAmountUsd: "1.00",
          relayerAvailableWei: 0n,
          demoObserver: { enabled: false, startAfterSeconds: 1, stepSeconds: 1 },
          allowLoopbackHttpWebhooks: false,
          sessionTtlSeconds: 60,
        }),
      /LIVE_MODE_DISABLED/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("health reports live payout and Zcash broadcast disabled", async () => {
  const h = await startHarness();
  try {
    const r = await h.call("/api/v1/health", { key: null });
    assert.equal(r.body.livePayoutEnabled, false);
    assert.equal(r.body.zcashBroadcastEnabled, false);
    assert.equal(r.body.attribution, "none-simulated");
    assert.equal(r.body.mode, "demo");
    const q = await h.call("/api/v1/quote/preview?amountUsd=1.00", { key: null });
    assert.equal(q.body.zecAmount, "0.02");
    assert.equal(q.body.rateSource, "demo-fixed");
  } finally {
    await h.close();
  }
});
