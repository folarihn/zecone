// Disposable databases only; no live payment, signer, or RPC access.
import { test } from "node:test";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { Sessions } from "../services/wallet/security.ts";
import { reviewBackend } from "../services/wallet/review-backend.ts";
import { settlementReviewApi } from "../services/wallet/settlement-review-api.ts";
import assert from "node:assert/strict";
import { Store } from "../services/execution/store.ts";
import {
  CPMM,
  POOL,
  WSOL,
  OUTPUT,
  PROGRAM_HASH,
  type SwapTerms,
} from "../services/solana/cpmm.ts";
import { SolanaSettlement } from "../services/solana/settlement.ts";
import {
  SettlementReview,
  type DeliveryRequest,
} from "../services/wallet/settlement-review.ts";
const request: DeliveryRequest = {
  profileId: "disposable",
  requestId: "wallet-transfer",
  recipient: "BAKB5pkr9akJWEMX3jnnTA6ka6DE6DFiCwpjiey1X1YQ",
  relayer: "dFmJUGpAqERawUkauLZMQdRmXVBffPqTCgX6XrM4u8k",
  lamports: "1000000",
  account: "a".repeat(64),
  paymentAddress: "utest1_SYNTHETIC_ONLY",
};
test("keyless wallet local consent grants no ownership proof or financial methods", async () => {
  const f = fixture(),
    sessions = new Sessions(f.store.db);
  const pair = sessions.pair(sessions.issuePairing());
  const backend = reviewBackend(
    sessions,
    "0x1111111111111111111111111111111111111111",
  );
  const challenge = backend.challenge(pair.session);
  assert.match(challenge.message, /not a wallet signature/);
  const result = await backend.connect(pair.session, challenge.id, true);
  assert.equal(result.walletOwnershipVerified, false);
  assert.equal(result.financialAuthority, false);
  for (const name of [
    "create",
    "quote",
    "pay",
    "recheck",
    "paymentRequest",
    "refresh",
  ] as const)
    assert.throws(() => backend[name](), /Financial operations are disabled/);
  await assert.rejects(
    backend.connect(pair.session, challenge.id, true),
    /expired/,
  );
  assert.match(backend.dashboard().readOnlyNotice!, /No wallet keys/);
  f.store.close();
});
test("local review HTTP handler binds profile, session and CSRF and exposes no execution route", async (t) => {
  const f = fixture(),
    sessions = new Sessions(f.store.db);
  const pair = sessions.pair(sessions.issuePairing());
  f.store.db
    .prepare("UPDATE sessions SET connected=1 WHERE id=?")
    .run(pair.session.id);
  const server = createServer(
    settlementReviewApi(sessions, f.review, request, [request.recipient]),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.store.close();
  });
  const post = (
    body: unknown,
    csrf = pair.session.csrf,
    path = "/api/settlement-review",
  ) =>
    new Promise<any>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port: (server.address() as any).port,
          path,
          method: "POST",
          headers: {
            Host: "127.0.0.1:3210",
            Origin: "http://127.0.0.1:3210",
            "Content-Type": "application/json",
            "X-ZecOne-CSRF": csrf,
            Cookie: `zecone_session=${pair.cookie}`,
          },
        },
        (res) => {
          let raw = "";
          res.on("data", (c) => (raw += c));
          res.on("end", () =>
            resolve({ status: res.statusCode, data: JSON.parse(raw) }),
          );
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  const body = {
    recipient: request.recipient,
    lamports: request.lamports,
    action: "transfer",
  };
  assert.equal((await post(body, "wrong")).status, 403);
  assert.equal(
    (await post({ ...body, paymentAddress: "override" })).status,
    400,
  );
  assert.equal(
    (await post(body, undefined, "/api/settlement-review/sign")).status,
    404,
  );
  const result = await post(body);
  assert.equal(result.status, 200);
  assert.equal(result.data.executionAuthorized, false);
  assert.equal(f.store.all().length, 0);
});
function fixture() {
  const store = new Store(":memory:");
  let time = 1000,
    liquidity = 100000000n,
    checks = 0;
  const network = new Proxy(
    {},
    {
      get() {
        throw Error("EXECUTION_ACCESS_FORBIDDEN");
      },
    },
  );
  const service = new SolanaSettlement(store, network as any, () => time);
  const reads = {
    check: async () => {
      checks++;
    },
    balance: async () => liquidity,
    terms: async (): Promise<never> => {
      throw Error("NO_SWAP_FIXTURE");
    },
  };
  const review = new SettlementReview(service, reads, () => time);
  return {
    store,
    service,
    reads,
    review,
    time: (v: number) => (time = v),
    liquidity: (v: bigint) => (liquidity = v),
    checks: () => checks,
  };
}
const terms: SwapTerms = {
  program: CPMM,
  pool: POOL,
  inputMint: WSOL,
  outputMint: OUTPUT,
  inputDecimals: 9,
  outputDecimals: 6,
  amountIn: "1000000",
  slippageBps: 100,
  expectedOut: "76043880",
  minimumOut: "75283441",
  programHash: PROGRAM_HASH,
};
test("swap handoff preserves reviewed route and economic limits in original engine", async () => {
  const f = fixture();
  // Policy is required by the existing engine even for order creation.
  const service = new SolanaSettlement(
    f.store,
    {} as any,
    () => 1000,
    {} as any,
  );
  const reads = { ...f.reads, terms: async () => structuredClone(terms) };
  const review = new SettlementReview(service, reads, () => 1000);
  const q = await review.review("session", request, "swap");
  assert.equal(q.debitCap, "7010000");
  const result = await review.authorize("session", q.id, q.digest, true, true);
  assert.deepEqual(service.intent(result.orderId).swap, terms);
  assert.equal(service.intent(result.orderId).recipient, request.recipient);
  assert.equal(result.executionAuthorized, false);
  f.store.close();
});
test("changed swap terms require a new review without financial creation", async () => {
  const f = fixture();
  let current = structuredClone(terms);
  const review = new SettlementReview(
    f.service,
    { ...f.reads, terms: async () => current },
    () => 1000,
  );
  const q = await review.review("session", request, "swap");
  current = { ...terms, expectedOut: "76000000", minimumOut: "75240000" };
  await assert.rejects(
    review.authorize("session", q.id, q.digest, true, true),
    /REQUOTE/,
  );
  assert.equal(f.store.all().length, 0);
  f.store.close();
});
test("a second review cannot adopt or reopen an existing paid-order identifier", async () => {
  const f = fixture();
  const a = await f.review.review("session", request, "transfer");
  await f.review.authorize("session", a.id, a.digest, true, true);
  const b = await f.review.review("session", request, "transfer");
  await assert.rejects(
    f.review.authorize("session", b.id, b.digest, true, true),
    /EXISTING_ORDER/,
  );
  assert.equal(f.store.all().length, 1);
  f.store.close();
});
test("wallet economic review creates no financial order and discloses demo pricing", async () => {
  const f = fixture();
  const q = await f.review.review("session", request, "transfer");
  assert.equal(f.store.all().length, 0);
  assert.equal(q.financialOrderCreated, false);
  assert.equal(q.executionAuthorized, false);
  assert.equal(q.debitCap, "1010000");
  assert.match(q.pricing, /DEMO/);
  assert.doesNotMatch(JSON.stringify(q), /utest1|paymentAddress|account/);
  await assert.rejects(
    f.review.authorize("session", q.id, q.digest, true),
    /FINANCIAL/,
  );
  assert.equal(f.store.all().length, 0);
  f.store.close();
});
test("explicit fixture authorization hands off to original engine once without execution", async () => {
  const f = fixture(),
    q = await f.review.review("session", request, "transfer");
  const results = await Promise.allSettled([
    f.review.authorize("session", q.id, q.digest, true, true),
    f.review.authorize("session", q.id, q.digest, true, true),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(f.store.all().length, 1);
  assert.equal(f.store.all()[0].state, "awaiting_payment");
  assert.equal(f.service.view(f.store.all()[0].id).state, "PAYMENT_PENDING");
  assert.equal(
    f.store.db.prepare("SELECT COUNT(*) n FROM payments").get()!.n,
    0,
  );
  assert.equal(f.checks(), 2);
  f.store.close();
});
test("wrong session, digest, late review and depleted liquidity fail closed", async () => {
  const f = fixture(),
    q = await f.review.review("session", request, "transfer");
  await assert.rejects(f.review.authorize("other", q.id, q.digest, true, true));
  await assert.rejects(
    f.review.authorize("session", q.id, "wrong", true, true),
  );
  f.liquidity(1n);
  await assert.rejects(
    f.review.authorize("session", q.id, q.digest, true, true),
    /LIQUIDITY/,
  );
  assert.equal(f.store.all().length, 0);
  f.liquidity(100000000n);
  const q2 = await f.review.review("session", request, "transfer");
  f.time(1090);
  await assert.rejects(
    f.review.authorize("session", q2.id, q2.digest, true, true),
  );
  f.store.close();
});
test("interrupted financial handoff is reconciliation-only after restart", async () => {
  const f = fixture(),
    q = await f.review.review("session", request, "transfer");
  f.store.db
    .prepare("UPDATE wallet_settlement_reviews SET state='CREATING' WHERE id=?")
    .run(q.id);
  const restarted = new SettlementReview(f.service, f.reads);
  await assert.rejects(
    restarted.authorize("session", q.id, q.digest, true, true),
  );
  assert.equal(
    f.store.db.prepare("SELECT state FROM wallet_settlement_reviews").get()!
      .state,
    "RECOVERY_REQUIRED",
  );
  assert.equal(f.store.all().length, 0);
  f.store.close();
});
