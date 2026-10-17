// Operator-only recovery. A preparation grant never authorizes signing;
// execution requires a second, separately supplied exact human approval.
import { digest } from "./transactions.ts";
import { json, SolanaError } from "./network.ts";
import type { SolanaSettlement } from "./settlement.ts";
import type { WatchSnapshot } from "../signer/watch-evidence.ts";
import { inspectSwap } from "./cpmm.ts";
import { blockhash } from "@solana/kit";
import { assertReviewCurrent } from "./swap-approval.ts";

export function recoverySchema(service: SolanaSettlement) {
  service.store.db.exec(
    "CREATE TABLE IF NOT EXISTS solana_paid_preparation_recoveries(order_id TEXT PRIMARY KEY REFERENCES orders(id),attempt_id TEXT NOT NULL UNIQUE,binding TEXT NOT NULL,binding_digest TEXT NOT NULL,authorized_at INTEGER NOT NULL,prepare_until INTEGER NOT NULL,scope TEXT NOT NULL,authorization TEXT NOT NULL)",
  );
  service.store.db.exec(
    "CREATE TABLE IF NOT EXISTS solana_paid_recovery_exact_approvals(order_id TEXT NOT NULL REFERENCES orders(id),attempt_id TEXT NOT NULL,digest TEXT NOT NULL,approved_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL,PRIMARY KEY(order_id,attempt_id,digest))",
  );
}
export function recoveryRecord(service: SolanaSettlement, id: string) {
  return service.store.db
    .prepare(
      "SELECT * FROM solana_paid_preparation_recoveries WHERE order_id=?",
    )
    .get(id);
}
function binding(service: SolanaSettlement, id: string, validatingDigest = "") {
  const o = service.store.get(id),
    row = service.row(id),
    i = service.intent(id);
  if (
    !o ||
    !i.swap ||
    i.action !== "SOLANA_DEVNET_SPL_SWAP" ||
    i.expiry > service.now() ||
    !["recovery", "expired"].includes(o.state)
  )
    throw new SolanaError("EXPIRED_PAID_SWAP_REQUIRED");
  if (
    row.claimed ||
    row.signature ||
    row.wire ||
    row.receipt ||
    o.raw ||
    o.tx_hash ||
    o.observed_at > service.now() + 5 ||
    service.now() - o.observed_at > 120
  )
    throw new SolanaError("RECOVERY_SIGNED_OR_STALE_VETO");
  const totals = service.store.totals(id);
  if (
    totals.confirmed !== BigInt(i.zatoshis) ||
    totals.received !== BigInt(i.zatoshis)
  )
    throw new SolanaError("EXACT_VERIFIED_PAYMENT_REQUIRED");
  const payments = service.store.db
    .prepare(
      "SELECT key,zatoshis,height,block_hash FROM payments WHERE order_id=? AND active=1 AND confirmed=1 ORDER BY key",
    )
    .all(id);
  if (payments.length !== 1)
    throw new SolanaError("SINGLE_ORIGINAL_PAYMENT_REQUIRED");
  const proof = payments.map((p) => {
    const [txid, pool, index] = String(p.key).split(":");
    return {
      txid,
      pool: Number(pool),
      index: Number(index),
      zatoshis: p.zatoshis,
      height: p.height,
      blockHash: p.block_hash,
    };
  });
  const originalAuthorization = service.store.db
    .prepare(
      "SELECT payment_digest FROM solana_authorizations WHERE order_id=?",
    )
    .get(id);
  if (
    !originalAuthorization ||
    originalAuthorization.payment_digest !== digest(json(proof))
  )
    throw new SolanaError("ORIGINAL_PAYMENT_AUTHORIZATION_MISMATCH");
  const reasons = service.store.db
    .prepare("SELECT reason FROM recoveries WHERE order_id=?")
    .all(id);
  if (!reasons.length || reasons.some((r) => r.reason !== "expired_payment"))
    throw new SolanaError("UNRELATED_RECOVERY_VETO");
  for (const table of [
    "execution_construction_claims",
    "settlement_execution_veto",
    "settlement_refunds",
    "signer_refund_journal",
    "native_refund_journal",
    "simulated_refund_delivery",
  ]) {
    if (
      service.store.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table) &&
      service.store.db
        .prepare(`SELECT 1 FROM ${table} WHERE order_id=?`)
        .get(id)
    )
      throw new SolanaError("REFUND_OR_SETTLEMENT_CLAIM_VETO");
  }
  if (
    service.store.db
      .prepare(
        "SELECT 1 FROM audit WHERE order_id=? AND (event IN ('solana_signing_claimed','solana_broadcast_claimed','solana_submission_uncertain') OR event LIKE '%->settled')",
      )
      .get(id) ||
    service.store.db
      .prepare(
        "SELECT 1 FROM solana_exact_approvals WHERE order_id=? AND (state='CONSUMED' OR (state='VALIDATING' AND digest!=?))",
      )
      .get(id, validatingDigest)
  )
    throw new SolanaError("PRIOR_EXECUTION_VETO");
  return json({
    orderId: id,
    originalIntent: JSON.parse(o.intent),
    originalPayment: payments,
    originalPaymentAuthorization: originalAuthorization.payment_digest,
  });
}
export function assertPreparationRecovery(
  service: SolanaSettlement,
  id: string,
  validatingDigest = "",
) {
  const grant = recoveryRecord(service, id);
  if (
    !grant ||
    grant.scope !== "PREPARATION_ONLY" ||
    Number(grant.prepare_until) <= service.now() ||
    [
      "RECOVERY_REQUIRED",
      "COMPLETED",
      "SIGNING",
      "EXECUTING",
      "SUBMISSION_UNCERTAIN",
    ].includes(service.row(id).state) ||
    (service.row(id).state === "VALIDATING" && !validatingDigest)
  )
    throw new SolanaError("PAID_PREPARATION_NOT_AUTHORIZED");
  const current = binding(service, id, validatingDigest);
  if (grant.binding !== current || grant.binding_digest !== digest(current))
    throw new SolanaError("RECOVERY_BINDING_CHANGED");
  return grant;
}

// This SECOND authorization is never created by recovery registration/preparation.
// Only the operator's later exact-approval command/TTY confirmation may call it.
export async function authorizeExactRecoveredTransaction(
  service: SolanaSettlement,
  id: string,
  exactDigest: string,
  explicitlyApproved: boolean,
) {
  if (!explicitlyApproved)
    throw new SolanaError("SEPARATE_EXACT_RECOVERY_APPROVAL_REQUIRED");
  const grant = assertPreparationRecovery(service, id),
    raw = service.row(id).prepared;
  if (!raw || JSON.parse(raw).digest !== exactDigest)
    throw new SolanaError("EXACT_APPROVAL_REQUIRED");
  const p = JSON.parse(raw);
  assertReviewCurrent(p, service.now());
  if (!(await service.network.valid(blockhash(p.lifetime.blockhash))))
    throw new SolanaError("BLOCKHASH_EXPIRED");
  service.store.atomic(() => {
    assertPreparationRecovery(service, id);
    assertReviewCurrent(p, service.now());
    if (service.row(id).prepared !== raw)
      throw new SolanaError("EXACT_APPROVAL_RACE_VETO");
    const previous = service.store.db
      .prepare(
        "SELECT * FROM solana_paid_recovery_exact_approvals WHERE order_id=? AND attempt_id=? AND digest=?",
      )
      .get(id, String(grant.attempt_id), exactDigest);
    if (previous) {
      if (
        previous.state !== "EXACT_TRANSACTION_ONLY" ||
        Number(previous.expires_at) <= service.now()
      )
        throw new SolanaError("EXACT_APPROVAL_ALREADY_CONSUMED_OR_EXPIRED");
      return; // No expiry extension or mutation of an old authorization.
    }
    service.store.db
      .prepare(
        "INSERT INTO solana_paid_recovery_exact_approvals VALUES(?,?,?,?,?,?)",
      )
      .run(
        id,
        String(grant.attempt_id),
        exactDigest,
        service.now(),
        Math.min(
          Number(grant.prepare_until),
          p.approvalExpiresAt ?? p.expiresAt,
        ),
        "EXACT_TRANSACTION_ONLY",
      );
    service.store.event(
      id,
      "separate_recovered_transaction_approval",
      { attemptId: grant.attempt_id, digest: exactDigest },
      service.now(),
    );
  });
}
export function assertExactRecoveryExecution(
  service: SolanaSettlement,
  id: string,
) {
  const raw = service.row(id).prepared;
  if (!raw) throw new SolanaError("SEPARATE_EXACT_RECOVERY_APPROVAL_REQUIRED");
  const p = JSON.parse(raw),
    grant = assertPreparationRecovery(service, id, p.digest);
  const exact = service.store.db
    .prepare(
      "SELECT * FROM solana_paid_recovery_exact_approvals WHERE order_id=? AND attempt_id=? AND digest=?",
    )
    .get(id, String(grant.attempt_id), p.digest);
  if (
    !exact ||
    exact.state !== "EXACT_TRANSACTION_ONLY" ||
    Number(exact.expires_at) <= service.now()
  )
    throw new SolanaError("SEPARATE_EXACT_RECOVERY_APPROVAL_REQUIRED");
  assertReviewCurrent(p, service.now());
}
export function consumeExactRecoveryApproval(
  service: SolanaSettlement,
  id: string,
  digest: string,
) {
  const grant = recoveryRecord(service, id);
  if (
    grant &&
    service.store.db
      .prepare(
        "UPDATE solana_paid_recovery_exact_approvals SET state='CONSUMED' WHERE order_id=? AND attempt_id=? AND digest=? AND state='EXACT_TRANSACTION_ONLY'",
      )
      .run(id, String(grant.attempt_id), digest).changes !== 1
  )
    throw new SolanaError("EXACT_RECOVERY_APPROVAL_CONSUMPTION_VETO");
}
export async function authorizePaidPreparation(
  service: SolanaSettlement,
  id: string,
  attemptId: string,
  explicitlyAuthorized: boolean,
  snapshot: WatchSnapshot,
) {
  if (
    !explicitlyAuthorized ||
    !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(attemptId)
  )
    throw new SolanaError("EXPLICIT_SCOPED_RECOVERY_REQUIRED");
  service.authorize(id, snapshot); // Includes native owned-note verification and a complete fresh scan.
  const before = service.row(id);
  const existing = recoveryRecord(service, id);
  if (existing) {
    if (existing.attempt_id !== attemptId)
      throw new SolanaError("EXISTING_RECOVERY_ATTEMPT_VETO");
    assertPreparationRecovery(service, id);
    return existing; // Idempotent: never extend an existing grant.
  }
  if (before.state !== "RECOVERY_REQUIRED")
    throw new SolanaError("ORIGINAL_RECOVERY_STATE_REQUIRED");
  const original = binding(service, id);
  if (!before.prepared)
    throw new SolanaError("ORIGINAL_UNSIGNED_REVIEW_REQUIRED");
  await inspectSwap(service.intent(id), JSON.parse(before.prepared));
  if (!service.network.recoveryAbsence)
    throw new SolanaError("INDEPENDENT_RECONCILIATION_REQUIRED");
  await service.network.recoveryAbsence(
    service.intent(id),
    service.store.get(id)!.created,
  );
  return service.store.atomic(() => {
    if (
      binding(service, id) !== original ||
      service.row(id).state !== "RECOVERY_REQUIRED"
    )
      throw new SolanaError("RECOVERY_REGISTRATION_RACE_VETO");
    const now = service.now(),
      until = now + 7200;
    service.store.db
      .prepare(
        "INSERT INTO solana_paid_preparation_recoveries VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        attemptId,
        original,
        digest(original),
        now,
        until,
        "PREPARATION_ONLY",
        "Human user: ZecOne Phase 7C Authorized Order Recovery; existing order only; no signing, broadcast, payment, recipient/economic changes or refund",
      );
    if (
      service.store.db
        .prepare(
          "UPDATE solana_settlement SET state='AWAITING_SOLANA_AUTHORIZATION' WHERE order_id=? AND state='RECOVERY_REQUIRED' AND claimed=0 AND signature IS NULL AND wire IS NULL",
        )
        .run(id).changes !== 1
    )
      throw new SolanaError("RECOVERY_REGISTRATION_RACE_VETO");
    service.store.event(
      id,
      "paid_order_preparation_authorized",
      {
        attemptId,
        bindingDigest: digest(original),
        prepareUntil: until,
        scope: "PREPARATION_ONLY",
        originalDeadlinePreserved: true,
      },
      now,
    );
    return recoveryRecord(service, id)!;
  });
}
