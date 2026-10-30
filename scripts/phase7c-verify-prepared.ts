// Read-only verification of actual prepared state; no runtime, keys, approvals or network sends.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { json } from "../services/solana/network.ts";
const profile = JSON.parse(readFileSync(".state/phase7c/profile.json", "utf8"));
const root = join(".state/phase7c", profile.id);
const db = new DatabaseSync(join(root, "settlement.sqlite"), {
  readOnly: true,
});
try {
  const orders = db.prepare("SELECT * FROM orders").all();
  assert.equal(orders.length, 1);
  const order = orders[0],
    id = String(order.id),
    intent = JSON.parse(String(order.intent));
  const row = db
    .prepare("SELECT * FROM solana_settlement WHERE order_id=?")
    .get(id)!;
  const grant = db
    .prepare(
      "SELECT * FROM solana_paid_preparation_recoveries WHERE order_id=?",
    )
    .get(id)!;
  const bound = JSON.parse(String(grant.binding)),
    prepared = JSON.parse(String(row.prepared));
  const now = Math.floor(Date.now() / 1000);
  assert.equal(grant.scope, "PREPARATION_ONLY");
  assert.ok(Number(grant.prepare_until) > now);
  assert.equal(row.state, "AWAITING_SOLANA_AUTHORIZATION");
  assert.equal(row.claimed, 0);
  assert.equal(row.signature, null);
  assert.equal(row.wire, null);
  assert.equal(row.receipt, null);
  assert.equal(order.state, "recovery");
  assert.deepEqual(intent, bound.originalIntent);
  assert.deepEqual(prepared.swap, intent.swap);
  assert.equal(
    prepared.digest,
    createHash("sha256").update(prepared.wire).digest("hex"),
  );
  assert.equal(prepared.simulation.err, null);
  assert.ok(prepared.quotedAt >= Number(grant.authorized_at));
  assert.ok(prepared.quoteExpiresAt > now && prepared.approvalExpiresAt > now);
  assert.ok(BigInt(prepared.quotedOutput) >= BigInt(intent.swap.minimumOut));
  const payments = db
    .prepare(
      "SELECT key,zatoshis,height,block_hash FROM payments WHERE order_id=? AND active=1 AND confirmed=1 ORDER BY key",
    )
    .all(id);
  assert.equal(json(payments), json(bound.originalPayment));
  const claims = db
    .prepare(
      "SELECT COUNT(*) AS n FROM audit WHERE order_id=? AND event IN ('solana_signing_claimed','solana_broadcast_claimed','solana_submission_uncertain')",
    )
    .get(id)!;
  assert.equal(claims.n, 0);
  const approvals = db
    .prepare(
      "SELECT COUNT(*) AS n FROM solana_paid_recovery_exact_approvals WHERE order_id=?",
    )
    .get(id)!;
  assert.equal(approvals.n, 0);
  const archives = db
    .prepare(
      "SELECT COUNT(*) AS n FROM solana_unsigned_review_archive WHERE order_id=?",
    )
    .get(id)!;
  assert.ok(Number(archives.n) >= 1);
  const report = {
    at: new Date().toISOString(),
    originalOrderRetained: true,
    originalDeadlinePreserved: true,
    originalPaymentRetained: true,
    originalRecipientAndLimitsUnchanged: true,
    scope: "PREPARATION_ONLY",
    expiredReviewsRetained: Number(archives.n),
    signingClaims: 0,
    signedTransactions: 0,
    separateExecutionApprovals: 0,
    simulationSucceeded: true,
    currentQuotedOutput: prepared.quotedOutput,
    minimumOut: intent.swap.minimumOut,
    estimatedFee: prepared.fee,
    liveRefundsEnabled: false,
    phase7cComplete: false,
  };
  writeFileSync(
    "docs/phase7c-evidence/authorized-preparation.json",
    json(report),
  );
  writeFileSync(
    join(root, `prepared-verification-${Date.now()}.private.json`),
    json({
      ...report,
      orderId: id,
      attemptId: grant.attempt_id,
      recipient: intent.recipient,
      digest: prepared.digest,
      quoteExpiresAt: prepared.quoteExpiresAt,
      approvalExpiresAt: prepared.approvalExpiresAt,
      lifetime: prepared.lifetime,
    }),
    { mode: 0o600, flag: "wx" },
  );
  console.log(json(report));
} finally {
  db.close();
}
