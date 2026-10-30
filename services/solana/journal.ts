import { DatabaseSync } from "node:sqlite";
import { digest, type Prepared } from "./transactions.ts";
import { json, SolanaError } from "./network.ts";
// Independent disposable journal; never opens an existing settlement database.
export class SolanaJournal {
  constructor(readonly db: DatabaseSync) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS solana_actions(id TEXT PRIMARY KEY,intent TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,signature TEXT UNIQUE,recovery INTEGER NOT NULL DEFAULT 0);`,
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS solana_signed(id TEXT PRIMARY KEY REFERENCES solana_actions(id),wire TEXT NOT NULL)",
    );
    db.exec(
      "UPDATE solana_actions SET state='MANUAL_REVIEW' WHERE state IN ('SIGNING','SUBMITTING')",
    );
  }
  save(id: string, p: Prepared) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new SolanaError("INVALID_ID");
    const fingerprint = digest(json(p.action));
    const old = this.get(id);
    if (old) {
      if (old.intent !== fingerprint)
        throw new SolanaError("IDEMPOTENCY_CONFLICT");
      return old;
    }
    this.db
      .prepare(
        "INSERT INTO solana_actions(id,intent,payload,state) VALUES(?,?,?,?)",
      )
      .run(id, fingerprint, json(p), p.state);
    return this.get(id)!;
  }
  get(id: string) {
    return this.db
      .prepare("SELECT * FROM solana_actions WHERE id=?")
      .get(id) as
      | {
          id: string;
          intent: string;
          payload: string;
          state: string;
          signature: string | null;
          recovery: number;
        }
      | undefined;
  }
  claimSigning(id: string, approvedDigest: string, explicit: boolean) {
    if (!explicit) throw new SolanaError("APPROVAL_REQUIRED");
    const row = this.get(id);
    if (!row || JSON.parse(row.payload).digest !== approvedDigest)
      throw new SolanaError("REVIEW_MISMATCH");
    if (
      !this.db
        .prepare(
          "UPDATE solana_actions SET state='SIGNING' WHERE id=? AND state='AWAITING_EXPLICIT_APPROVAL' AND recovery=0",
        )
        .run(id).changes
    )
      throw new SolanaError("DUPLICATE_OR_RECOVERY");
    return JSON.parse(row.payload) as Prepared;
  }
  recordSignature(id: string, signature: string, wire: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (
        !this.db
          .prepare(
            "UPDATE solana_actions SET signature=?,state='SIGNED_NOT_SUBMITTED' WHERE id=? AND state='SIGNING' AND recovery=0",
          )
          .run(signature, id).changes
      )
        throw new SolanaError("INVALID_STATE");
      this.db.prepare("INSERT INTO solana_signed VALUES(?,?)").run(id, wire);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  recovery(id: string) {
    if (
      !this.db
        .prepare(
          "UPDATE solana_actions SET recovery=1,state='RECOVERY_REVIEW' WHERE id=? AND state IN ('AWAITING_EXPLICIT_APPROVAL','SIMULATION_FAILED')",
        )
        .run(id).changes
    )
      throw new SolanaError("EXECUTION_RECOVERY_CONFLICT");
  }
  submit(): never {
    throw new SolanaError("LIVE_BROADCAST_DISABLED");
  }
}
