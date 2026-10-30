/** Durable fault-injection model only. There is deliberately no live transport.
 * A simulation has its own database; never attach this to production settlement tables.
 */
import { DatabaseSync } from "node:sqlite";
import { digest, canonical } from "./protocol.ts";
export type SimulationArtifact = {
  refundId: string;
  orderId: string;
  requestDigest: string;
  txid: string;
  rawHex: string;
  destination: string;
  zatoshis: string;
};
export type SimulationReceipt = {
  network: "zcash-testnet";
  txid: string;
  destination: string;
  zatoshis: string;
  tip: number;
  minedHeight: number;
  blockHash: string;
  observedAt: number;
};
export interface SimulationTransport {
  readonly simulation: true;
  sendExact(rawHex: string): Promise<string>;
  receipt(txid: string): Promise<SimulationReceipt | null>;
}
type Row = {
  id: string;
  order_id: string;
  binding: string;
  artifact: string;
  state: string;
  observed: number;
  block_hash: string | null;
  mined_height: number | null;
};
export class SimulatedRefundDelivery {
  constructor(
    readonly db: DatabaseSync,
    readonly transport: SimulationTransport,
    readonly clock = () => Math.floor(Date.now() / 1000),
  ) {
    if (
      transport.simulation !== true ||
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('orders','settlement_refunds')",
        )
        .get()
    )
      throw Error("simulation_only_database_required");
    db.exec(
      "PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS simulated_refund_delivery(id TEXT PRIMARY KEY,order_id TEXT NOT NULL UNIQUE,binding TEXT NOT NULL,artifact TEXT NOT NULL,state TEXT NOT NULL,observed INTEGER NOT NULL,block_hash TEXT,mined_height INTEGER); CREATE TABLE IF NOT EXISTS simulated_delivery_events(seq INTEGER PRIMARY KEY,id TEXT NOT NULL,event TEXT NOT NULL,at INTEGER NOT NULL)",
    );
  }
  row(id: string) {
    return this.db
      .prepare("SELECT * FROM simulated_refund_delivery WHERE id=?")
      .get(id) as Row | undefined;
  }
  prepare(a: SimulationArtifact, explicitExactTransactionApproval: string) {
    if (
      !/^[a-f0-9]{64}$/.test(a.txid) ||
      !/^([a-f0-9]{2})+$/.test(a.rawHex) ||
      a.rawHex.length > 524288 ||
      !/^[1-9][0-9]*$/.test(a.zatoshis) ||
      digest(a) !== explicitExactTransactionApproval
    )
      throw Error("exact_simulated_transaction_approval_required");
    const old = this.row(a.refundId);
    if (old) {
      if (old.binding !== digest(a)) throw Error("delivery_replay_conflict");
      return;
    }
    this.db
      .prepare(
        "INSERT INTO simulated_refund_delivery VALUES(?,?,?,?,'PREPARED',0,NULL,NULL)",
      )
      .run(a.refundId, a.orderId, digest(a), canonical(a));
  }
  private state(
    id: string,
    state: string,
    event: string,
    receipt?: SimulationReceipt,
  ) {
    this.db.exec("SAVEPOINT delivery_state");
    try {
      this.db
        .prepare(
          "UPDATE simulated_refund_delivery SET state=?,observed=?,block_hash=?,mined_height=? WHERE id=?",
        )
        .run(
          state,
          receipt?.observedAt ?? this.clock(),
          receipt?.blockHash ?? null,
          receipt?.minedHeight ?? null,
          id,
        );
      this.db
        .prepare(
          "INSERT INTO simulated_delivery_events(id,event,at) VALUES(?,?,?)",
        )
        .run(id, event, this.clock());
      this.db.exec("RELEASE delivery_state");
    } catch (e) {
      this.db.exec("ROLLBACK TO delivery_state; RELEASE delivery_state");
      throw e;
    }
  }
  async simulateBroadcast(id: string) {
    const r = this.row(id);
    if (!r) throw Error("unknown_simulated_refund");
    if (digest(JSON.parse(r.artifact)) !== r.binding)
      throw Error("artifact_changed");
    // CAS claim is committed before calling even the simulated external transport.
    const claim = this.db
      .prepare(
        "UPDATE simulated_refund_delivery SET state='BROADCAST_UNCERTAIN' WHERE id=? AND state='PREPARED'",
      )
      .run(id);
    if (claim.changes !== 1) throw Error("already_claimed_reconcile_only");
    const a = JSON.parse(r.artifact) as SimulationArtifact;
    try {
      const txid = await this.transport.sendExact(a.rawHex);
      if (txid !== a.txid) throw Error("broadcast_hash_mismatch");
      this.state(id, "BROADCAST", "simulation_broadcast_acknowledged");
    } catch {
      throw Error("broadcast_outcome_uncertain_reconcile_only");
    }
  }
  async reconcile(id: string) {
    const r = this.row(id);
    if (!r || r.state === "PREPARED") throw Error("not_submitted");
    const a = JSON.parse(r.artifact) as SimulationArtifact;
    if (digest(a) !== r.binding) throw Error("artifact_changed");
    const e = await this.transport.receipt(a.txid),
      now = this.clock();
    if (!e) {
      this.state(id, "RECOVERY_REQUIRED", "simulation_receipt_absent");
      return;
    }
    if (
      e.network !== "zcash-testnet" ||
      e.txid !== a.txid ||
      e.destination !== a.destination ||
      e.zatoshis !== a.zatoshis ||
      !Number.isSafeInteger(e.tip) ||
      !Number.isSafeInteger(e.minedHeight) ||
      e.minedHeight < 1 ||
      e.tip < e.minedHeight ||
      !/^[a-f0-9]{64}$/.test(e.blockHash) ||
      !Number.isSafeInteger(e.observedAt) ||
      e.observedAt < r.observed ||
      e.observedAt > now + 5 ||
      now - e.observedAt > 120
    ) {
      this.state(id, "RECOVERY_REQUIRED", "simulation_evidence_rejected");
      throw Error("stale_or_conflicting_refund_evidence");
    }
    const state = e.tip - e.minedHeight + 1 >= 10 ? "REFUNDED" : "CONFIRMING";
    this.state(id, state, "simulation_receipt_verified", e);
  }
  view(id: string) {
    const r = this.row(id);
    if (!r) throw Error("unknown_simulated_refund");
    return {
      id,
      state: r.state,
      simulation: true,
      executionBlocked: true,
      liveRefundConfirmed: false,
    };
  }
  broadcast(): never {
    throw Error("live_refunds_disabled_separate_device_validation_required");
  }
}
