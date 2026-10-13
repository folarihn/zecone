// Real native crypto with SYNTHETIC notes/anchors and isolated generated keys.
// No network payment, real chain inclusion, broadcasts, or legacy wallet access.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, mkdirSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  encrypt,
  ApprovalVault,
  writeVerifiedKeystore,
} from "../services/signer/keystore.ts";
import {
  IndependentRefundReviewer,
  type IndependentEvidence,
} from "../services/signer/refund-review.ts";
import {
  IsolatedNativeRefundSigner,
  IsolatedSpendVault,
  type NativePolicy,
} from "../services/signer/native-refund.ts";
import { NativeDestinationDecoder } from "../services/settlement/native-address.ts";
import {
  approveRequest,
  digest,
  userMessage,
  type RefundRequest,
} from "../services/settlement/protocol.ts";
import {
  PortableRefundSession,
  exportPortableRequest,
  parsePortableRequest,
} from "../services/signer/portable-refund.ts";

async function setup() {
  const parent = resolve(".state/native-refund-tests");
  mkdirSync(parent, { recursive: true });
  const dir = join(parent, randomUUID());
  execFileSync(
    resolve(
      `target/debug/zecone-refund-signer${process.platform === "win32" ? ".exe" : ""}`,
    ),
    ["create-synthetic-fixture", dir],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const policy = JSON.parse(
    readFileSync(join(dir, "policy.json"), "utf8"),
  ) as NativePolicy;
  const pczt = readFileSync(join(dir, "unsigned.pczt")),
    password = randomBytes(32),
    keyPath = join(dir, "isolated-key.bin"),
    key = readFileSync(keyPath);
  try {
    await writeVerifiedKeystore(
      join(dir, "isolated-keystore.json"),
      key,
      password,
      "isolated-wallet-test",
    );
  } finally {
    key.fill(0);
  }
  // Only this newly generated test credential is removed after verified encryption.
  unlinkSync(keyPath);
  const spendVault = new IsolatedSpendVault();
  await spendVault.unlock(
    JSON.parse(readFileSync(join(dir, "isolated-keystore.json"), "utf8")),
    password,
    true,
  );
  password.fill(0);
  const user = privateKeyToAccount(generatePrivateKey()),
    operator = generateKeyPairSync("ed25519"),
    signer = generateKeyPairSync("ed25519"),
    now = Math.floor(Date.now() / 1000);
  const request: RefundRequest = {
    version: 1,
    domain: "zecone-testnet-refund-v1",
    network: "zcash-testnet",
    id: randomUUID(),
    orderId: policy.orderId,
    intentDigest: digest({ synthetic: "independent-order" }),
    paymentDigest: digest({ synthetic: "independent-receipts" }),
    recipient: user.address,
    destination: policy.destination,
    eligibleZatoshis: policy.eligibleZatoshis,
    refundZatoshis: policy.refundZatoshis,
    feeCeilingZatoshis: policy.feeCeilingZatoshis,
    created: now,
    expires: now + 300,
  };
  const bundle = {
    request,
    userSignature: await user.signMessage({ message: userMessage(request) }),
    operatorApproval: approveRequest("operator", request, operator.privateKey),
  };
  const evidence: IndependentEvidence = {
    network: "zcash-testnet",
    orderId: request.orderId,
    intentDigest: request.intentDigest,
    paymentDigest: request.paymentDigest,
    recipient: user.address,
    destination: request.destination,
    eligibleZatoshis: request.eligibleZatoshis,
    tip: policy.tip,
    scanned: policy.tip,
    observedAt: policy.observedAt,
    minimumConfirmations: 10,
    execution: "never-constructed",
    orderState: "recovery",
  };
  const vault = new ApprovalVault("signer"),
    approvalPassword = randomBytes(32),
    approvalKey = signer.privateKey.export({ format: "der", type: "pkcs8" });
  const envelope = await encrypt(
    approvalKey,
    approvalPassword,
    "signer-approval",
  );
  approvalKey.fill(0);
  await vault.unlock(envelope, approvalPassword, true);
  approvalPassword.fill(0);
  const reader = {
    async read() {
      return evidence;
    },
    async validateShieldedDestination(address: string) {
      await new NativeDestinationDecoder().validate(address);
    },
    async readNative() {
      return {
        fullViewingKey: policy.fullViewingKey,
        anchor: policy.anchor,
        tip: policy.tip,
        observedAt: policy.observedAt,
        inputs: policy.inputs,
      };
    },
  };
  const db = new DatabaseSync(join(dir, "signer.sqlite")),
    reviewer = new IndependentRefundReviewer(
      db,
      operator.publicKey,
      vault,
      reader,
    );
  const native = new IsolatedNativeRefundSigner(
    reviewer,
    reader,
    signer.publicKey,
    spendVault,
  );
  const approval = await reviewer.approve(bundle, digest(request));
  return {
    db,
    native,
    pczt,
    bundle,
    approval,
    reader,
    spendVault,
    vault,
    signer,
    operator,
    dir,
    async close() {
      spendVault.lock();
      vault.lock();
      db.close();
    },
  };
}

test(
  "portable exchange requires exact manual review and returns only persisted signed transaction data",
  { timeout: 240000 },
  async () => {
    const f = await setup();
    try {
      const session = new PortableRefundSession(f.native),
        bytes = exportPortableRequest(f.bundle, f.pczt);
      assert.throws(
        () =>
          parsePortableRequest(
            Buffer.from(
              JSON.stringify({
                ...JSON.parse(bytes.toString()),
                evidence: { backend: "must-not-be-trusted" },
              }),
            ),
          ),
        /invalid_portable/,
      );
      const review = await session.review(bytes);
      await assert.rejects(
        session.signAndExport(bytes, "wrong"),
        /manual_portable_review/,
      );
      const result = await session.signAndExport(bytes, review.approvalDigest);
      assert.equal(result.liveEnabled, false);
      assert.equal(result.simulatedIsolation, true);
      assert.ok(result.rawTransactionHex.length > 1000);
      assert.deepEqual(
        Object.keys(result).sort(),
        [
          "version",
          "network",
          "simulatedIsolation",
          "refundId",
          "requestDigest",
          "rawTransactionHex",
          "txid",
          "liveEnabled",
        ].sort(),
      );
      const reopened = new PortableRefundSession(f.native);
      assert.deepEqual(reopened.recover(f.bundle.request.id), result);
      assert.deepEqual(
        await reopened.signAndExport(bytes, review.approvalDigest),
        result,
      );
      // Metadata/report includes no synthetic txid or private native evidence.
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        "docs/phase5-evidence/completion-portable-roundtrip.json",
        JSON.stringify(
          {
            at: new Date().toISOString(),
            syntheticNotes: true,
            simulatedIsolation: true,
            separateDeviceValidated: false,
            nativeProofExtracted: true,
            exactReplay: true,
            rawTransactionBytes: result.rawTransactionHex.length / 2,
            liveRefundEnabled: false,
            broadcast: false,
          },
          null,
          2,
        ),
      );
    } finally {
      await f.close();
    }
  },
);

test("portable interrupted finalization and live evidence cannot initiate signing",async()=>{
  const f=await setup();try{
    const session=new PortableRefundSession(f.native),bytes=exportPortableRequest(f.bundle,f.pczt),r=await session.review(bytes);
    f.db.prepare("INSERT INTO portable_refund_finalization VALUES(?,?,'FINALIZING',NULL,NULL)").run(f.bundle.request.id,r.approvalDigest);
    await assert.rejects(session.signAndExport(bytes,r.approvalDigest),/finalization_uncertain/);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM native_refund_journal").get()?.n,0);
    Object.assign(f.reader,{liveChain:true});await assert.rejects(session.signAndExport(bytes,r.approvalDigest),/separate_device/);
  }finally{await f.close();}
});

test("independent approval integrates with native verification/signing and exact replay recovery", async () => {
  const f = await setup();
  try {
    const { review } = await f.native.review(f.bundle, f.pczt);
    assert.equal(review.feeZatoshis, "10000");
    assert.equal(review.changeZatoshis, "90000");
    await assert.rejects(
      f.native.sign(f.bundle, f.pczt, f.approval, "wrong-review"),
      /explicit_native_review/,
    );
    const signed = await f.native.sign(
      f.bundle,
      f.pczt,
      f.approval,
      review.reviewDigest,
    );
    assert.notDeepEqual(signed.signedPczt, f.pczt);
    assert.equal(signed.liveEnabled, false);
    assert.equal(signed.broadcast, false);
    f.spendVault.lock();
    f.vault.lock();
    const replay = await f.native.sign(
      f.bundle,
      f.pczt,
      f.approval,
      review.reviewDigest,
    );
    assert.deepEqual(replay.signedPczt, signed.signedPczt);
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) n FROM native_refund_events WHERE event='native_signing_claimed'",
        )
        .get()!.n,
      1,
    );
    const reopened = new DatabaseSync(join(f.dir, "signer.sqlite"));
    const reviewer = new IndependentRefundReviewer(
      reopened,
      f.operator.publicKey,
      f.vault,
      f.reader,
    );
    const restored = new IsolatedNativeRefundSigner(
      reviewer,
      f.reader,
      f.signer.publicKey,
      f.spendVault,
    );
    assert.deepEqual(
      restored.recover(f.bundle.request.id).signedPczt,
      signed.signedPczt,
    );
    reopened.close();
    assert.throws(() => f.native.broadcast(), /live_refunds_disabled/);
  } finally {
    await f.close();
  }
});

test("native signer rejects locked keys and an interrupted durable signing claim", async () => {
  const f = await setup();
  try {
    const { review } = await f.native.review(f.bundle, f.pczt);
    f.spendVault.lock();
    await assert.rejects(
      f.native.sign(f.bundle, f.pczt, f.approval, review.reviewDigest),
      /vault_locked/,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM native_refund_journal").get()!.n,
      0,
    );
    f.db
      .prepare(
        "INSERT INTO native_refund_journal VALUES(?,?,?,'SIGNING',NULL,NULL,NULL)",
      )
      .run(f.bundle.request.id, f.bundle.request.orderId, review.reviewDigest);
    await assert.rejects(
      f.native.sign(f.bundle, f.pczt, f.approval, review.reviewDigest),
      /outcome_uncertain/,
    );
    assert.throws(
      () => f.native.recover(f.bundle.request.id),
      /outcome_uncertain/,
    );
  } finally {
    await f.close();
  }
});

test("native signing still requires independent authorization and input evidence", async () => {
  const f = await setup();
  try {
    const { review } = await f.native.review(f.bundle, f.pczt);
    await assert.rejects(
      f.native.sign(
        f.bundle,
        f.pczt,
        { ...f.approval, signature: "00".repeat(64) },
        review.reviewDigest,
      ),
      /signer_authorization/,
    );
    const altered = {
      ...f.bundle,
      request: { ...f.bundle.request, refundZatoshis: "899999" },
    };
    await assert.rejects(f.native.review(altered, f.pczt));
    f.reader.readNative = async () => ({
      fullViewingKey: "00".repeat(96),
      anchor: "00".repeat(32),
      tip: 4500000,
      observedAt: Math.floor(Date.now() / 1000),
      inputs: [],
    });
    await assert.rejects(
      f.native.review(f.bundle, f.pczt),
      /native_refund_signer_rejected/,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM native_refund_journal").get()!.n,
      0,
    );
  } finally {
    await f.close();
  }
});

test("failure after real native signing before journal persistence never permits replacement", async () => {
  const f = await setup();
  try {
    const { review } = await f.native.review(f.bundle, f.pczt);
    f.db.exec(
      "CREATE TRIGGER synthetic_crash BEFORE UPDATE ON native_refund_journal WHEN NEW.state='SIGNED' BEGIN SELECT RAISE(ABORT,'synthetic_crash_after_native_sign'); END;",
    );
    await assert.rejects(
      f.native.sign(f.bundle, f.pczt, f.approval, review.reviewDigest),
      /synthetic_crash_after_native_sign/,
    );
    f.db.exec("DROP TRIGGER synthetic_crash");
    await assert.rejects(
      f.native.sign(f.bundle, f.pczt, f.approval, review.reviewDigest),
      /outcome_uncertain/,
    );
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) n FROM native_refund_journal WHERE state='SIGNING' AND pczt IS NULL",
        )
        .get()!.n,
      1,
    );
  } finally {
    await f.close();
  }
});

test("native input claims prohibit sharing a note across distinct refund requests", async () => {
  const f = await setup();
  try {
    const { policy, review } = await f.native.review(f.bundle, f.pczt);
    f.db
      .prepare("INSERT INTO native_refund_input_claims VALUES(?,?)")
      .run(policy.inputs[0].nullifier, "another-synthetic-refund");
    await assert.rejects(
      f.native.sign(f.bundle, f.pczt, f.approval, review.reviewDigest),
      /UNIQUE constraint/,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM native_refund_journal").get()!.n,
      0,
    );
  } finally {
    await f.close();
  }
});

test("concurrent native signing requests persist only one signing attempt", async () => {
  const f = await setup();
  try {
    const { review } = await f.native.review(f.bundle, f.pczt);
    const results = await Promise.allSettled([
      f.native.sign(f.bundle, f.pczt, f.approval, review.reviewDigest),
      f.native.sign(f.bundle, f.pczt, f.approval, review.reviewDigest),
    ]);
    assert.ok(results.some((r) => r.status === "fulfilled"));
    for (const r of results)
      if (r.status === "rejected")
        assert.match(r.reason.message, /outcome_uncertain/);
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) n FROM native_refund_events WHERE event='native_signing_claimed'",
        )
        .get()!.n,
      1,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM native_refund_input_claims").get()!
        .n,
      1,
    );
  } finally {
    await f.close();
  }
});
