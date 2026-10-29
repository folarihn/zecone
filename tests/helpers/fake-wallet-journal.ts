// A synthetic integrated-wallet spend journal with the exact v3 schema the Rust
// spend wallet writes (services/zcash-mainnet-spend/src/journal.rs). Holds no
// keys or signed bytes; tests use it to exercise the pre-deadline evidence rule.
import { DatabaseSync } from "node:sqlite";

export interface FakeSpendSession {
  sessionId: string;
  txid: string;
  signedDigest?: string;
  destination: string;
  zatoshis: string;
  expiryHeight: number;
  /** Approval session expiry (the --approval-deadline cap). */
  expires: number;
  signApprovedAt: number;
  signedAt: number;
  broadcastApprovedAt: number;
  broadcastAttemptAt: number;
}

export function fakeWalletJournal(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS spend_sessions_v3(
      session_id TEXT PRIMARY KEY,intent_json TEXT NOT NULL,prepared_digest TEXT NOT NULL,
      signed_digest TEXT,txid TEXT,artifact_nonce BLOB,artifact_ciphertext BLOB,
      state TEXT NOT NULL CHECK(state IN('PREPARED','SIGN_APPROVED','SIGNED','BROADCAST_APPROVED','SUBMITTING','SUBMITTED','CONFIRMED','FINALIZED','EXPIRED','REJECTED','UNCERTAIN')),
      submitted_at INTEGER,mined_height INTEGER,confirmations INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS submission_attempts_v3(
      id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL REFERENCES spend_sessions_v3(session_id),
      provider TEXT NOT NULL,outcome TEXT NOT NULL,detail TEXT NOT NULL,attempted_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS session_events_v3(
      id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL REFERENCES spend_sessions_v3(session_id),
      prior_state TEXT,next_state TEXT NOT NULL,evidence TEXT NOT NULL,created_at INTEGER NOT NULL);`);
  return {
    path,
    add(s: FakeSpendSession) {
      const intent = {
        session_id: s.sessionId,
        network: "zcash-mainnet",
        destination: s.destination,
        zatoshis: Number(s.zatoshis),
        fee_zatoshis: 10000,
        fee_ceiling: 20000,
        change_zatoshis: 0,
        change_destination: "wallet-internal:ironwood:test",
        selected_notes: [],
        prepared_digest: "p".repeat(64),
        expires: s.expires,
        expiry_height: s.expiryHeight,
      };
      db.prepare(
        `INSERT INTO spend_sessions_v3(session_id,intent_json,prepared_digest,signed_digest,txid,state,submitted_at,created_at,updated_at)
         VALUES(?,?,?,?,?,'SUBMITTED',?,?,?)`,
      ).run(
        s.sessionId,
        JSON.stringify(intent),
        "p".repeat(64),
        s.signedDigest ?? "d".repeat(64),
        s.txid,
        s.broadcastAttemptAt,
        s.signApprovedAt - 5,
        s.broadcastAttemptAt,
      );
      const events: [string | null, string, number][] = [
        [null, "PREPARED", s.signApprovedAt - 5],
        ["PREPARED", "SIGN_APPROVED", s.signApprovedAt],
        ["SIGN_APPROVED", "SIGNED", s.signedAt],
        ["SIGNED", "BROADCAST_APPROVED", s.broadcastApprovedAt],
        ["BROADCAST_APPROVED", "SUBMITTING", s.broadcastAttemptAt],
        ["SUBMITTING", "SUBMITTED", s.broadcastAttemptAt + 1],
      ];
      for (const [prior, next, at] of events)
        db.prepare(
          `INSERT INTO session_events_v3(session_id,prior_state,next_state,evidence,created_at) VALUES(?,?,?,?,?)`,
        ).run(s.sessionId, prior, next, "test", at);
      db.prepare(
        `INSERT INTO submission_attempts_v3(session_id,provider,outcome,detail,attempted_at) VALUES(?,?,?,?,?)`,
      ).run(
        s.sessionId,
        "primary",
        "ACCEPTED",
        "test",
        s.broadcastAttemptAt + 1,
      );
    },
    close() {
      db.close();
    },
  };
}
