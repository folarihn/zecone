import { randomUUID, type KeyObject } from "node:crypto";
import type { Address, Hex } from "viem";
import { Store } from "../execution/store.ts";
import {
  amount,
  canonical,
  digest,
  validateRequest,
  verifyUser,
  verifyApproval,
  type Approval,
  type RefundRequest,
} from "./protocol.ts";
import { Lifecycle, type SettlementState } from "./lifecycle.ts";

export type RefundRow = {
  id: string;
  order_id: string;
  state: string;
  request: string;
  user_signature: Hex;
  operator_approval: string | null;
  signer_approval: string | null;
  txid: string | null;
};
export interface DestinationDecoder {
  validate(destination: string): Promise<void>;
}
/** No spending-key, seed path, signer subprocess, generic command or broadcast method. */
export class Refunds {
  readonly lifecycle: Lifecycle;
  constructor(
    readonly store: Store,
    readonly operatorPublicKey: KeyObject,
    readonly signerPublicKey: KeyObject,
    readonly decoder: DestinationDecoder,
    readonly clock = () => Math.floor(Date.now() / 1000),
  ) {
    if (store.confirmations < 10)
      throw Error("refund_requires_ten_confirmations");
    if (
      operatorPublicKey.type !== "public" ||
      signerPublicKey.type !== "public" ||
      operatorPublicKey.equals(signerPublicKey)
    )
      throw Error("independent_public_approval_keys_required");
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS settlement_refunds(id TEXT PRIMARY KEY,order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),state TEXT NOT NULL,request TEXT NOT NULL,user_signature TEXT NOT NULL,operator_approval TEXT,signer_approval TEXT,txid TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS settlement_execution_veto(order_id TEXT PRIMARY KEY REFERENCES orders(id),refund_id TEXT NOT NULL UNIQUE);`);
    this.lifecycle = new Lifecycle(store.db);
  }
  private advance(orderId: string, next: SettlementState, reason: string) {
    const row = this.lifecycle.get(orderId);
    if (!row) throw Error("missing_refund_lifecycle");
    return this.lifecycle.transition(
      orderId,
      row.version,
      next,
      reason,
      this.clock(),
    );
  }
  row(id: string) {
    return this.store.db
      .prepare("SELECT * FROM settlement_refunds WHERE id=?")
      .get(id) as RefundRow | undefined;
  }
  private eligible(orderId: string, at: number) {
    const o = this.store.get(orderId);
    // Conservative first version: a previously constructed EVM transaction can be
    // rebroadcast by anyone. Even 'failed' needs independent nonce/finality proof.
    if (
      !o ||
      !["recovery", "expired", "failed"].includes(o.state) ||
      o.raw ||
      o.tx_hash
    )
      throw Error("execution_not_proven_impossible");
    if (
      this.store.db
        .prepare(
          "SELECT order_id FROM execution_construction_claims WHERE order_id=?",
        )
        .get(orderId)
    )
      throw Error("execution_construction_requires_reconciliation");
    if (o.observed_at > at + 5 || at - o.observed_at > 120)
      throw Error("stale_refund_scan");
    const t = this.store.totals(orderId);
    if (t.confirmed <= 0n || t.confirmed !== t.received)
      throw Error("refund_payment_not_fully_confirmed");
    amount(t.confirmed.toString(), true);
    const outputs = this.store.db
      .prepare(
        "SELECT key,zatoshis,height,block_hash FROM payments WHERE order_id=? AND active=1 AND confirmed=1 ORDER BY key",
      )
      .all(orderId);
    return {
      order: o,
      total: t.confirmed,
      paymentDigest: digest(outputs),
      intent: JSON.parse(o.intent),
    };
  }
  async draft(
    orderId: string,
    destination: string,
    feeCeilingZatoshis: string,
  ): Promise<RefundRequest> {
    await this.decoder.validate(destination);
    const at = this.clock(),
      e = this.eligible(orderId, at),
      fee = amount(feeCeilingZatoshis, true);
    if (fee >= e.total) throw Error("refund_dust_after_fee");
    const request: RefundRequest = {
      version: 1,
      domain: "zecone-testnet-refund-v1",
      network: "zcash-testnet",
      id: randomUUID(),
      orderId,
      intentDigest: digest(e.intent),
      paymentDigest: e.paymentDigest,
      recipient: e.intent.recipient as Address,
      destination,
      eligibleZatoshis: e.total.toString(),
      refundZatoshis: (e.total - fee).toString(),
      feeCeilingZatoshis,
      created: at,
      expires: at + 3600,
    };
    validateRequest(request, at);
    return request;
  }
  private matches(request: RefundRequest, at: number) {
    validateRequest(request, at);
    const e = this.eligible(request.orderId, at);
    if (
      e.total !== amount(request.eligibleZatoshis) ||
      e.paymentDigest !== request.paymentDigest ||
      digest(e.intent) !== request.intentDigest ||
      e.intent.recipient !== request.recipient
    )
      throw Error("refund_evidence_changed");
    return e;
  }
  async request(request: RefundRequest, userSignature: Hex) {
    validateRequest(request, this.clock());
    await this.decoder.validate(request.destination);
    await verifyUser(request, userSignature);
    return this.store.atomic(() => {
      const previous = this.row(request.id);
      if (previous) {
        if (
          previous.request !== canonical(request) ||
          previous.user_signature !== userSignature
        )
          throw Error("refund_idempotency_conflict");
        return previous;
      }
      if (
        this.store.db
          .prepare("SELECT id FROM settlement_refunds WHERE order_id=?")
          .get(request.orderId)
      )
        throw Error("duplicate_refund_order");
      const e = this.matches(request, this.clock());
      this.lifecycle.adoptRecovery(request.orderId, e.intent, this.clock());
      this.advance(request.orderId, "REFUND_REQUESTED", "user_refund_request");
      this.store.db
        .prepare(
          "INSERT INTO settlement_refunds(id,order_id,state,request,user_signature) VALUES(?,?,'REFUND_REQUESTED',?,?)",
        )
        .run(request.id, request.orderId, canonical(request), userSignature);
      this.store.event(
        request.orderId,
        "refund_requested",
        { refundId: request.id },
        this.clock(),
      );
      return this.row(request.id)!;
    });
  }
  approve(id: string, approval: Approval) {
    return this.store.atomic(() => {
      const r = this.row(id);
      if (!r) throw Error("unknown_refund");
      const request = JSON.parse(r.request) as RefundRequest;
      verifyApproval("operator", request, approval, this.operatorPublicKey);
      if (r.operator_approval) {
        if (r.operator_approval !== canonical(approval))
          throw Error("approval_conflict");
        return r;
      }
      if (r.state !== "REFUND_REQUESTED") throw Error("refund_state");
      this.matches(request, this.clock());
      this.store.db
        .prepare("INSERT INTO settlement_execution_veto VALUES(?,?)")
        .run(r.order_id, id);
      this.advance(r.order_id, "REFUND_APPROVED", "operator_refund_approval");
      this.store.db
        .prepare(
          "UPDATE settlement_refunds SET state='REFUND_APPROVED',operator_approval=? WHERE id=?",
        )
        .run(canonical(approval), id);
      this.store.transition(r.order_id, "recovery", this.clock());
      this.store.event(
        r.order_id,
        "refund_approved_execution_veto",
        { refundId: id },
        this.clock(),
      );
      return this.row(id)!;
    });
  }
  exportUnsigned(id: string) {
    const r = this.row(id);
    if (!r || r.state !== "REFUND_APPROVED") throw Error("refund_not_approved");
    this.matches(JSON.parse(r.request), this.clock());
    return {
      request: JSON.parse(r.request) as RefundRequest,
      userSignature: r.user_signature,
      operatorApproval: JSON.parse(r.operator_approval!) as Approval,
    };
  }
  acceptSignerApproval(id: string, approval: Approval) {
    return this.store.atomic(() => {
      const r = this.row(id);
      if (!r) throw Error("unknown_refund");
      const request = JSON.parse(r.request) as RefundRequest;
      verifyApproval("signer", request, approval, this.signerPublicKey);
      if (r.signer_approval) {
        if (r.signer_approval !== canonical(approval))
          throw Error("signer_conflict");
        return r;
      }
      if (r.state !== "REFUND_APPROVED") throw Error("refund_state");
      this.matches(request, this.clock());
      this.advance(r.order_id, "REFUND_SIGNING", "independent_signer_review");
      this.store.db
        .prepare(
          "UPDATE settlement_refunds SET state='REFUND_SIGNING',signer_approval=? WHERE id=?",
        )
        .run(canonical(approval), id);
      this.store.event(
        r.order_id,
        "refund_signer_approved",
        { refundId: id },
        this.clock(),
      );
      return this.row(id)!;
    });
  }
  reconcilePayment(id: string) {
    return this.store.atomic(() => {
      const r = this.row(id);
      if (!r) throw Error("unknown_refund");
      try {
        this.matches(JSON.parse(r.request), this.clock());
        return r;
      } catch {
        // An authorization might already have left the backend. Never remove its
        // execution veto, reset its signer state, or create a replacement refund.
        this.store.db
          .prepare(
            "UPDATE settlement_refunds SET state='RECOVERY_REQUIRED' WHERE id=?",
          )
          .run(id);
        if (this.lifecycle.get(r.order_id)?.state !== "RECOVERY_REQUIRED")
          this.advance(
            r.order_id,
            "RECOVERY_REQUIRED",
            "refund_evidence_needs_review",
          );
        this.store.event(
          r.order_id,
          "refund_reconciliation_required",
          { refundId: id },
          this.clock(),
        );
        return this.row(id)!;
      }
    });
  }
  view(id: string) {
    const r = this.row(id);
    if (!r) throw Error("unknown_refund");
    return {
      id: r.id,
      state: r.state,
      transactionId: r.txid,
      liveTransportAvailable: false,
      refundConfirmed: false,
    };
  }
  broadcast(): never {
    throw Error("independent_native_refund_transport_not_enabled");
  }
}
