//! Durable, fail-closed transaction journal for the mainnet spending pilot.
//!
//! A session is prepared before any approval is accepted. SIGN and BROADCAST
//! approvals must repeat every reviewed field, are single-use, and are advanced
//! transactionally. The only broadcaster in this crate is a consuming mock;
//! no real network submission function exists.
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

const PREPARED: &str = "PREPARED";
const SIGN_APPROVED: &str = "SIGN_APPROVED";
const SIGNED: &str = "SIGNED";
const BROADCAST_APPROVED: &str = "BROADCAST_APPROVED";
#[cfg(test)]
const BROADCAST_CONSUMED: &str = "BROADCAST_CONSUMED";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreparedSession {
    pub session_id: String,
    pub destination: String,
    pub zatoshis: u64,
    pub fee_ceiling: u64,
    pub change_destination: String,
    pub prepared_digest: String,
    pub expires: u64,
}

pub type SignApproval = PreparedSession;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BroadcastApproval {
    pub session: PreparedSession,
    pub signed_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionStatus {
    pub state: String,
    pub signed_digest: Option<String>,
    pub expires: u64,
}

pub struct SessionStore {
    conn: Connection,
}

pub fn sign_review_digest(session: &PreparedSession) -> Result<String> {
    let mut hasher = Sha256::new();
    hasher.update(b"zecone-zcash-mainnet-sign-review-v1\0");
    hasher.update(serde_json::to_vec(session)?);
    Ok(hex::encode(hasher.finalize()))
}

pub fn broadcast_review_digest(approval: &BroadcastApproval) -> Result<String> {
    let mut hasher = Sha256::new();
    hasher.update(b"zecone-zcash-mainnet-broadcast-review-v1\0");
    hasher.update(serde_json::to_vec(&approval.session)?);
    hasher.update(b"\0");
    hasher.update(approval.signed_digest.as_bytes());
    Ok(hex::encode(hasher.finalize()))
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
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
             CREATE TABLE IF NOT EXISTS spend_sessions_v2(
               session_id TEXT PRIMARY KEY,
               destination TEXT NOT NULL,
               zatoshis TEXT NOT NULL,
               fee_ceiling TEXT NOT NULL,
               change_destination TEXT NOT NULL,
               prepared_digest TEXT NOT NULL,
               signed_digest TEXT,
               expires INTEGER NOT NULL,
               state TEXT NOT NULL CHECK(state IN(
                 'PREPARED','SIGN_APPROVED','SIGNED',
                 'BROADCAST_APPROVED','BROADCAST_CONSUMED')),
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL
             );",
        )?;
        Ok(Self { conn })
    }

    pub fn prepare(&mut self, s: &PreparedSession, now: u64) -> Result<()> {
        validate_session(s, now)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let prior = load(&tx, &s.session_id)?;
        if let Some((bound, state, _, _)) = prior {
            ensure!(bound == *s, "session id binding conflict");
            ensure!(state == PREPARED, "session already advanced");
        } else {
            tx.execute(
                "INSERT INTO spend_sessions_v2(
                   session_id,destination,zatoshis,fee_ceiling,
                   change_destination,prepared_digest,expires,state,created_at,updated_at
                 ) VALUES(?,?,?,?,?,?,?,'PREPARED',?,?)",
                params![
                    s.session_id,
                    s.destination,
                    s.zatoshis.to_string(),
                    s.fee_ceiling.to_string(),
                    s.change_destination,
                    s.prepared_digest,
                    i64::try_from(s.expires)?,
                    i64::try_from(now)?,
                    i64::try_from(now)?,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn record_sign(&mut self, a: &SignApproval, now: u64) -> Result<()> {
        validate_session(a, now)?;
        self.transition(a, PREPARED, SIGN_APPROVED, now, None)
    }

    pub fn record_signed(
        &mut self,
        session: &PreparedSession,
        signed_digest: &str,
        now: u64,
    ) -> Result<()> {
        validate_session(session, now)?;
        ensure!(
            valid_digest(signed_digest),
            "invalid signed transaction digest"
        );
        self.transition(session, SIGN_APPROVED, SIGNED, now, Some(signed_digest))
    }

    pub fn record_broadcast(&mut self, a: &BroadcastApproval, now: u64) -> Result<()> {
        validate_session(&a.session, now)?;
        ensure!(
            valid_digest(&a.signed_digest),
            "invalid signed transaction digest"
        );
        self.transition(
            &a.session,
            SIGNED,
            BROADCAST_APPROVED,
            now,
            Some(&a.signed_digest),
        )
    }

    fn transition(
        &mut self,
        session: &PreparedSession,
        expected: &str,
        next: &str,
        now: u64,
        signed_digest: Option<&str>,
    ) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (bound, state, stored_signed, expires) =
            load(&tx, &session.session_id)?.context("unknown approval session")?;
        ensure!(bound == *session, "approval terms mismatch");
        ensure!(expires > now, "approval session expired");
        ensure!(state == expected, "approval replay or invalid state");
        if let (Some(digest), Some(stored)) = (signed_digest, stored_signed) {
            ensure!(stored == digest, "signed transaction digest mismatch");
        }
        let changed = tx.execute(
            "UPDATE spend_sessions_v2
             SET state=?, signed_digest=COALESCE(?,signed_digest), updated_at=?
             WHERE session_id=? AND state=? AND expires>?",
            params![
                next,
                signed_digest,
                i64::try_from(now)?,
                session.session_id,
                expected,
                i64::try_from(now)?,
            ],
        )?;
        ensure!(changed == 1, "approval replay or concurrent state change");
        tx.commit()?;
        Ok(())
    }

    pub fn status(&self, session_id: &str) -> Result<Option<SessionStatus>> {
        self.conn
            .query_row(
                "SELECT state,signed_digest,expires FROM spend_sessions_v2 WHERE session_id=?",
                [session_id],
                |r| {
                    let expires: i64 = r.get(2)?;
                    Ok(SessionStatus {
                        state: r.get(0)?,
                        signed_digest: r.get(1)?,
                        expires: u64::try_from(expires).map_err(|e| {
                            rusqlite::Error::FromSqlConversionFailure(
                                2,
                                rusqlite::types::Type::Integer,
                                Box::new(e),
                            )
                        })?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    /// Consumes a BROADCAST approval while returning a mock identifier. This
    /// proves the gate and replay protection without any network submission.
    pub fn mock_broadcast(&mut self, session_id: &str, now: u64) -> Result<String> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = tx.execute(
            "UPDATE spend_sessions_v2 SET state='BROADCAST_CONSUMED',updated_at=?
             WHERE session_id=? AND state='BROADCAST_APPROVED' AND expires>?",
            params![i64::try_from(now)?, session_id, i64::try_from(now)?],
        )?;
        ensure!(
            changed == 1,
            "BROADCAST approval required, expired, or replayed"
        );
        tx.commit()?;
        Ok(format!("mock-broadcast-{session_id}"))
    }
}

type Stored = (PreparedSession, String, Option<String>, u64);

fn load(conn: &Connection, session_id: &str) -> Result<Option<Stored>> {
    conn.query_row(
        "SELECT destination,zatoshis,fee_ceiling,change_destination,
                prepared_digest,expires,state,signed_digest
         FROM spend_sessions_v2 WHERE session_id=?",
        [session_id],
        |r| {
            let zatoshis: String = r.get(1)?;
            let fee: String = r.get(2)?;
            let expires: i64 = r.get(5)?;
            Ok((
                PreparedSession {
                    session_id: session_id.to_owned(),
                    destination: r.get(0)?,
                    zatoshis: zatoshis.parse().map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            1,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?,
                    fee_ceiling: fee.parse().map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            2,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?,
                    change_destination: r.get(3)?,
                    prepared_digest: r.get(4)?,
                    expires: u64::try_from(expires).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            5,
                            rusqlite::types::Type::Integer,
                            Box::new(e),
                        )
                    })?,
                },
                r.get(6)?,
                r.get(7)?,
                u64::try_from(expires).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        5,
                        rusqlite::types::Type::Integer,
                        Box::new(e),
                    )
                })?,
            ))
        },
    )
    .optional()
    .map_err(Into::into)
}

fn validate_session(s: &PreparedSession, now: u64) -> Result<()> {
    ensure!(valid_id(&s.session_id), "invalid session id");
    ensure!(!s.destination.is_empty(), "destination required");
    ensure!(s.zatoshis > 0, "amount must be positive");
    ensure!(s.fee_ceiling > 0, "fee ceiling must be positive");
    ensure!(
        !s.change_destination.is_empty(),
        "change destination required"
    );
    ensure!(valid_digest(&s.prepared_digest), "invalid prepared digest");
    ensure!(s.expires > now, "approval session expired");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prepared(session: &str, expires: u64) -> PreparedSession {
        PreparedSession {
            session_id: session.into(),
            destination: "u1dest".into(),
            zatoshis: 1000,
            fee_ceiling: 5000,
            change_destination: "wallet-internal:ironwood:account".into(),
            prepared_digest: "d".repeat(64),
            expires,
        }
    }

    fn store() -> (tempfile::TempDir, SessionStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(&dir.path().join("s.sqlite")).unwrap();
        (dir, store)
    }

    #[test]
    fn exact_sign_approval_is_single_use() {
        let (_dir, mut s) = store();
        let p = prepared("a", 200);
        s.prepare(&p, 100).unwrap();
        s.record_sign(&p, 101).unwrap();
        assert!(s.record_sign(&p, 102).is_err());
    }

    #[test]
    fn mismatched_terms_fail_closed() {
        let (_dir, mut s) = store();
        let p = prepared("a", 200);
        s.prepare(&p, 100).unwrap();
        let mut wrong = p.clone();
        wrong.destination = "u1other".into();
        assert!(s.record_sign(&wrong, 101).is_err());
    }

    #[test]
    fn expired_approval_is_rejected() {
        let (_dir, mut s) = store();
        let p = prepared("a", 200);
        s.prepare(&p, 100).unwrap();
        assert!(s.record_sign(&p, 200).is_err());
    }

    #[test]
    fn broadcast_requires_signed_state_and_exact_digest() {
        let (_dir, mut s) = store();
        let p = prepared("a", 200);
        let digest = "a".repeat(64);
        s.prepare(&p, 100).unwrap();
        assert!(
            s.record_broadcast(
                &BroadcastApproval {
                    session: p.clone(),
                    signed_digest: digest.clone()
                },
                101
            )
            .is_err()
        );
        s.record_sign(&p, 101).unwrap();
        s.record_signed(&p, &digest, 102).unwrap();
        let mut wrong = digest.clone();
        wrong.replace_range(0..1, "b");
        assert!(
            s.record_broadcast(
                &BroadcastApproval {
                    session: p.clone(),
                    signed_digest: wrong
                },
                103
            )
            .is_err()
        );
        s.record_broadcast(
            &BroadcastApproval {
                session: p,
                signed_digest: digest,
            },
            104,
        )
        .unwrap();
    }

    #[test]
    fn mock_broadcast_is_consuming_and_replay_safe() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.sqlite");
        let p = prepared("a", 200);
        let digest = "a".repeat(64);
        {
            let mut s = SessionStore::open(&path).unwrap();
            s.prepare(&p, 100).unwrap();
            s.record_sign(&p, 101).unwrap();
            s.record_signed(&p, &digest, 102).unwrap();
            s.record_broadcast(
                &BroadcastApproval {
                    session: p,
                    signed_digest: digest,
                },
                103,
            )
            .unwrap();
        }
        let mut recovered = SessionStore::open(&path).unwrap();
        assert_eq!(
            recovered.mock_broadcast("a", 104).unwrap(),
            "mock-broadcast-a"
        );
        assert!(recovered.mock_broadcast("a", 105).is_err());
        assert_eq!(
            recovered.status("a").unwrap().unwrap().state,
            BROADCAST_CONSUMED
        );
    }

    #[test]
    fn corrupted_digest_is_rejected() {
        let (_dir, mut s) = store();
        let mut p = prepared("a", 200);
        p.prepared_digest = "not-a-digest".into();
        assert!(s.prepare(&p, 100).is_err());
    }

    #[test]
    fn interrupted_sign_approval_recovers_without_advancing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.sqlite");
        let p = prepared("recover", 300);
        {
            let mut first = SessionStore::open(&path).unwrap();
            first.prepare(&p, 100).unwrap();
            first.record_sign(&p, 101).unwrap();
        }
        let recovered = SessionStore::open(&path).unwrap();
        let state = recovered.status("recover").unwrap().unwrap();
        assert_eq!(state.state, SIGN_APPROVED);
        assert!(state.signed_digest.is_none());
    }

    #[test]
    fn expired_broadcast_cannot_be_consumed() {
        let (_dir, mut s) = store();
        let p = prepared("late", 110);
        let digest = "a".repeat(64);
        s.prepare(&p, 100).unwrap();
        s.record_sign(&p, 101).unwrap();
        s.record_signed(&p, &digest, 102).unwrap();
        assert!(
            s.record_broadcast(
                &BroadcastApproval {
                    session: p,
                    signed_digest: digest,
                },
                110,
            )
            .is_err()
        );
    }

    #[test]
    fn review_digests_bind_expiry_and_signed_transaction() {
        let p = prepared("a", 200);
        let first = sign_review_digest(&p).unwrap();
        let mut later = p.clone();
        later.expires = 201;
        assert_ne!(first, sign_review_digest(&later).unwrap());
        let a = BroadcastApproval {
            session: p.clone(),
            signed_digest: "a".repeat(64),
        };
        let b = BroadcastApproval {
            session: p,
            signed_digest: "b".repeat(64),
        };
        assert_ne!(
            broadcast_review_digest(&a).unwrap(),
            broadcast_review_digest(&b).unwrap()
        );
    }
}
