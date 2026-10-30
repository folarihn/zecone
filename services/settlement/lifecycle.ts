import { DatabaseSync } from "node:sqlite";
import { digest, identifier } from "./protocol.ts";

export const STATES = [
  "CREATED",
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
  "EXECUTION_FAILED",
  "RECOVERY_REQUIRED",
  "REFUND_REQUESTED",
  "REFUND_APPROVED",
  "REFUND_SIGNING",
  "REFUND_BROADCAST",
  "REFUND_CONFIRMING",
  "REFUNDED",
] as const;
export type SettlementState = (typeof STATES)[number];
const edges: Record<SettlementState, readonly SettlementState[]> = {
  CREATED: ["QUOTED"],
  QUOTED: ["USER_APPROVED", "RECOVERY_REQUIRED"],
  USER_APPROVED: ["AWAITING_PAYMENT", "RECOVERY_REQUIRED"],
  AWAITING_PAYMENT: ["PAYMENT_DETECTED", "RECOVERY_REQUIRED"],
  PAYMENT_DETECTED: ["CONFIRMING", "RECOVERY_REQUIRED"],
  CONFIRMING: ["PAYMENT_CONFIRMED", "RECOVERY_REQUIRED"],
  PAYMENT_CONFIRMED: ["LIQUIDITY_RESERVED", "RECOVERY_REQUIRED"],
  LIQUIDITY_RESERVED: ["EXECUTION_READY", "RECOVERY_REQUIRED"],
  EXECUTION_READY: ["EXECUTING", "RECOVERY_REQUIRED"],
  EXECUTING: ["EXECUTION_UNCERTAIN", "COMPLETED", "EXECUTION_FAILED"],
  EXECUTION_UNCERTAIN: ["COMPLETED", "EXECUTION_FAILED"],
  COMPLETED: [],
  EXECUTION_FAILED: ["RECOVERY_REQUIRED"],
  RECOVERY_REQUIRED: ["REFUND_REQUESTED"],
  REFUND_REQUESTED: ["REFUND_APPROVED", "RECOVERY_REQUIRED"],
  REFUND_APPROVED: ["REFUND_SIGNING", "RECOVERY_REQUIRED"],
  REFUND_SIGNING: ["REFUND_BROADCAST", "RECOVERY_REQUIRED"],
  REFUND_BROADCAST: ["REFUND_CONFIRMING", "RECOVERY_REQUIRED"],
  REFUND_CONFIRMING: ["REFUNDED", "RECOVERY_REQUIRED"],
  REFUNDED: [],
};
export type LifecycleRow = {
  id: string;
  state: SettlementState;
  version: number;
  binding: string;
  execution_blocked: number;
};
// Shared database connection allows a caller to atomically update this graph and its
// existing payment/reservation journal. No historical order is imported automatically.
export class Lifecycle {
  constructor(readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS settlement_lifecycle(id TEXT PRIMARY KEY,state TEXT NOT NULL,version INTEGER NOT NULL,binding TEXT NOT NULL,execution_blocked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS settlement_events(seq INTEGER PRIMARY KEY,id TEXT NOT NULL,at INTEGER NOT NULL,version INTEGER NOT NULL,previous TEXT,next TEXT NOT NULL,reason TEXT NOT NULL,UNIQUE(id,version));`);
  }
  get(id: string) {
    return this.db
      .prepare("SELECT * FROM settlement_lifecycle WHERE id=?")
      .get(id) as LifecycleRow | undefined;
  }
  adoptRecovery(id: string, immutableIntent: unknown, at: number) {
    identifier(id);
    const binding = digest(immutableIntent),
      old = this.get(id);
    if (old) {
      if (old.binding !== binding) throw Error("intent_conflict");
      if (old.state !== "RECOVERY_REQUIRED") throw Error("not_in_recovery");
      return old;
    }
    // Explicit adoption records only the observed legacy recovery state. It does
    // not fabricate earlier lifecycle transitions or rewrite the legacy order.
    this.db
      .prepare(
        "INSERT INTO settlement_lifecycle VALUES(?,'RECOVERY_REQUIRED',0,?,0)",
      )
      .run(id, binding);
    this.db
      .prepare(
        "INSERT INTO settlement_events(id,at,version,previous,next,reason) VALUES(?,?,0,NULL,'RECOVERY_REQUIRED','adopted_legacy_recovery')",
      )
      .run(id, at);
    return this.get(id)!;
  }
  create(id: string, immutableIntent: unknown, at: number) {
    identifier(id);
    const binding = digest(immutableIntent),
      old = this.get(id);
    if (old) {
      if (old.binding !== binding) throw Error("intent_conflict");
      return old;
    }
    this.db.exec("SAVEPOINT lifecycle_create");
    try {
      this.db
        .prepare("INSERT INTO settlement_lifecycle VALUES(?,'CREATED',0,?,0)")
        .run(id, binding);
      this.db
        .prepare(
          "INSERT INTO settlement_events(id,at,version,previous,next,reason) VALUES(?,?,0,NULL,'CREATED','created')",
        )
        .run(id, at);
      this.db.exec("RELEASE lifecycle_create");
      return this.get(id)!;
    } catch (e) {
      this.db.exec("ROLLBACK TO lifecycle_create; RELEASE lifecycle_create");
      throw e;
    }
  }
  transition(
    id: string,
    expectedVersion: number,
    next: SettlementState,
    reason: string,
    at: number,
  ) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(reason) || !Number.isSafeInteger(at))
      throw Error("invalid_event");
    this.db.exec("SAVEPOINT lifecycle_transition");
    try {
      const old = this.get(id);
      if (!old || old.version !== expectedVersion)
        throw Error("stale_transition");
      if (!edges[old.state].includes(next)) throw Error("invalid_transition");
      if (
        old.execution_blocked &&
        ["LIQUIDITY_RESERVED", "EXECUTION_READY", "EXECUTING"].includes(next)
      )
        throw Error("execution_permanently_blocked");
      const changed = this.db
        .prepare(
          "UPDATE settlement_lifecycle SET state=?,version=version+1,execution_blocked=? WHERE id=? AND version=?",
        )
        .run(
          next,
          old.execution_blocked || Number(next === "REFUND_APPROVED"),
          id,
          expectedVersion,
        );
      if (changed.changes !== 1) throw Error("stale_transition");
      this.db
        .prepare(
          "INSERT INTO settlement_events(id,at,version,previous,next,reason) VALUES(?,?,?,?,?,?)",
        )
        .run(id, at, expectedVersion + 1, old.state, next, reason);
      this.db.exec("RELEASE lifecycle_transition");
      return this.get(id)!;
    } catch (e) {
      this.db.exec(
        "ROLLBACK TO lifecycle_transition; RELEASE lifecycle_transition",
      );
      throw e;
    }
  }
  // Public status contains neither intent, payment evidence nor refund destination.
  view(id: string) {
    const r = this.get(id);
    if (!r) throw Error("unknown_settlement");
    return {
      id: r.id,
      state: r.state,
      version: r.version,
      executionBlocked: !!r.execution_blocked,
    };
  }
}
