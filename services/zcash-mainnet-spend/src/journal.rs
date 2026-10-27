//! Durable, fail-closed transaction journal for mainnet shielded spends.
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum State {
    Prepared,
    SignApproved,
    Signed,
    BroadcastApproved,
    Submitting,
    Submitted,
    Confirmed,
    Finalized,
    Expired,
    Rejected,
    Uncertain,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Prepared => "PREPARED",
            Self::SignApproved => "SIGN_APPROVED",
            Self::Signed => "SIGNED",
            Self::BroadcastApproved => "BROADCAST_APPROVED",
            Self::Submitting => "SUBMITTING",
            Self::Submitted => "SUBMITTED",
            Self::Confirmed => "CONFIRMED",
            Self::Finalized => "FINALIZED",
            Self::Expired => "EXPIRED",
            Self::Rejected => "REJECTED",
            Self::Uncertain => "UNCERTAIN",
        }
    }
    fn parse(value: &str) -> Result<Self> {
        match value {
            "PREPARED" => Ok(Self::Prepared),
            "SIGN_APPROVED" => Ok(Self::SignApproved),
            "SIGNED" => Ok(Self::Signed),
            "BROADCAST_APPROVED" => Ok(Self::BroadcastApproved),
            "SUBMITTING" => Ok(Self::Submitting),
            "SUBMITTED" => Ok(Self::Submitted),
            "CONFIRMED" => Ok(Self::Confirmed),
            "FINALIZED" => Ok(Self::Finalized),
            "EXPIRED" => Ok(Self::Expired),
            "REJECTED" => Ok(Self::Rejected),
            "UNCERTAIN" => Ok(Self::Uncertain),
            _ => anyhow::bail!("unknown journal state"),
        }
    }
    fn terminal(self) -> bool {
        matches!(self, Self::Finalized | Self::Expired | Self::Rejected)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteReservation {
    pub txid: String,
    pub pool: String,
    pub output_index: u16,
    pub zatoshis: u64,
}
impl NoteReservation {
    fn key(&self) -> String {
        format!("{}:{}:{}", self.txid, self.pool, self.output_index)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreparedSession {
    pub session_id: String,
    pub network: String,
    pub destination: String,
    pub zatoshis: u64,
    pub fee_zatoshis: u64,
    pub fee_ceiling: u64,
    pub change_zatoshis: u64,
    pub change_destination: String,
    pub selected_notes: Vec<NoteReservation>,
    pub prepared_digest: String,
    pub expires: u64,
    pub expiry_height: u32,
}
pub type SignApproval = PreparedSession;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BroadcastApproval {
    pub session: PreparedSession,
    pub txid: String,
    pub signed_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SessionStatus {
    pub session: PreparedSession,
    pub state: State,
    pub txid: Option<String>,
    pub signed_digest: Option<String>,
    pub submitted_at: Option<u64>,
    pub mined_height: Option<u32>,
    pub confirmations: u32,
    pub updated_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SubmissionAttempt {
    pub provider: String,
    pub outcome: String,
    pub detail: String,
    pub attempted_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedArtifact {
    pub txid: String,
    pub signed_digest: String,
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NetworkObservation {
    Unknown { tip: u32 },
    Mempool { tip: u32 },
    Mined { height: u32, tip: u32 },
    Reorganized { former_height: u32, tip: u32 },
}

pub struct SessionStore {
    conn: Connection,
}

pub fn sign_review_digest(session: &PreparedSession) -> Result<String> {
    let mut h = Sha256::new();
    h.update(b"zecone-zcash-mainnet-sign-review-v2\0");
    h.update(serde_json::to_vec(session)?);
    Ok(hex::encode(h.finalize()))
}
pub fn broadcast_review_digest(approval: &BroadcastApproval) -> Result<String> {
    let mut h = Sha256::new();
    h.update(b"zecone-zcash-mainnet-broadcast-review-v2\0");
    h.update(serde_json::to_vec(&approval.session)?);
    h.update(b"\0");
    h.update(approval.txid.as_bytes());
    h.update(b"\0");
    h.update(approval.signed_digest.as_bytes());
    Ok(hex::encode(h.finalize()))
}
fn valid_id(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 128
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn valid_digest(v: &str) -> bool {
    v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit())
}

impl SessionStore {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS spend_sessions_v3(
               session_id TEXT PRIMARY KEY,intent_json TEXT NOT NULL,prepared_digest TEXT NOT NULL,
               signed_digest TEXT,txid TEXT,artifact_nonce BLOB,artifact_ciphertext BLOB,
               state TEXT NOT NULL CHECK(state IN('PREPARED','SIGN_APPROVED','SIGNED','BROADCAST_APPROVED','SUBMITTING','SUBMITTED','CONFIRMED','FINALIZED','EXPIRED','REJECTED','UNCERTAIN')),
               submitted_at INTEGER,mined_height INTEGER,confirmations INTEGER NOT NULL DEFAULT 0,
               created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS note_reservations_v3(
               note_key TEXT NOT NULL,session_id TEXT NOT NULL REFERENCES spend_sessions_v3(session_id),
               active INTEGER NOT NULL CHECK(active IN(0,1)),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
             CREATE UNIQUE INDEX IF NOT EXISTS note_reservation_history_v3 ON note_reservations_v3(note_key,session_id);
             CREATE UNIQUE INDEX IF NOT EXISTS one_active_note_reservation_v3 ON note_reservations_v3(note_key) WHERE active=1;
             CREATE TABLE IF NOT EXISTS submission_attempts_v3(
               id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL REFERENCES spend_sessions_v3(session_id),
               provider TEXT NOT NULL,outcome TEXT NOT NULL,detail TEXT NOT NULL,attempted_at INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS session_events_v3(
               id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL REFERENCES spend_sessions_v3(session_id),
               prior_state TEXT,next_state TEXT NOT NULL,evidence TEXT NOT NULL,created_at INTEGER NOT NULL);"
        )?;
        Ok(Self { conn })
    }

    pub fn prepare(&mut self, s: &PreparedSession, now: u64) -> Result<()> {
        validate_session(s, now)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure!(
            load_status(&tx, &s.session_id)?.is_none(),
            "session id already exists"
        );
        tx.execute("INSERT INTO spend_sessions_v3(session_id,intent_json,prepared_digest,state,created_at,updated_at) VALUES(?,?,?,'PREPARED',?,?)",
            params![s.session_id, serde_json::to_string(s)?, s.prepared_digest, i64::try_from(now)?, i64::try_from(now)?])?;
        for note in &s.selected_notes {
            tx.execute("INSERT INTO note_reservations_v3(note_key,session_id,active,created_at,updated_at) VALUES(?,?,1,?,?)",
                params![note.key(), s.session_id, i64::try_from(now)?, i64::try_from(now)?])
                .with_context(|| format!("source note {} is already reserved", note.key()))?;
        }
        event(
            &tx,
            &s.session_id,
            None,
            State::Prepared,
            "intent and notes reserved",
            now,
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn record_sign(&mut self, a: &SignApproval, now: u64) -> Result<()> {
        validate_session(a, now)?;
        self.transition_exact(
            a,
            State::Prepared,
            State::SignApproved,
            now,
            "exact SIGN approval consumed",
        )
    }

    pub fn record_signed(
        &mut self,
        s: &PreparedSession,
        a: &SignedArtifact,
        now: u64,
    ) -> Result<()> {
        validate_session(s, now)?;
        ensure!(valid_digest(&a.txid), "invalid signed transaction id");
        ensure!(
            valid_digest(&a.signed_digest),
            "invalid signed transaction digest"
        );
        ensure!(
            a.nonce.len() == 12 && !a.ciphertext.is_empty(),
            "invalid signed artifact"
        );
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = require_exact(&tx, s)?;
        ensure!(
            current.state == State::SignApproved,
            "approval replay or invalid state"
        );
        let changed = tx.execute("UPDATE spend_sessions_v3 SET state='SIGNED',txid=?,signed_digest=?,artifact_nonce=?,artifact_ciphertext=?,updated_at=? WHERE session_id=? AND state='SIGN_APPROVED'",
            params![a.txid,a.signed_digest,a.nonce,a.ciphertext,i64::try_from(now)?,s.session_id])?;
        ensure!(changed == 1, "concurrent journal state change");
        event(
            &tx,
            &s.session_id,
            Some(State::SignApproved),
            State::Signed,
            "validated signed transaction stored encrypted",
            now,
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn record_broadcast(&mut self, a: &BroadcastApproval, now: u64) -> Result<()> {
        validate_session(&a.session, now)?;
        ensure!(
            valid_digest(&a.txid) && valid_digest(&a.signed_digest),
            "invalid signed transaction binding"
        );
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let status = require_exact(&tx, &a.session)?;
        ensure!(
            status.state == State::Signed,
            "approval replay or invalid state"
        );
        ensure!(
            status.txid.as_deref() == Some(&a.txid),
            "signed transaction id mismatch"
        );
        ensure!(
            status.signed_digest.as_deref() == Some(&a.signed_digest),
            "signed transaction digest mismatch"
        );
        set_state(
            &tx,
            &a.session.session_id,
            State::Signed,
            State::BroadcastApproved,
            now,
            "exact BROADCAST approval consumed",
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn begin_submission(&mut self, id: &str, now: u64) -> Result<SignedArtifact> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let s = load_status(&tx, id)?.context("unknown spending session")?;
        ensure!(
            s.state == State::BroadcastApproved,
            "BROADCAST approval required or already consumed"
        );
        ensure!(s.session.expires > now, "approval session expired");
        let artifact = load_artifact(&tx, id)?.context("signed artifact missing")?;
        set_state(
            &tx,
            id,
            State::BroadcastApproved,
            State::Submitting,
            now,
            "submission started; reservation retained",
        )?;
        tx.commit()?;
        Ok(artifact)
    }

    pub fn record_attempt(&mut self, id: &str, a: &SubmissionAttempt) -> Result<()> {
        ensure!(
            !a.provider.is_empty() && a.detail.len() <= 2048,
            "invalid provider attempt"
        );
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let s = load_status(&tx, id)?.context("unknown spending session")?;
        ensure!(
            matches!(
                s.state,
                State::Submitting | State::Submitted | State::Uncertain
            ),
            "session is not awaiting submission reconciliation"
        );
        tx.execute("INSERT INTO submission_attempts_v3(session_id,provider,outcome,detail,attempted_at) VALUES(?,?,?,?,?)",
            params![id,a.provider,a.outcome,a.detail,i64::try_from(a.attempted_at)?])?;
        tx.commit()?;
        Ok(())
    }

    pub fn finish_submission(
        &mut self,
        id: &str,
        next: State,
        now: u64,
        evidence: &str,
    ) -> Result<()> {
        ensure!(
            matches!(next, State::Submitted | State::Rejected | State::Uncertain),
            "invalid submission outcome"
        );
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let s = load_status(&tx, id)?.context("unknown spending session")?;
        ensure!(s.state == State::Submitting, "session is not submitting");
        let submitted = if next == State::Submitted {
            Some(i64::try_from(now)?)
        } else {
            None
        };
        let changed=tx.execute("UPDATE spend_sessions_v3 SET state=?,submitted_at=COALESCE(?,submitted_at),updated_at=? WHERE session_id=? AND state='SUBMITTING'",
            params![next.as_str(),submitted,i64::try_from(now)?,id])?;
        ensure!(changed == 1, "concurrent journal state change");
        if next.terminal() {
            release(&tx, id, now)?;
        }
        event(&tx, id, Some(State::Submitting), next, evidence, now)?;
        tx.commit()?;
        Ok(())
    }

    pub fn reconcile(
        &mut self,
        id: &str,
        o: NetworkObservation,
        threshold: u32,
        now: u64,
    ) -> Result<State> {
        ensure!(threshold > 0, "confirmation threshold must be positive");
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let s = load_status(&tx, id)?.context("unknown spending session")?;
        ensure!(
            matches!(
                s.state,
                State::Submitting | State::Submitted | State::Confirmed | State::Uncertain
            ),
            "session cannot be reconciled"
        );
        let (next, mined, confs, evidence) = match o {
            NetworkObservation::Unknown { tip } if tip >= s.session.expiry_height => (
                State::Expired,
                None,
                0,
                format!("unknown through expiry at tip {tip}"),
            ),
            NetworkObservation::Unknown { tip } => (
                State::Uncertain,
                s.mined_height,
                s.confirmations,
                format!("not visible at tip {tip}"),
            ),
            NetworkObservation::Mempool { tip } => (
                State::Submitted,
                None,
                0,
                format!("visible in mempool at tip {tip}"),
            ),
            NetworkObservation::Mined { height, tip } => {
                ensure!(height <= tip, "mined height exceeds chain tip");
                let c = tip - height + 1;
                (
                    if c >= threshold {
                        State::Finalized
                    } else {
                        State::Confirmed
                    },
                    Some(height),
                    c,
                    format!("authenticated inclusion at {height}; tip {tip}"),
                )
            }
            NetworkObservation::Reorganized { former_height, tip } => (
                State::Uncertain,
                None,
                0,
                format!("reorganization removed height {former_height}; tip {tip}"),
            ),
        };
        tx.execute("UPDATE spend_sessions_v3 SET state=?,mined_height=?,confirmations=?,updated_at=? WHERE session_id=?",
            params![next.as_str(),mined,confs,i64::try_from(now)?,id])?;
        if next.terminal() {
            release(&tx, id, now)?;
        }
        event(&tx, id, Some(s.state), next, &evidence, now)?;
        tx.commit()?;
        Ok(next)
    }

    pub fn reject_pre_submission(
        &mut self,
        id: &str,
        next: State,
        now: u64,
        evidence: &str,
    ) -> Result<()> {
        ensure!(
            matches!(next, State::Expired | State::Rejected),
            "invalid rejection state"
        );
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let s = load_status(&tx, id)?.context("unknown spending session")?;
        ensure!(
            matches!(
                s.state,
                State::Prepared | State::SignApproved | State::Signed | State::BroadcastApproved
            ),
            "active submission cannot be discarded"
        );
        tx.execute(
            "UPDATE spend_sessions_v3 SET state=?,updated_at=? WHERE session_id=?",
            params![next.as_str(), i64::try_from(now)?, id],
        )?;
        release(&tx, id, now)?;
        event(&tx, id, Some(s.state), next, evidence, now)?;
        tx.commit()?;
        Ok(())
    }

    pub fn status(&self, id: &str) -> Result<Option<SessionStatus>> {
        load_status(&self.conn, id)
    }
    #[allow(dead_code)]
    pub fn artifact(&self, id: &str) -> Result<Option<SignedArtifact>> {
        load_artifact(&self.conn, id)
    }
    pub fn attempts(&self, id: &str) -> Result<Vec<SubmissionAttempt>> {
        let mut stmt=self.conn.prepare("SELECT provider,outcome,detail,attempted_at FROM submission_attempts_v3 WHERE session_id=? ORDER BY id")?;
        let rows = stmt.query_map([id], |r| {
            Ok(SubmissionAttempt {
                provider: r.get(0)?,
                outcome: r.get(1)?,
                detail: r.get(2)?,
                attempted_at: u64::try_from(r.get::<_, i64>(3)?).map_err(to_sql_error(3))?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }
    pub fn history(&self) -> Result<Vec<SessionStatus>> {
        let mut stmt = self
            .conn
            .prepare("SELECT session_id FROM spend_sessions_v3 ORDER BY created_at DESC")?;
        let ids = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.into_iter()
            .map(|id| load_status(&self.conn, &id)?.context("journal row disappeared"))
            .collect()
    }

    /// Terminates a mock-only rehearsal and releases its note reservation.
    /// Real or mixed provider attempts can never use this path.
    pub fn close_mock(&mut self, id: &str, now: u64) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let status = load_status(&tx, id)?.context("unknown spending session")?;
        ensure!(
            matches!(status.state, State::Submitted | State::Uncertain),
            "mock session is not active"
        );
        let (attempts, real_attempts): (i64, i64) = tx.query_row(
            "SELECT COUNT(*), SUM(CASE WHEN provider LIKE 'mock://%' THEN 0 ELSE 1 END)
             FROM submission_attempts_v3 WHERE session_id=?",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        ensure!(
            attempts > 0 && real_attempts == 0,
            "session is not mock-only"
        );
        tx.execute(
            "UPDATE spend_sessions_v3 SET state='REJECTED',updated_at=? WHERE session_id=?",
            params![i64::try_from(now)?, id],
        )?;
        release(&tx, id, now)?;
        event(
            &tx,
            id,
            Some(status.state),
            State::Rejected,
            "mock-only rehearsal closed; no network submission occurred",
            now,
        )?;
        tx.commit()?;
        Ok(())
    }
    fn transition_exact(
        &mut self,
        s: &PreparedSession,
        expected: State,
        next: State,
        now: u64,
        evidence: &str,
    ) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let status = require_exact(&tx, s)?;
        ensure!(status.session.expires > now, "approval session expired");
        ensure!(status.state == expected, "approval replay or invalid state");
        set_state(&tx, &s.session_id, expected, next, now, evidence)?;
        tx.commit()?;
        Ok(())
    }
}

fn validate_session(s: &PreparedSession, now: u64) -> Result<()> {
    ensure!(valid_id(&s.session_id), "invalid session id");
    ensure!(s.network == "zcash-mainnet", "wrong network");
    ensure!(
        !s.destination.is_empty() && s.zatoshis > 0,
        "destination and amount required"
    );
    ensure!(
        s.fee_zatoshis > 0 && s.fee_zatoshis <= s.fee_ceiling,
        "fee ceiling violated"
    );
    ensure!(
        s.change_zatoshis > 0 && !s.change_destination.is_empty(),
        "change required for pilot"
    );
    ensure!(!s.selected_notes.is_empty(), "selected notes required");
    ensure!(valid_digest(&s.prepared_digest), "invalid prepared digest");
    ensure!(s.expires > now, "approval session expired");
    ensure!(s.expiry_height > 0, "transaction expiry height required");
    let input = s
        .selected_notes
        .iter()
        .try_fold(0u64, |sum, n| sum.checked_add(n.zatoshis))
        .context("input overflow")?;
    let output = s
        .zatoshis
        .checked_add(s.fee_zatoshis)
        .and_then(|v| v.checked_add(s.change_zatoshis))
        .context("output overflow")?;
    ensure!(input == output, "intent accounting mismatch");
    Ok(())
}
fn require_exact(c: &Connection, s: &PreparedSession) -> Result<SessionStatus> {
    let status = load_status(c, &s.session_id)?.context("unknown approval session")?;
    ensure!(status.session == *s, "approval terms mismatch");
    Ok(status)
}
fn set_state(
    tx: &Transaction<'_>,
    id: &str,
    expected: State,
    next: State,
    now: u64,
    evidence: &str,
) -> Result<()> {
    let changed = tx.execute(
        "UPDATE spend_sessions_v3 SET state=?,updated_at=? WHERE session_id=? AND state=?",
        params![next.as_str(), i64::try_from(now)?, id, expected.as_str()],
    )?;
    ensure!(changed == 1, "approval replay or concurrent state change");
    event(tx, id, Some(expected), next, evidence, now)
}
fn event(
    tx: &Transaction<'_>,
    id: &str,
    prior: Option<State>,
    next: State,
    evidence: &str,
    now: u64,
) -> Result<()> {
    ensure!(evidence.len() <= 4096, "event evidence too long");
    tx.execute("INSERT INTO session_events_v3(session_id,prior_state,next_state,evidence,created_at) VALUES(?,?,?,?,?)",
        params![id,prior.map(State::as_str),next.as_str(),evidence,i64::try_from(now)?])?;
    Ok(())
}
fn release(tx: &Transaction<'_>, id: &str, now: u64) -> Result<()> {
    tx.execute(
        "UPDATE note_reservations_v3 SET active=0,updated_at=? WHERE session_id=? AND active=1",
        params![i64::try_from(now)?, id],
    )?;
    Ok(())
}
fn load_status(c: &Connection, id: &str) -> Result<Option<SessionStatus>> {
    c.query_row("SELECT intent_json,state,txid,signed_digest,submitted_at,mined_height,confirmations,updated_at FROM spend_sessions_v3 WHERE session_id=?",[id],|r|{
        let intent:String=r.get(0)?;let state:String=r.get(1)?;Ok(SessionStatus{
            session:serde_json::from_str(&intent).map_err(|e|rusqlite::Error::FromSqlConversionFailure(0,rusqlite::types::Type::Text,Box::new(e)))?,
            state:State::parse(&state).map_err(|e|rusqlite::Error::FromSqlConversionFailure(1,rusqlite::types::Type::Text,e.into_boxed_dyn_error()))?,
            txid:r.get(2)?,signed_digest:r.get(3)?,submitted_at:r.get::<_,Option<i64>>(4)?.map(u64::try_from).transpose().map_err(to_sql_error(4))?,
            mined_height:r.get::<_,Option<i64>>(5)?.map(u32::try_from).transpose().map_err(to_sql_error(5))?,
            confirmations:u32::try_from(r.get::<_,i64>(6)?).map_err(to_sql_error(6))?,updated_at:u64::try_from(r.get::<_,i64>(7)?).map_err(to_sql_error(7))?,
        })}).optional().map_err(Into::into)
}
fn load_artifact(c: &Connection, id: &str) -> Result<Option<SignedArtifact>> {
    c.query_row("SELECT txid,signed_digest,artifact_nonce,artifact_ciphertext FROM spend_sessions_v3 WHERE session_id=? AND artifact_ciphertext IS NOT NULL",[id],|r|
        Ok(SignedArtifact{txid:r.get(0)?,signed_digest:r.get(1)?,nonce:r.get(2)?,ciphertext:r.get(3)?})).optional().map_err(Into::into)
}
fn to_sql_error(index: usize) -> impl FnOnce(std::num::TryFromIntError) -> rusqlite::Error {
    move |e| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Integer,
            Box::new(e),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn prepared(id: &str, expires: u64) -> PreparedSession {
        PreparedSession {
            session_id: id.into(),
            network: "zcash-mainnet".into(),
            destination: "u1dest".into(),
            zatoshis: 100_000,
            fee_zatoshis: 10_000,
            fee_ceiling: 20_000,
            change_zatoshis: 535_937,
            change_destination: "wallet-internal:ironwood:account".into(),
            selected_notes: vec![NoteReservation {
                txid: "8f".repeat(32),
                pool: "ironwood".into(),
                output_index: 0,
                zatoshis: 645_937,
            }],
            prepared_digest: "d".repeat(64),
            expires,
            expiry_height: 3_530_000,
        }
    }
    fn artifact() -> SignedArtifact {
        SignedArtifact {
            txid: "a".repeat(64),
            signed_digest: "b".repeat(64),
            nonce: vec![1; 12],
            ciphertext: vec![2; 32],
        }
    }
    fn store() -> (tempfile::TempDir, SessionStore) {
        let d = tempfile::tempdir().unwrap();
        let s = SessionStore::open(&d.path().join("j.sqlite")).unwrap();
        (d, s)
    }
    fn signed(s: &mut SessionStore, p: &PreparedSession) {
        s.prepare(p, 100).unwrap();
        s.record_sign(p, 101).unwrap();
        s.record_signed(p, &artifact(), 102).unwrap();
    }
    #[test]
    fn approvals_are_single_use_and_bind_txid() {
        let (_d, mut s) = store();
        let p = prepared("one", 1000);
        signed(&mut s, &p);
        assert!(s.record_sign(&p, 103).is_err());
        let mut a = artifact();
        a.txid = "c".repeat(64);
        assert!(
            s.record_broadcast(
                &BroadcastApproval {
                    session: p.clone(),
                    txid: a.txid,
                    signed_digest: a.signed_digest
                },
                103
            )
            .is_err()
        );
        let a = artifact();
        s.record_broadcast(
            &BroadcastApproval {
                session: p.clone(),
                txid: a.txid,
                signed_digest: a.signed_digest,
            },
            104,
        )
        .unwrap();
        assert!(
            s.record_broadcast(
                &BroadcastApproval {
                    session: p,
                    txid: "a".repeat(64),
                    signed_digest: "b".repeat(64)
                },
                105
            )
            .is_err()
        );
    }
    #[test]
    fn altered_terms_and_wrong_network_fail() {
        for n in 0..5 {
            let (_d, mut s) = store();
            let p = prepared("exact", 1000);
            s.prepare(&p, 100).unwrap();
            let mut w = p.clone();
            match n {
                0 => w.destination = "u1other".into(),
                1 => w.zatoshis += 1,
                2 => w.fee_ceiling = 9999,
                3 => w.network = "zcash-testnet".into(),
                _ => w.expires = 100,
            }
            assert!(s.record_sign(&w, 100).is_err());
        }
    }
    #[test]
    fn double_spend_reservation_is_atomic() {
        let (_d, mut s) = store();
        let p = prepared("first", 1000);
        s.prepare(&p, 100).unwrap();
        let mut q = p.clone();
        q.session_id = "second".into();
        assert!(s.prepare(&q, 101).is_err());
        s.reject_pre_submission("first", State::Rejected, 102, "rejected")
            .unwrap();
        s.prepare(&q, 103).unwrap();
    }
    #[test]
    fn timeout_restart_preserves_artifact_and_reservation() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("j.sqlite");
        let p = prepared("restart", 1000);
        let a = artifact();
        {
            let mut s = SessionStore::open(&path).unwrap();
            signed(&mut s, &p);
            s.record_broadcast(
                &BroadcastApproval {
                    session: p.clone(),
                    txid: a.txid.clone(),
                    signed_digest: a.signed_digest.clone(),
                },
                103,
            )
            .unwrap();
            assert_eq!(s.begin_submission("restart", 104).unwrap(), a);
            s.finish_submission("restart", State::Uncertain, 105, "timeout")
                .unwrap();
        }
        let mut s = SessionStore::open(&path).unwrap();
        assert_eq!(
            s.status("restart").unwrap().unwrap().state,
            State::Uncertain
        );
        assert_eq!(s.artifact("restart").unwrap().unwrap(), artifact());
        let mut q = p;
        q.session_id = "replacement".into();
        assert!(s.prepare(&q, 106).is_err());
    }
    #[test]
    fn confirmation_reorg_and_finality_are_distinct() {
        let (_d, mut s) = store();
        let p = prepared("confirm", 1000);
        let a = artifact();
        signed(&mut s, &p);
        s.record_broadcast(
            &BroadcastApproval {
                session: p,
                txid: a.txid,
                signed_digest: a.signed_digest,
            },
            103,
        )
        .unwrap();
        s.begin_submission("confirm", 104).unwrap();
        s.finish_submission("confirm", State::Submitted, 105, "accepted")
            .unwrap();
        assert_eq!(
            s.reconcile(
                "confirm",
                NetworkObservation::Mined {
                    height: 900,
                    tip: 902
                },
                5,
                106
            )
            .unwrap(),
            State::Confirmed
        );
        assert_eq!(
            s.reconcile(
                "confirm",
                NetworkObservation::Reorganized {
                    former_height: 900,
                    tip: 903
                },
                5,
                107
            )
            .unwrap(),
            State::Uncertain
        );
        assert_eq!(
            s.reconcile(
                "confirm",
                NetworkObservation::Mined {
                    height: 904,
                    tip: 908
                },
                5,
                108
            )
            .unwrap(),
            State::Finalized
        );
    }
    #[test]
    fn unknown_transaction_expires() {
        let (_d, mut s) = store();
        let mut p = prepared("expiry", 1000);
        p.expiry_height = 500;
        let a = artifact();
        signed(&mut s, &p);
        s.record_broadcast(
            &BroadcastApproval {
                session: p,
                txid: a.txid,
                signed_digest: a.signed_digest,
            },
            103,
        )
        .unwrap();
        s.begin_submission("expiry", 104).unwrap();
        s.finish_submission("expiry", State::Uncertain, 105, "timeout")
            .unwrap();
        assert_eq!(
            s.reconcile("expiry", NetworkObservation::Unknown { tip: 500 }, 5, 106)
                .unwrap(),
            State::Expired
        );
    }
    #[test]
    fn review_digests_bind_terms_and_txid() {
        let p = prepared("digest", 1000);
        let d = sign_review_digest(&p).unwrap();
        let mut q = p.clone();
        q.expiry_height += 1;
        assert_ne!(d, sign_review_digest(&q).unwrap());
        let a = BroadcastApproval {
            session: p.clone(),
            txid: "a".repeat(64),
            signed_digest: "b".repeat(64),
        };
        let b = BroadcastApproval {
            session: p,
            txid: "c".repeat(64),
            signed_digest: "b".repeat(64),
        };
        assert_ne!(
            broadcast_review_digest(&a).unwrap(),
            broadcast_review_digest(&b).unwrap()
        );
    }

    #[test]
    fn mock_cleanup_releases_reservation() {
        let (_d, mut s) = store();
        let p = prepared("mock-close", 1000);
        let a = artifact();
        signed(&mut s, &p);
        s.record_broadcast(
            &BroadcastApproval {
                session: p.clone(),
                txid: a.txid,
                signed_digest: a.signed_digest,
            },
            103,
        )
        .unwrap();
        s.begin_submission("mock-close", 104).unwrap();
        s.record_attempt(
            "mock-close",
            &SubmissionAttempt {
                provider: "mock://fixture".into(),
                outcome: "MOCK_ACCEPTED".into(),
                detail: "fixture".into(),
                attempted_at: 105,
            },
        )
        .unwrap();
        s.finish_submission("mock-close", State::Submitted, 106, "mock")
            .unwrap();
        s.close_mock("mock-close", 107).unwrap();
        let mut replacement = p;
        replacement.session_id = "replacement-after-mock".into();
        s.prepare(&replacement, 108).unwrap();
    }
}
