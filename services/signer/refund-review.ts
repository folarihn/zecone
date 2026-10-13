import { DatabaseSync } from "node:sqlite";
import type { KeyObject } from "node:crypto";
import type { Hex } from "viem";
import {
  amount,
  approveRequest,
  canonical,
  digest,
  validateRequest,
  verifyApproval,
  verifyUser,
  type RefundRequest,
  type Approval,
} from "../settlement/protocol.ts";
import { ApprovalVault } from "./keystore.ts";

export type IndependentEvidence = {
  network: "zcash-testnet";
  orderId: string;
  intentDigest: string;
  paymentDigest: string;
  recipient: string;
  destination: string;
  eligibleZatoshis: string;
  tip: number;
  scanned: number;
  observedAt: number;
  minimumConfirmations: number;
  execution: "never-constructed";
  orderState: "recovery" | "expired" | "failed";
};
export interface IndependentReader {
  // Implemented by signer-owned chain/wallet evidence, NEVER by bundle fields.
  read(orderId: string): Promise<IndependentEvidence>;
  validateShieldedDestination(destination: string): Promise<void>;
}
export type UnsignedRefundBundle = {
  request: RefundRequest;
  userSignature: Hex;
  operatorApproval: Approval;
};
/** Review authorization only. This cannot sign a Zcash transaction or broadcast. */
export class IndependentRefundReviewer {
  constructor(
    readonly db: DatabaseSync,
    readonly operatorKey: KeyObject,
    readonly vault: ApprovalVault,
    readonly reader: IndependentReader,
    readonly clock = () => Math.floor(Date.now() / 1000),
  ) {
    if (operatorKey.type !== "public" || vault.role !== "signer")
      throw Error("signer_policy");
    db.exec(`PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS signer_refund_journal(id TEXT PRIMARY KEY,order_id TEXT NOT NULL UNIQUE,digest TEXT NOT NULL,state TEXT NOT NULL,approval TEXT,created INTEGER NOT NULL);`);
  }
  async review(bundle: UnsignedRefundBundle) {
    const { request: r } = bundle,
      now = this.clock();
    validateRequest(r, now);
    await verifyUser(r, bundle.userSignature);
    verifyApproval("operator", r, bundle.operatorApproval, this.operatorKey);
    await this.reader.validateShieldedDestination(r.destination);
    const e = await this.reader.read(r.orderId);
    if (
      e.network !== "zcash-testnet" ||
      e.orderId !== r.orderId ||
      e.intentDigest !== r.intentDigest ||
      e.paymentDigest !== r.paymentDigest ||
      e.recipient !== r.recipient ||
      e.destination !== r.destination ||
      e.eligibleZatoshis !== r.eligibleZatoshis ||
      e.execution !== "never-constructed" ||
      !["recovery", "expired", "failed"].includes(e.orderState)
    )
      throw Error("independent_evidence_mismatch");
    if (
      !Number.isSafeInteger(e.tip) ||
      e.tip < 1 ||
      e.scanned !== e.tip ||
      !Number.isSafeInteger(e.minimumConfirmations) ||
      e.minimumConfirmations < 10 ||
      !Number.isSafeInteger(e.observedAt) ||
      e.observedAt > now + 5 ||
      now - e.observedAt > 120
    )
      throw Error("independent_evidence_stale_or_unconfirmed");
    if (
      amount(r.refundZatoshis, true) + amount(r.feeCeilingZatoshis, true) >
      amount(e.eligibleZatoshis, true)
    )
      throw Error("independent_amount_limit");
    return {
      requestDigest: digest(r),
      orderId: r.orderId,
      destination: r.destination,
      amount: r.refundZatoshis,
      maximumFee: r.feeCeilingZatoshis,
      network: r.network,
      expires: r.expires,
      transactionSigned: false,
    };
  }
  async approve(bundle: UnsignedRefundBundle, explicitReviewedDigest: string) {
    const review = await this.review(bundle);
    if (explicitReviewedDigest !== review.requestDigest)
      throw Error("independent_explicit_review_required");
    if (!this.vault.unlocked) throw Error("signer_locked");
    const r = bundle.request;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.db
        .prepare("SELECT * FROM signer_refund_journal WHERE id=?")
        .get(r.id) as
        { digest: string; state: string; approval: string | null } | undefined;
      if (old) {
        if (old.digest !== review.requestDigest)
          throw Error("signer_idempotency_conflict");
        if (!old.approval)
          throw Error("interrupted_signer_requires_reconciliation");
        this.db.exec("COMMIT");
        return JSON.parse(old.approval) as Approval;
      }
      this.db
        .prepare(
          "INSERT INTO signer_refund_journal VALUES(?,?,?,'REVIEW_APPROVING',NULL,?)",
        )
        .run(r.id, r.orderId, review.requestDigest, this.clock());
      this.db.exec("COMMIT");
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
    // Durable claim precedes the signature. Crash before persistence fails closed;
    // a different request ID for the same order is also rejected by the unique key.
    const approval = this.vault.withKey((k) => approveRequest("signer", r, k));
    this.db
      .prepare(
        "UPDATE signer_refund_journal SET state='REVIEW_APPROVED',approval=? WHERE id=? AND state='REVIEW_APPROVING'",
      )
      .run(canonical(approval), r.id);
    return approval;
  }
}
