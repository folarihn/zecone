use anyhow::{Context, Result, ensure};
use clap::{Args, ValueEnum};
use secrecy::ExposeSecret;
use serde::Deserialize;
use serde_json::json;
use std::path::{Path, PathBuf};

use crate::{
    CommonWallet, DEPOSIT_HEIGHT, DEPOSIT_INDEX, DEPOSIT_POOL, DEPOSIT_TXID, DEPOSIT_ZATOSHIS,
    broadcast, construct_with_prover_stack, exact_approval, initialize_and_sync, journal,
    lock_wallet, now, runtime, unlock, verify_prepared_funding, wallet,
};

#[derive(Args)]
pub struct PrepareArgs {
    #[command(flatten)]
    pub common: CommonWallet,
    #[arg(long)]
    pub recipient: String,
    #[arg(long)]
    pub zatoshis: u64,
    #[arg(long, default_value_t = 20_000)]
    pub max_fee: u64,
    #[arg(long)]
    pub journal: PathBuf,
    #[arg(long, default_value_t = 1800)]
    pub approval_validity_seconds: u64,
    /// Checkout inclusion height: the transaction expires at or below it.
    #[arg(long)]
    pub max_expiry_height: Option<u32>,
    /// Checkout payment deadline (unix seconds): SIGN and BROADCAST are refused after it.
    #[arg(long)]
    pub approval_deadline: Option<u64>,
}

#[derive(Args)]
pub struct SessionArgs {
    #[command(flatten)]
    pub common: CommonWallet,
    #[arg(long)]
    pub journal: PathBuf,
    #[arg(long)]
    pub session: String,
}

#[derive(Clone, Copy, Debug, ValueEnum, PartialEq, Eq)]
pub enum BroadcastMode {
    Disabled,
    Mock,
    Live,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum MockOutcome {
    Accepted,
    Rejected,
    Uncertain,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum SubmitProvider {
    Primary,
    Peer,
}

#[derive(Args)]
pub struct BroadcastArgs {
    #[command(flatten)]
    pub session: SessionArgs,
    #[arg(long, value_enum, default_value_t = BroadcastMode::Disabled)]
    pub mode: BroadcastMode,
    #[arg(long, value_enum, default_value_t = MockOutcome::Accepted)]
    pub mock_outcome: MockOutcome,
    /// Required in addition to an enabled control file for any real RPC send.
    #[arg(long, default_value_t = false)]
    pub enable_live_broadcast: bool,
    #[arg(long)]
    pub broadcast_control: Option<PathBuf>,
    /// Selects the sole provider used for this submission invocation. The
    /// second provider remains mandatory for preflight and reconciliation.
    #[arg(long, value_enum, default_value_t = SubmitProvider::Primary)]
    pub submit_provider: SubmitProvider,
}

#[derive(Args)]
pub struct ReconcileArgs {
    #[command(flatten)]
    pub session: SessionArgs,
    #[arg(long, default_value_t = 10)]
    pub confirmations: u32,
}

#[derive(Args)]
pub struct HistoryArgs {
    #[arg(long)]
    pub journal: PathBuf,
    #[arg(long)]
    pub session: Option<String>,
}

#[derive(Args)]
pub struct MockCloseArgs {
    #[arg(long)]
    pub journal: PathBuf,
    #[arg(long)]
    pub session: String,
}

#[derive(Args)]
pub struct ExpireArgs {
    #[arg(long)]
    pub journal: PathBuf,
    #[arg(long)]
    pub session: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BroadcastControl {
    network: String,
    live_broadcast_enabled: bool,
    emergency_paused: bool,
}

fn pending_snapshot(wallet_path: &Path, session_id: &str) -> PathBuf {
    wallet_path.join("pending-spends").join(session_id)
}

/// Approval session expiry: the validity window, never past a checkout payment
/// deadline. The existing SIGN and BROADCAST expiry checks then refuse execution
/// once the deadline has passed.
fn session_expiry(created: u64, validity_seconds: u64, deadline: Option<u64>) -> Result<u64> {
    let window = created
        .checked_add(validity_seconds)
        .context("expiry overflow")?;
    let expires = deadline.map_or(window, |d| d.min(window));
    ensure!(
        expires > created,
        "checkout payment deadline has already passed; request a new checkout"
    );
    Ok(expires)
}

fn reviewed(
    prepared: &wallet::PreparedTransaction,
    digest: String,
    session_id: String,
    expires: u64,
) -> journal::PreparedSession {
    journal::PreparedSession {
        session_id,
        network: "zcash-mainnet".into(),
        destination: prepared.recipient.clone(),
        zatoshis: prepared.zatoshis,
        fee_zatoshis: prepared.fee_zatoshis,
        fee_ceiling: prepared.max_fee_zatoshis,
        change_zatoshis: prepared.change_zatoshis,
        change_destination: prepared.change_destination.clone(),
        selected_notes: prepared
            .inputs
            .iter()
            .map(|n| journal::NoteReservation {
                txid: n.txid.clone(),
                pool: n.pool.clone(),
                output_index: n.output_index,
                zatoshis: n.zatoshis,
            })
            .collect(),
        prepared_digest: digest,
        expires,
        expiry_height: prepared.expiry_height,
    }
}

pub fn prepare(args: PrepareArgs) -> Result<()> {
    ensure!(
        (60..=21600).contains(&args.approval_validity_seconds),
        "approval validity must be 60..21600 seconds"
    );
    let _lock = lock_wallet(&args.common.wallet)?;
    let seed = unlock(&args.common.keystore)?;
    let rt = runtime()?;
    let (identity, sync, deposit) = initialize_and_sync(&rt, &args.common, &seed)?;
    let (prepared, digest) = wallet::propose(
        &args.common.wallet,
        &args.recipient,
        args.zatoshis,
        args.max_fee,
        &args.common.expected_account,
        args.max_expiry_height,
    )?;
    let mut store = journal::SessionStore::open(&args.journal)?;
    let funding = verify_prepared_funding(&args.common.wallet, &store, &prepared.inputs)?;
    let created = now()?;
    let session_id = uuid::Uuid::new_v4().simple().to_string();
    let session = reviewed(
        &prepared,
        digest.clone(),
        session_id.clone(),
        session_expiry(
            created,
            args.approval_validity_seconds,
            args.approval_deadline,
        )?,
    );
    let snapshot = pending_snapshot(&args.common.wallet, &session_id);
    if let Some(parent) = snapshot.parent() {
        std::fs::create_dir_all(parent)?;
    }
    wallet::snapshot_wallet(&args.common.wallet, &snapshot)?;
    if let Err(error) = store.prepare(&session, created) {
        let _ = std::fs::remove_dir_all(&snapshot);
        return Err(error);
    }
    println!(
        "{}",
        json!({"stage":"SIGN_REVIEW","identity":identity,"sync":sync,"deposit":deposit,"fundingLineage":funding,
        "prepared":prepared,"preparedDigest":digest,"sessionId":session_id,"sessionExpires":session.expires,
        "signReviewDigest":journal::sign_review_digest(&session)?,"signed":false,"broadcast":false})
    );
    Ok(())
}

pub fn sign(args: SessionArgs) -> Result<()> {
    let _lock = lock_wallet(&args.common.wallet)?;
    let seed = unlock(&args.common.keystore)?;
    let rt = runtime()?;
    let mut store = journal::SessionStore::open(&args.journal)?;
    let status = store
        .status(&args.session)?
        .context("unknown spending session")?;
    ensure!(
        matches!(
            status.state,
            journal::State::Prepared | journal::State::SignApproved
        ),
        "session is not awaiting signing"
    );
    if status.state == journal::State::Prepared {
        let digest = journal::sign_review_digest(&status.session)?;
        exact_approval("SIGN", &args.session, &digest)?;
        store.record_sign(&status.session, now()?)?;
    }
    let (_identity, sync, _deposit) = initialize_and_sync(&rt, &args.common, &seed)?;
    let selected = status
        .session
        .selected_notes
        .iter()
        .map(|note| wallet::PreparedInput {
            txid: note.txid.clone(),
            pool: note.pool.clone(),
            output_index: note.output_index,
            zatoshis: note.zatoshis,
        })
        .collect::<Vec<_>>();
    verify_prepared_funding(&args.common.wallet, &store, &selected)?;
    let tip = sync["tip"].as_u64().context("sync tip missing")? as u32;
    ensure!(
        tip < status.session.expiry_height,
        "prepared transaction expired before signing"
    );
    ensure!(
        now()? < status.session.expires,
        "approval session expired before signing"
    );
    let snapshot = pending_snapshot(&args.common.wallet, &args.session);
    ensure!(snapshot.exists(), "reviewed wallet snapshot missing");
    let (prepared, digest) = wallet::propose(
        &snapshot,
        &status.session.destination,
        status.session.zatoshis,
        status.session.fee_ceiling,
        &args.common.expected_account,
        Some(status.session.expiry_height),
    )?;
    ensure!(
        digest == status.session.prepared_digest,
        "reviewed snapshot digest mismatch"
    );
    let parent = args
        .common
        .wallet
        .parent()
        .context("wallet has no parent")?;
    let temp = tempfile::Builder::new()
        .prefix("zecone-zcash-sign-")
        .tempdir_in(parent)?;
    let signing = temp.path().join("wallet");
    wallet::snapshot_wallet(&snapshot, &signing)?;
    let signed = construct_with_prover_stack(&signing, &seed, &prepared, &digest)?;
    ensure!(
        now()? < status.session.expires,
        "approval session expired during signing"
    );
    broadcast::validate_signed(
        &signed.raw,
        &signed.txid,
        &signed.signed_digest,
        signed.expiry_height,
        tip,
    )?;
    let artifact = broadcast::seal(
        &signed.raw,
        seed.expose_secret(),
        &args.session,
        &signed.txid,
        &signed.signed_digest,
    )?;
    store.record_signed(&status.session, &artifact, now()?)?;
    let approval = journal::BroadcastApproval {
        session: status.session.clone(),
        txid: signed.txid.clone(),
        signed_digest: signed.signed_digest.clone(),
    };
    println!(
        "{}",
        json!({"stage":"BROADCAST_REVIEW","sessionId":args.session,"transaction":{"network":"zcash-mainnet","txid":signed.txid,"signedDigest":signed.signed_digest,"recipient":status.session.destination,"zatoshis":status.session.zatoshis.to_string(),"feeZatoshis":status.session.fee_zatoshis.to_string(),"changeZatoshis":status.session.change_zatoshis.to_string(),"changeDestination":status.session.change_destination,"expiryHeight":signed.expiry_height,"serializedBytes":signed.serialized_bytes},"broadcastReviewDigest":journal::broadcast_review_digest(&approval)?,"automaticApproval":false})
    );
    Ok(())
}

fn policy(args: &BroadcastArgs) -> Result<broadcast::BroadcastPolicy> {
    let mode = match args.mode {
        BroadcastMode::Disabled => broadcast::Mode::Disabled,
        BroadcastMode::Mock => broadcast::Mode::Mock,
        BroadcastMode::Live => broadcast::Mode::Live,
    };
    if mode != broadcast::Mode::Live {
        return Ok(broadcast::BroadcastPolicy {
            mode,
            emergency_paused: false,
            live_enabled: false,
        });
    }
    let path = args
        .broadcast_control
        .as_ref()
        .context("live broadcast control file required")?;
    let control: BroadcastControl = serde_json::from_slice(&std::fs::read(path)?)?;
    ensure!(
        control.network == "zcash-mainnet",
        "broadcast control is for the wrong network"
    );
    Ok(broadcast::BroadcastPolicy {
        mode,
        emergency_paused: control.emergency_paused,
        live_enabled: args.enable_live_broadcast && control.live_broadcast_enabled,
    })
}

pub fn broadcast(args: BroadcastArgs) -> Result<()> {
    let policy = policy(&args)?;
    policy.authorize()?;
    let common = &args.session.common;
    let _lock = lock_wallet(&common.wallet)?;
    let seed = unlock(&common.keystore)?;
    let rt = runtime()?;
    let mut store = journal::SessionStore::open(&args.session.journal)?;
    let status = store
        .status(&args.session.session)?
        .context("unknown spending session")?;
    ensure!(
        status.state == journal::State::Signed,
        "session is not awaiting BROADCAST approval"
    );
    let txid = status
        .txid
        .clone()
        .context("signed transaction id missing")?;
    let signed_digest = status
        .signed_digest
        .clone()
        .context("signed digest missing")?;
    let approval = journal::BroadcastApproval {
        session: status.session.clone(),
        txid: txid.clone(),
        signed_digest: signed_digest.clone(),
    };
    let review = journal::broadcast_review_digest(&approval)?;
    exact_approval("BROADCAST", &args.session.session, &review)?;
    let (_identity, sync, _deposit) = initialize_and_sync(&rt, common, &seed)?;
    let selected = status
        .session
        .selected_notes
        .iter()
        .map(|note| wallet::PreparedInput {
            txid: note.txid.clone(),
            pool: note.pool.clone(),
            output_index: note.output_index,
            zatoshis: note.zatoshis,
        })
        .collect::<Vec<_>>();
    verify_prepared_funding(&common.wallet, &store, &selected)?;
    let tip = sync["tip"].as_u64().context("sync tip missing")? as u32;
    ensure!(
        tip < status.session.expiry_height,
        "signed transaction expired before broadcast"
    );
    ensure!(
        now()? < status.session.expires,
        "approval session expired before broadcast"
    );
    store.record_broadcast(&approval, now()?)?;
    let artifact = store.begin_submission(&args.session.session, now()?)?;
    let raw = broadcast::open(&artifact, seed.expose_secret(), &args.session.session)?;
    let parsed = broadcast::validate_signed(
        &raw,
        &txid,
        &signed_digest,
        status.session.expiry_height,
        tip,
    )?;
    match args.mode {
        BroadcastMode::Mock => {
            let (outcome, state) = match args.mock_outcome {
                MockOutcome::Accepted => ("MOCK_ACCEPTED", journal::State::Submitted),
                MockOutcome::Rejected => ("MOCK_REJECTED", journal::State::Rejected),
                MockOutcome::Uncertain => ("MOCK_TIMEOUT", journal::State::Uncertain),
            };
            store.record_attempt(
                &args.session.session,
                &journal::SubmissionAttempt {
                    provider: "mock://deterministic".into(),
                    outcome: outcome.into(),
                    detail: "deterministic mock; no network submission".into(),
                    attempted_at: now()?,
                },
            )?;
            store.finish_submission(
                &args.session.session,
                state,
                now()?,
                "mock broadcaster outcome",
            )?;
        }
        BroadcastMode::Live => {
            let endpoint = match args.submit_provider {
                SubmitProvider::Primary => &common.server,
                SubmitProvider::Peer => &common.peer,
            };
            let mut provider = broadcast::LightwalletdProvider::new(endpoint.clone());
            let outcome = rt.block_on(broadcast::Provider::submit(&mut provider, &raw));
            let (label, detail, next) = match outcome {
                broadcast::SubmitOutcome::Accepted { detail } => {
                    ("ACCEPTED", detail, journal::State::Submitted)
                }
                broadcast::SubmitOutcome::Rejected { detail } => {
                    ("REJECTED", detail, journal::State::Rejected)
                }
                broadcast::SubmitOutcome::Uncertain { detail } => {
                    ("UNCERTAIN", detail, journal::State::Uncertain)
                }
            };
            store.record_attempt(
                &args.session.session,
                &journal::SubmissionAttempt {
                    provider: endpoint.clone(),
                    outcome: label.into(),
                    detail,
                    attempted_at: now()?,
                },
            )?;
            store.finish_submission(
                &args.session.session,
                next,
                now()?,
                "single operator-selected provider submission outcome recorded; no automatic retry",
            )?;
        }
        BroadcastMode::Disabled => unreachable!(),
    }
    println!(
        "{}",
        json!({"stage":"SUBMISSION_RECORDED","sessionId":args.session.session,"txid":parsed.to_string(),"state":store.status(&args.session.session)?.map(|s|s.state),"attempts":store.attempts(&args.session.session)?,"providerAcceptanceIsConfirmation":false,"realBroadcast":args.mode==BroadcastMode::Live})
    );
    Ok(())
}

pub fn reconcile(args: ReconcileArgs) -> Result<()> {
    ensure!(
        args.confirmations > 0,
        "confirmation threshold must be positive"
    );
    let common = &args.session.common;
    let _lock = lock_wallet(&common.wallet)?;
    let seed = unlock(&common.keystore)?;
    let rt = runtime()?;
    let mut store = journal::SessionStore::open(&args.session.journal)?;
    let before = store
        .status(&args.session.session)?
        .context("unknown spending session")?;
    let txid = before
        .txid
        .clone()
        .context("signed transaction id missing")?;
    let sync = rt.block_on(wallet::sync(&common.wallet, &common.server, &common.peer))?;
    let observed = rt.block_on(wallet::observe_transaction(
        &common.server,
        &common.peer,
        &txid,
    ))?;
    let observation = match observed.status.as_str() {
        "UNKNOWN" => journal::NetworkObservation::Unknown {
            tip: observed.common_tip,
        },
        "MEMPOOL" => journal::NetworkObservation::Mempool {
            tip: observed.common_tip,
        },
        "MINED" => journal::NetworkObservation::Mined {
            height: observed.mined_height.context("mined height missing")?,
            tip: observed.common_tip,
        },
        "REORGANIZED" => journal::NetworkObservation::Reorganized {
            former_height: before.mined_height.unwrap_or_default(),
            tip: observed.common_tip,
        },
        _ => anyhow::bail!("providers disagree on transaction status"),
    };
    let next = store.reconcile(
        &args.session.session,
        observation,
        args.confirmations,
        now()?,
    )?;
    let note = wallet::expected_deposit_status(
        &common.wallet,
        DEPOSIT_TXID,
        DEPOSIT_POOL,
        DEPOSIT_INDEX,
        DEPOSIT_ZATOSHIS,
        DEPOSIT_HEIGHT,
    )?;
    if matches!(next, journal::State::Confirmed | journal::State::Finalized) {
        ensure!(
            note["spent"] == true,
            "mined transaction is not reflected in wallet nullifier state"
        );
    }
    println!(
        "{}",
        json!({"sessionId":args.session.session,"state":next,"observation":observed,"sync":sync,"sourceNote":note,"walletSummary":wallet::summary(&common.wallet)?,"balanceFromConfirmedWalletState":true})
    );
    drop(seed);
    Ok(())
}

pub fn history(args: HistoryArgs) -> Result<()> {
    let store = journal::SessionStore::open(&args.journal)?;
    if let Some(id) = args.session {
        println!(
            "{}",
            json!({"session":store.status(&id)?,"attempts":store.attempts(&id)?})
        );
    } else {
        println!("{}", serde_json::to_string(&store.history()?)?);
    }
    Ok(())
}

pub fn close_mock(args: MockCloseArgs) -> Result<()> {
    let mut store = journal::SessionStore::open(&args.journal)?;
    store.close_mock(&args.session, now()?)?;
    println!(
        "{}",
        json!({"sessionId":args.session,"state":store.status(&args.session)?.map(|s|s.state),"mockOnly":true,"networkSubmission":false,"reservationReleased":true})
    );
    Ok(())
}

/// Abandon a stale pre-submission session (expired approval window) and release
/// its source-note reservation. Never touches Submitted/Uncertain sessions.
pub fn expire(args: ExpireArgs) -> Result<()> {
    let mut store = journal::SessionStore::open(&args.journal)?;
    store.reject_pre_submission(
        &args.session,
        journal::State::Expired,
        now()?,
        "approval window elapsed before signing; reservation released",
    )?;
    println!(
        "{}",
        json!({"sessionId":args.session,"state":store.status(&args.session)?.map(|s|s.state),"reservationReleased":true,"networkSubmission":false})
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::session_expiry;

    #[test]
    fn checkout_deadline_caps_the_approval_session() {
        // No checkout deadline: the ordinary validity window.
        assert_eq!(session_expiry(1_000, 1_800, None).unwrap(), 2_800);
        // A checkout deadline earlier than the window wins, so SIGN or
        // BROADCAST after the payment deadline is refused as expired.
        assert_eq!(session_expiry(1_000, 1_800, Some(1_240)).unwrap(), 1_240);
        // A later deadline never extends the window.
        assert_eq!(session_expiry(1_000, 1_800, Some(9_000)).unwrap(), 2_800);
        // A deadline that already passed refuses to prepare at all.
        assert!(session_expiry(1_000, 1_800, Some(1_000)).is_err());
        assert!(session_expiry(1_000, 1_800, Some(900)).is_err());
    }
}
