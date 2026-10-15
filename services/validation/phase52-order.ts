// Isolated test orders only; reuses the existing lifecycle. No EVM/refund signer.
import { DatabaseSync } from "node:sqlite";
import { Lifecycle } from "../settlement/lifecycle.ts";
import { digest, canonical } from "../settlement/protocol.ts";
import type { PaymentReview } from "./phase52-payment-review.ts";
type Scan = {
  network: string;
  account: string;
  tip: number;
  scanned: number;
  observedAt: number;
  blockHash: string;
  payments: {
    txid: string;
    zatoshis: string;
    height: number;
    pool: number;
    blockHash: string;
    index: number;
  }[];
};
export class Phase52TestOrder {
  readonly lifecycle: Lifecycle;
  constructor(
    readonly db: DatabaseSync,
    readonly now = () => Math.floor(Date.now() / 1000),
  ) {
    if (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('orders','purchases')",
        )
        .get()
    )
      throw Error("isolated_order_database_required");
    db.exec(
      "PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS phase52_test_orders(id TEXT PRIMARY KEY,intent TEXT NOT NULL,review TEXT,receipt TEXT); CREATE TABLE IF NOT EXISTS phase52_execution_veto(id TEXT PRIMARY KEY,reason TEXT NOT NULL)",
    );
    this.lifecycle = new Lifecycle(db);
  }
  create(intent: any) {
    if (
      intent.network !== "zcash-testnet" ||
      intent.zatoshis !== "100000" ||
      intent.minimumConfirmations !== 10 ||
      intent.executionEnabled !== false ||
      intent.purpose !== "controlled-preconstruction-failure-refund-test"
    )
      throw Error("fixed_phase52_order_required");
    const row = this.db
      .prepare("SELECT intent FROM phase52_test_orders WHERE id=?")
      .get(intent.orderId);
    if (row) {
      if (row.intent !== canonical(intent))
        throw Error("isolated_intent_conflict");
      return;
    }
    this.db.exec("SAVEPOINT phase52_create");
    try {
      this.lifecycle.create(intent.orderId, intent, this.now());
      this.db
        .prepare("INSERT INTO phase52_test_orders(id,intent) VALUES(?,?)")
        .run(intent.orderId, canonical(intent));
      this.db.exec("RELEASE phase52_create");
    } catch (e) {
      this.db.exec("ROLLBACK TO phase52_create; RELEASE phase52_create");
      throw e;
    }
  }
  prepared(id: string, review: PaymentReview) {
    const row = this.db
      .prepare("SELECT intent,review FROM phase52_test_orders WHERE id=?")
      .get(id);
    if (!row) throw Error("missing_test_order");
    const intent = JSON.parse(String(row.intent));
    if (
      review.profileId !== intent.profileId ||
      review.requestId !== intent.paymentRequestId ||
      review.recipient !== intent.recipient ||
      review.zatoshis !== intent.zatoshis ||
      review.network !== intent.network
    )
      throw Error("prepared_test_order_conflict");
    if (row.review) {
      if (row.review !== canonical(review))
        throw Error("prepared_transaction_conflict");
      return;
    }
    this.db.exec("SAVEPOINT phase52_prepare");
    try {
      const s = this.lifecycle.get(id)!;
      this.lifecycle.transition(
        id,
        s.version,
        "QUOTED",
        "native_payment_prepared",
        this.now(),
      );
      this.db
        .prepare("UPDATE phase52_test_orders SET review=? WHERE id=?")
        .run(canonical(review), id);
      this.db.exec("RELEASE phase52_prepare");
    } catch (e) {
      this.db.exec("ROLLBACK TO phase52_prepare; RELEASE phase52_prepare");
      throw e;
    }
  }
  approve(id: string, approved: string) {
    const row = this.db
      .prepare("SELECT review FROM phase52_test_orders WHERE id=?")
      .get(id);
    if (!row?.review || digest(JSON.parse(String(row.review))) !== approved)
      throw Error("exact_test_payment_approval_required");
    const s = this.lifecycle.get(id)!;
    if (s.state === "AWAITING_PAYMENT") return;
    this.db.exec("SAVEPOINT phase52_approve");
    try {
      const next = this.lifecycle.transition(
        id,
        s.version,
        "USER_APPROVED",
        "operator_exact_payment_approval",
        this.now(),
      );
      this.lifecycle.transition(
        id,
        next.version,
        "AWAITING_PAYMENT",
        "awaiting_native_payment",
        this.now(),
      );
      this.db.exec("RELEASE phase52_approve");
    } catch (e) {
      this.db.exec("ROLLBACK TO phase52_approve; RELEASE phase52_approve");
      throw e;
    }
  }
  controlledRecovery(id: string, account: string, a: Scan, b: Scan) {
    const row = this.db
      .prepare("SELECT review,receipt FROM phase52_test_orders WHERE id=?")
      .get(id);
    if (!row?.review) throw Error("missing_prepared_order");
    const review: PaymentReview = JSON.parse(String(row.review));
    for (const s of [a, b])
      if (
        s.network !== "zcash-testnet" ||
        s.account !== account ||
        s.scanned !== s.tip ||
        !Number.isSafeInteger(s.observedAt) ||
        s.observedAt > this.now() + 5 ||
        this.now() - s.observedAt > 120
      )
        throw Error("stale_or_foreign_order_scan");
    if (
      a.tip !== b.tip ||
      a.blockHash !== b.blockHash ||
      canonical(a.payments) !== canonical(b.payments)
    )
      throw Error("order_scanner_disagreement");
    const matches = a.payments.filter(
      (p) =>
        p.txid === review.txid &&
        p.zatoshis === review.zatoshis &&
        p.pool === 4,
    );
    if (matches.length !== 1 || a.tip - matches[0].height + 1 < 10)
      throw Error("ten_confirmation_exact_payment_required");
    const receipt = {
      txid: review.txid,
      height: matches[0].height,
      blockHash: matches[0].blockHash,
      tipHash: a.blockHash,
      observedAt: Math.min(a.observedAt, b.observedAt),
      confirmations: a.tip - matches[0].height + 1,
    };
    const s = this.lifecycle.get(id)!;
    if (s.state === "RECOVERY_REQUIRED") {
      const prior = JSON.parse(String(row.receipt));
      if (
        prior.txid !== review.txid ||
        prior.height !== receipt.height ||
        prior.blockHash !== receipt.blockHash
      )
        throw Error("receipt_conflict");
      return;
    }
    if (s.state !== "AWAITING_PAYMENT")
      throw Error("order_not_awaiting_payment");
    this.db.exec("SAVEPOINT phase52_recover");
    try {
      let current = s;
      for (const next of [
        "PAYMENT_DETECTED",
        "CONFIRMING",
        "PAYMENT_CONFIRMED",
        "RECOVERY_REQUIRED",
      ] as const)
        current = this.lifecycle.transition(
          id,
          current.version,
          next,
          next === "RECOVERY_REQUIRED"
            ? "controlled_preconstruction_failure"
            : "verified_native_payment",
          this.now(),
        );
      this.db
        .prepare(
          "INSERT INTO phase52_execution_veto VALUES(?,'controlled_preconstruction_failure')",
        )
        .run(id);
      this.db
        .prepare("UPDATE phase52_test_orders SET receipt=? WHERE id=?")
        .run(canonical(receipt), id);
      this.db.exec("RELEASE phase52_recover");
    } catch (e) {
      this.db.exec("ROLLBACK TO phase52_recover; RELEASE phase52_recover");
      throw e;
    }
  }
  view(id: string) {
    const s = this.lifecycle.view(id);
    return {
      ...s,
      executionBlocked:
        s.executionBlocked ||
        !!this.db
          .prepare("SELECT id FROM phase52_execution_veto WHERE id=?")
          .get(id),
      refundBroadcastEnabled: false,
    };
  }
  assertExecutionAllowed(id: string): never {
    this.view(id);
    throw Error("phase52_test_execution_disabled");
  }
}
