// All payment and signer-chain evidence in this file is SYNTHETIC. No broadcasts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  createPublicKey,
} from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { type Hex } from "viem";
import { Store, type Snapshot } from "../services/execution/store.ts";
import { executeOne } from "../services/execution/worker.ts";
import {
  Lifecycle,
  STATES,
  type SettlementState,
} from "../services/settlement/lifecycle.ts";
import { Refunds } from "../services/settlement/refunds.ts";
import {
  approveRequest,
  amount,
  canonical,
  digest,
  userMessage,
  type RefundRequest,
} from "../services/settlement/protocol.ts";
import {
  encrypt,
  decrypt,
  ApprovalVault,
  stageEncryptedCopy,
} from "../services/signer/keystore.ts";
import {
  IndependentRefundReviewer,
  type IndependentEvidence,
} from "../services/signer/refund-review.ts";
import {
  consensus,
  decimalUsd,
  quoteReference,
  checkQuote,
  reference,
  type Price,
} from "../services/pricing/reference.ts";
import { listingHandoff } from "../services/opensea/handoff.ts";
import { NativeDestinationDecoder } from "../services/settlement/native-address.ts";

const key = () => generateKeyPairSync("ed25519"),
  hex = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const destination = JSON.parse(readFileSync("docs/PUBLIC_WALLETS.json", "utf8"))
  .zcash.payer.address as string;
const decoder = {
  async validate(s: string) {
    if (s !== destination) throw Error("synthetic_decoder_reject");
  },
};
function fixture(value = "1000000", height = 90) {
  const dir = mkdtempSync(join(tmpdir(), "zecone-phase5-")),
    path = join(dir, "fixture.sqlite"),
    store = new Store(path),
    user = privateKeyToAccount(generatePrivateKey()),
    operator = key(),
    signer = key();
  let now = 1000;
  const id = hex(1),
    intent = {
      recipient: user.address,
      zatoshis: "1000000",
      nonce: hex(2),
      expiry: 2000,
      contract: user.address,
      signature: "0x" as Hex,
    };
  store.create(id, intent, "synthetic-account", "synthetic-address", now);
  const snapshot: Snapshot = {
    network: "zcash-testnet",
    tip: 100,
    scanned: 100,
    observedAt: now,
    payments: [
      {
        account: "synthetic-account",
        txid: "a".repeat(64),
        pool: 4,
        index: 0,
        zatoshis: value,
        height,
        blockHash: "b".repeat(64),
      },
    ],
  };
  store.observe(snapshot, now);
  store.transition(id, "recovery", now);
  const refunds = new Refunds(
    store,
    operator.publicKey,
    signer.publicKey,
    decoder,
    () => now,
  );
  const sign = (r: RefundRequest) =>
    user.signMessage({ message: userMessage(r) });
  const request = async () => {
    const r = await refunds.draft(id, destination, "10000");
    await refunds.request(r, await sign(r));
    return r;
  };
  return {
    dir,
    path,
    store,
    user,
    operator,
    signer,
    id,
    intent,
    snapshot,
    refunds,
    sign,
    request,
    setTime: (t: number) => {
      now = t;
    },
  };
}
test("refund service refuses a lower-confirmation payment store", () => {
  const store = new Store(":memory:", 1),
    operator = key(),
    signer = key();
  assert.throws(
    () => new Refunds(store, operator.publicKey, signer.publicKey, decoder),
    /requires_ten_confirmations/,
  );
  store.close();
});

test("in-flight EVM signing excludes refund approval and concurrent signing before a hash exists", async () => {
  const f = fixture(),
    r = await f.request(),
    other = new Store(f.path);
  f.store.transition(f.id, "verified", 1000);
  let release!: () => void,
    entered!: () => void,
    prepares = 0;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const executor = {
    async prepare() {
      prepares++;
      entered();
      await gate;
      return { raw: "0x12" as Hex, hash: hex(9) };
    },
    async broadcast() {
      throw Error("must_not_broadcast");
    },
    async receipt() {
      return { status: "pending" as const };
    },
  };
  const first = executeOne(f.store, f.id, executor, () => 1000);
  const rejected = assert.rejects(first, /payment no longer eligible/);
  await started;
  await executeOne(other, f.id, executor, () => 1000);
  assert.equal(prepares, 1);
  other.transition(f.id, "recovery", 1000);
  assert.equal(other.get(f.id)!.tx_hash, null);
  assert.throws(
    () =>
      f.refunds.approve(
        r.id,
        approveRequest("operator", r, f.operator.privateKey),
      ),
    /construction_requires_reconciliation/,
  );
  release();
  await rejected;
  other.close();
  f.store.close();
});

test("crash after execution claim blocks re-signing and refunds after restart", async () => {
  const f = fixture();
  f.store.transition(f.id, "verified", 1000);
  assert.equal(f.store.claimPreparation(f.id, 1000), true);
  f.store.close();
  const reopened = new Store(f.path);
  let prepares = 0;
  await executeOne(
    reopened,
    f.id,
    {
      async prepare() {
        prepares++;
        throw Error("must_not_sign");
      },
      async broadcast() {
        throw Error("must_not_broadcast");
      },
      async receipt() {
        return { status: "pending" };
      },
    },
    () => 1000,
  );
  assert.equal(prepares, 0);
  reopened.transition(f.id, "recovery", 1000);
  const refunds = new Refunds(
    reopened,
    f.operator.publicKey,
    f.signer.publicKey,
    decoder,
    () => 1000,
  );
  await assert.rejects(
    refunds.draft(f.id, destination, "10000"),
    /construction_requires_reconciliation/,
  );
  reopened.transition(f.id, "failed", 1000);
  assert.throws(() => reopened.retry(f.id, 1000), /confirmed revert/);
  reopened.close();
});

test("constructor failure records recovery and retains its anti-replay claim", async () => {
  const f = fixture();
  f.store.transition(f.id, "verified", 1000);
  let prepares = 0;
  const executor = {
    async prepare() {
      prepares++;
      throw Error("synthetic_constructor_failure");
    },
    async broadcast() {
      throw Error("must_not_broadcast");
    },
    async receipt() {
      return { status: "pending" as const };
    },
  };
  await assert.rejects(
    executeOne(f.store, f.id, executor, () => 1000),
    /synthetic_constructor_failure/,
  );
  assert.equal(f.store.get(f.id)!.state, "recovery");
  assert.equal(
    f.store.db
      .prepare("SELECT reason FROM recoveries WHERE order_id=?")
      .get(f.id)!.reason,
    "execution_construction_uncertain",
  );
  await executeOne(f.store, f.id, executor, () => 1000);
  assert.equal(prepares, 1);
  await assert.rejects(
    f.refunds.draft(f.id, destination, "10000"),
    /construction_requires_reconciliation/,
  );
  f.store.close();
});

test("Phase 5 graph rejects skipped transitions, stale writers and refunds after completion", () => {
  const db = new DatabaseSync(":memory:"),
    l = new Lifecycle(db),
    id = randomUUID();
  l.create(id, { fixture: true }, 1000);
  assert.throws(
    () => l.transition(id, 0, "COMPLETED", "skip", 1000),
    /invalid_transition/,
  );
  const success: SettlementState[] = [
    "QUOTED",
    "USER_APPROVED",
    "AWAITING_PAYMENT",
    "PAYMENT_DETECTED",
    "CONFIRMING",
    "PAYMENT_CONFIRMED",
    "LIQUIDITY_RESERVED",
    "EXECUTION_READY",
    "EXECUTING",
    "EXECUTION_UNCERTAIN",
    "COMPLETED",
  ];
  for (const next of success) {
    const row = l.get(id)!;
    l.transition(id, row.version, next, "fixture", 1000);
  }
  assert.throws(
    () => l.transition(id, l.get(id)!.version, "REFUND_REQUESTED", "bad", 1000),
    /invalid_transition/,
  );
  assert.throws(
    () => l.transition(id, 0, "QUOTED", "stale", 1000),
    /stale_transition/,
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM settlement_events").get()!.n,
    12,
  );
  assert.equal(STATES.length, 20);
  db.close();
});
test("Phase 5 refund graph retains an execution veto after recovery and restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "zecone-graph-")),
    path = join(dir, "graph.sqlite");
  let db = new DatabaseSync(path),
    l = new Lifecycle(db);
  const id = randomUUID();
  l.create(id, {}, 1000);
  for (const next of [
    "QUOTED",
    "RECOVERY_REQUIRED",
    "REFUND_REQUESTED",
    "REFUND_APPROVED",
    "REFUND_SIGNING",
    "RECOVERY_REQUIRED",
  ] as SettlementState[])
    l.transition(id, l.get(id)!.version, next, "fixture", 1000);
  db.close();
  db = new DatabaseSync(path);
  l = new Lifecycle(db);
  assert.equal(l.view(id).executionBlocked, true);
  assert.throws(() =>
    l.transition(id, l.get(id)!.version, "EXECUTING", "race", 1000),
  );
  db.close();
});
test("duplicate user requests and operator approvals are idempotent; second refund is refused", async () => {
  const f = fixture(),
    r = await f.request(),
    sig = await f.sign(r),
    op = approveRequest("operator", r, f.operator.privateKey);
  assert.equal((await f.refunds.request(r, sig)).id, r.id);
  f.refunds.approve(r.id, op);
  f.refunds.approve(r.id, op);
  const second = { ...r, id: randomUUID() };
  await assert.rejects(
    f.refunds.request(second, await f.sign(second)),
    /duplicate_refund_order/,
  );
  assert.equal(
    f.store.db.prepare("SELECT count(*) n FROM settlement_refunds").get()!.n,
    1,
  );
  f.store.close();
});
test("wrong user, destination, operator and signer approval cannot authorize a refund", async () => {
  const f = fixture(),
    r = await f.refunds.draft(f.id, destination, "10000"),
    outsider = privateKeyToAccount(generatePrivateKey());
  await assert.rejects(
    f.refunds.request(
      r,
      await outsider.signMessage({ message: userMessage(r) }),
    ),
    /user_authorization/,
  );
  await assert.rejects(
    f.refunds.draft(f.id, "utest1incorrectchecksum", "10000"),
    /decoder/,
  );
  await f.refunds.request(r, await f.sign(r));
  assert.throws(
    () =>
      f.refunds.approve(r.id, approveRequest("operator", r, key().privateKey)),
    /operator_authorization/,
  );
  f.refunds.approve(r.id, approveRequest("operator", r, f.operator.privateKey));
  assert.throws(
    () =>
      f.refunds.acceptSignerApproval(
        r.id,
        approveRequest("signer", r, f.operator.privateKey),
      ),
    /signer_authorization/,
  );
  f.store.close();
});
test("refund approval wins race against EVM preparation, including a second connection", async () => {
  const f = fixture(),
    r = await f.request(),
    other = new Store(f.path);
  f.refunds.approve(r.id, approveRequest("operator", r, f.operator.privateKey));
  other.transition(f.id, "verified", 1000);
  assert.equal(other.eligible(other.get(f.id)!, 1000), false);
  assert.throws(
    () => other.prepared(f.id, "0x12", hex(9), 1000),
    /no longer eligible/,
  );
  other.transition(f.id, "failed", 1000);
  assert.throws(() => other.retry(f.id, 1000), /confirmed revert/);
  other.close();
  f.store.close();
});
test("saved EVM transaction wins race and prevents refund even if receipt is called failed", async () => {
  const f = fixture(),
    r = await f.request();
  f.store.transition(f.id, "verified", 1000);
  f.store.prepared(f.id, "0x12", hex(9), 1000);
  f.store.failed(f.id, 1000);
  assert.throws(
    () =>
      f.refunds.approve(
        r.id,
        approveRequest("operator", r, f.operator.privateKey),
      ),
    /execution_not_proven_impossible/,
  );
  f.store.close();
});
test("execution worker cannot broadcast after a durable refund veto and restart", async () => {
  const f = fixture(),
    r = await f.request();
  f.refunds.approve(r.id, approveRequest("operator", r, f.operator.privateKey));
  f.store.close();
  const reopened = new Store(f.path);
  reopened.transition(f.id, "verified", 1000);
  let calls = 0;
  await executeOne(
    reopened,
    f.id,
    {
      async prepare() {
        calls++;
        return { raw: "0x" as Hex, hash: hex(3) };
      },
      async broadcast() {
        calls++;
        return hex(3);
      },
      async receipt() {
        calls++;
        return { status: "pending" };
      },
    },
    () => 1000,
  );
  assert.equal(calls, 0);
  reopened.close();
});
test("completed purchase cannot enter refund authorization", async () => {
  const f = fixture();
  f.store.settled(f.id, { synthetic: true }, 1000);
  await assert.rejects(f.request(), /execution_not_proven_impossible/);
  f.store.close();
});
test("underpayment and overpayment refunds are bounded by confirmed receipts and explicit fee", async () => {
  for (const total of ["900000", "1100000"]) {
    const f = fixture(total),
      r = await f.request();
    assert.equal(
      BigInt(r.refundZatoshis) + BigInt(r.feeCeilingZatoshis),
      BigInt(total),
    );
    f.store.close();
  }
});
test("nine confirmations, stale scans, dust, and overflow cannot authorize refund", async () => {
  const f = fixture("1000000", 92);
  await assert.rejects(f.request(), /fully_confirmed/);
  f.store.close();
  const g = fixture();
  g.setTime(1121);
  await assert.rejects(g.request(), /stale/);
  g.store.close();
  const h = fixture("9999");
  await assert.rejects(h.request(), /dust/);
  h.store.close();
  for (const v of ["2100000000000001", "-1", "1e6", "01", "9".repeat(100)])
    assert.throws(() => amount(v));
});
test("expired request and changed payment attribution never receive operator approval", async () => {
  const f = fixture(),
    r = await f.request();
  f.setTime(r.expires);
  assert.throws(
    () =>
      f.refunds.approve(
        r.id,
        approveRequest("operator", r, f.operator.privateKey),
      ),
    /expired/,
  );
  f.store.close();
  const g = fixture(),
    q = await g.request();
  g.store.observe(
    {
      ...g.snapshot,
      payments: [{ ...g.snapshot.payments[0]!, blockHash: "c".repeat(64) }],
    },
    1000,
  );
  assert.throws(
    () =>
      g.refunds.approve(
        q.id,
        approveRequest("operator", q, g.operator.privateKey),
      ),
    /evidence_changed/,
  );
  g.store.close();
});
test("reorg after approval requires recovery, preserves veto and forbids blind replacement", async () => {
  const f = fixture(),
    r = await f.request();
  f.refunds.approve(r.id, approveRequest("operator", r, f.operator.privateKey));
  f.store.observe({ ...f.snapshot, payments: [] }, 1000);
  assert.equal(f.refunds.reconcilePayment(r.id).state, "RECOVERY_REQUIRED");
  assert.equal(
    f.store.db
      .prepare("SELECT count(*) n FROM settlement_execution_veto")
      .get()!.n,
    1,
  );
  assert.throws(() => f.refunds.exportUnsigned(r.id), /not_approved/);
  assert.throws(() => f.refunds.broadcast(), /not_enabled/);
  f.store.close();
});
test("public refund view never exposes payment mappings or pretends to confirm a refund", async () => {
  const f = fixture(),
    r = await f.request(),
    view = f.refunds.view(r.id);
  assert.equal(view.refundConfirmed, false);
  assert.equal(view.liveTransportAvailable, false);
  const s = JSON.stringify(view);
  for (const privateValue of [
    destination,
    r.paymentDigest,
    r.intentDigest,
    f.user.address,
  ])
    assert(!s.includes(privateValue));
  f.store.close();
});
test("independent signer rechecks its own evidence and requires exact explicit review", async () => {
  const f = fixture(),
    r = await f.request();
  f.refunds.approve(r.id, approveRequest("operator", r, f.operator.privateKey));
  const bundle = f.refunds.exportUnsigned(r.id);
  const secret = f.signer.privateKey.export({ format: "der", type: "pkcs8" }),
    password = randomBytes(32),
    encrypted = await encrypt(secret, password, "signer-approval");
  secret.fill(0);
  const vault = new ApprovalVault("signer"),
    db = new DatabaseSync(join(f.dir, "signer.sqlite"));
  let evidence: IndependentEvidence = {
    network: "zcash-testnet",
    orderId: r.orderId,
    intentDigest: r.intentDigest,
    paymentDigest: r.paymentDigest,
    recipient: r.recipient,
    destination: r.destination,
    eligibleZatoshis: r.eligibleZatoshis,
    tip: 100,
    scanned: 100,
    observedAt: 1000,
    minimumConfirmations: 11,
    execution: "never-constructed",
    orderState: "recovery",
  };
  const reviewer = new IndependentRefundReviewer(
    db,
    f.operator.publicKey,
    vault,
    {
      async read() {
        return { ...evidence };
      },
      validateShieldedDestination: decoder.validate,
    },
    () => 1000,
  );
  await assert.rejects(reviewer.approve(bundle, digest(r)), /locked/);
  await vault.unlock(encrypted, password, true);
  evidence = { ...evidence, eligibleZatoshis: "900000" };
  await assert.rejects(
    reviewer.approve(bundle, digest(r)),
    /independent_evidence_mismatch/,
  );
  evidence.eligibleZatoshis = r.eligibleZatoshis;
  await assert.rejects(
    reviewer.approve(bundle, "incorrect-review"),
    /explicit_review/,
  );
  const approval = await reviewer.approve(bundle, digest(r));
  assert.deepEqual(await reviewer.approve(bundle, digest(r)), approval);
  assert.equal(
    f.refunds.acceptSignerApproval(r.id, approval).state,
    "REFUND_SIGNING",
  );
  assert.equal(f.refunds.view(r.id).transactionId, null);
  const changed = { ...r, id: randomUUID() },
    replay = {
      request: changed,
      userSignature: await f.sign(changed),
      operatorApproval: approveRequest(
        "operator",
        changed,
        f.operator.privateKey,
      ),
    };
  await assert.rejects(reviewer.approve(replay, digest(changed)), /UNIQUE/);
  vault.lock();
  password.fill(0);
  db.close();
  f.store.close();
});
test("interrupted independent signer claim is not cleared or signed again", async () => {
  const f = fixture(),
    r = await f.request();
  f.refunds.approve(r.id, approveRequest("operator", r, f.operator.privateKey));
  const secret = f.signer.privateKey.export({ format: "der", type: "pkcs8" }),
    password = randomBytes(32),
    vault = new ApprovalVault("signer");
  await vault.unlock(
    await encrypt(secret, password, "signer-approval"),
    password,
    true,
  );
  secret.fill(0);
  const db = new DatabaseSync(":memory:"),
    e: IndependentEvidence = {
      ...r,
      tip: 100,
      scanned: 100,
      observedAt: 1000,
      minimumConfirmations: 11,
      execution: "never-constructed",
      orderState: "recovery",
    };
  const reviewer = new IndependentRefundReviewer(
    db,
    f.operator.publicKey,
    vault,
    {
      async read() {
        return e;
      },
      validateShieldedDestination: decoder.validate,
    },
    () => 1000,
  );
  db.prepare(
    "INSERT INTO signer_refund_journal VALUES(?,?,?,'REVIEW_APPROVING',NULL,?)",
  ).run(r.id, r.orderId, digest(r), 1000);
  await assert.rejects(
    reviewer.approve(f.refunds.exportUnsigned(r.id), digest(r)),
    /interrupted_signer/,
  );
  vault.lock();
  password.fill(0);
  db.close();
  f.store.close();
});
test("keystore randomizes salt and nonce and rejects password, ciphertext, purpose and KDF tampering", async () => {
  const secret = randomBytes(32),
    password = randomBytes(32),
    a = await encrypt(secret, password, "isolated-wallet-test"),
    b = await encrypt(secret, password, "isolated-wallet-test");
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.nonce, b.nonce);
  const restored = await decrypt(a, password, "isolated-wallet-test");
  assert.deepEqual(restored, secret);
  restored.fill(0);
  await assert.rejects(
    decrypt(a, randomBytes(32), "isolated-wallet-test"),
    /unlock_failed/,
  );
  for (const altered of [
    { ...a, tag: "0".repeat(32) },
    { ...a, ciphertext: "0".repeat(a.ciphertext.length) },
    { ...a, N: 2147483648 },
    { ...a, purpose: "operator-approval" },
  ])
    await assert.rejects(
      decrypt(altered, password, "isolated-wallet-test"),
      /unlock_failed/,
    );
  secret.fill(0);
  password.fill(0);
});
test("unauthorized unlock, explicit lock, expiry and lock-during-KDF all fail closed", async () => {
  const k = key(),
    secret = k.privateKey.export({ format: "der", type: "pkcs8" }),
    password = randomBytes(32),
    e = await encrypt(secret, password, "operator-approval");
  secret.fill(0);
  let now = 1000;
  const v = new ApprovalVault("operator", () => now);
  await assert.rejects(v.unlock(e, password, false), /consent/);
  await v.unlock(e, password, true, 100);
  assert(v.unlocked);
  now = 1100;
  assert.throws(() => v.withKey(createPublicKey), /locked/);
  const pending = v.unlock(e, password, true);
  v.lock();
  await assert.rejects(pending, /cancelled/);
  assert.equal(v.unlocked, false);
  password.fill(0);
});
test("encrypted-copy staging is reversible and interruption never overwrites credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zecone-migration-fixture-")),
    src = join(dir, "isolated-fixture-key"),
    dest = join(dir, "fixture-vault.json"),
    secret = randomBytes(32),
    password = randomBytes(32);
  writeFileSync(src, secret, { flag: "wx" });
  await assert.rejects(
    stageEncryptedCopy(src, dest, password, "isolated-wallet-test", false),
    /explicit/,
  );
  const result = await stageEncryptedCopy(
    src,
    dest,
    password,
    "isolated-wallet-test",
    true,
  );
  assert.equal(result.activated, false);
  assert.deepEqual(readFileSync(src), secret);
  const saved = readFileSync(dest);
  await assert.rejects(
    stageEncryptedCopy(src, dest, password, "isolated-wallet-test", true),
    /EEXIST/,
  );
  assert.deepEqual(readFileSync(dest), saved);
  assert.deepEqual(readFileSync(src), secret);
  password.fill(0);
  secret.fill(0);
});
const prices = (asset: "ZEC" | "ETH", usd: string): Price[] =>
  ["coinbase", "kraken"].map((source) => ({
    source,
    asset,
    usdE8: decimalUsd(usd),
    sourceAt: 1000,
    receivedAt: 1000,
  }));
test("price consensus rejects staleness, future timestamps, disagreement and duplicate sources", () => {
  const p = prices("ZEC", "40");
  assert.equal(consensus("ZEC", p, 1000).usdE8, "4000000000");
  assert.throws(() => consensus("ZEC", p, 1121), /stale/);
  assert.throws(
    () => consensus("ZEC", [p[0]!, { ...p[1]!, sourceAt: 1006 }], 1000),
    /stale/,
  );
  assert.throws(
    () =>
      consensus("ZEC", [p[0]!, { ...p[1]!, usdE8: decimalUsd("50") }], 1000),
    /disagreement/,
  );
  assert.throws(() => consensus("ZEC", [p[0]!, p[0]!], 1000), /independent/);
  for (const n of ["NaN", "1e9", "-1", "0", "9999999999"])
    assert.throws(() => decimalUsd(n));
});
test("feed failure does not downgrade a configured quorum or silently return a fixed rate", async () => {
  await assert.rejects(
    reference(
      "ZEC",
      [
        {
          id: "coinbase",
          async fetch() {
            return prices("ZEC", "40")[0]!;
          },
        },
        {
          id: "kraken",
          async fetch() {
            throw Error("fixture outage");
          },
        },
      ],
      () => 1000,
    ),
    /outage/,
  );
});
test("quote binds fees and expiry; movement rejects before approval but never reprices a paid commitment", () => {
  const zec = consensus("ZEC", prices("ZEC", "40"), 1000),
    eth = consensus("ETH", prices("ETH", "2000"), 1000),
    q = quoteReference(
      "100000000000000",
      "10000000000000",
      100,
      zec,
      eth,
      1000,
      2000,
    );
  assert.equal(q.providerFeeWei, "1000000000000");
  assert(q.referenceOnly);
  assert.throws(
    () => checkQuote(q, q.digest, 1060, zec, eth, false),
    /expired/,
  );
  const moved = consensus("ZEC", prices("ZEC", "50"), 1000);
  assert.throws(
    () => checkQuote(q, q.digest, 1000, moved, eth, false),
    /moved/,
  );
  checkQuote(q, q.digest, 1100, moved, eth, true);
  assert.throws(
    () =>
      checkQuote(
        { ...q, referenceZatoshis: "1" },
        q.digest,
        1000,
        zec,
        eth,
        true,
      ),
    /modified/,
  );
  assert.throws(() => checkQuote(q, q.digest, 2000, zec, eth, true), /expired/);
});
test("OpenSea handoff accepts only explicit official Ethereum item paths and stays non-executable", () => {
  const account = privateKeyToAccount(generatePrivateKey()).address,
    url = `https://opensea.io/item/ethereum/${account}/1`,
    p = listingHandoff(url);
  assert.equal(p.executable, false);
  assert.equal(p.paymentAddress, null);
  for (const u of [
    url.replace("opensea.io", "opensea.io.evil.example"),
    url + "?redirect=evil",
    url + "#approve",
    url.replace("https:", "http:"),
    url.replace("opensea.io", "user@opensea.io"),
    url.replace("/1", "/%31"),
    url.replace("ethereum", "base"),
    url.replace("/item/", "/item/../item/"),
    `https://opensea.io\\@evil.example/item/ethereum/${account}/1`,
  ])
    assert.throws(() => listingHandoff(u));
});
test("native address decoder validates real checksum without a seed, DB or network", async () => {
  const d = new NativeDestinationDecoder();
  await d.validate(destination);
  await assert.rejects(d.validate("utest1notavalidchecksum"));
  await assert.rejects(d.validate("0x" + "1".repeat(40)));
});
