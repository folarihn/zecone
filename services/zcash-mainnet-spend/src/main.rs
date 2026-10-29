mod broadcast;
mod cache;
mod journal;
mod keystore;
mod phase3;
mod session;
mod wallet;

use anyhow::{Context, Result, ensure};
use clap::{Parser, Subcommand};
use secrecy::ExposeSecret;
use serde_json::{Value, json};
use std::{
    fs::OpenOptions,
    io::{BufRead, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const DEFAULT_PRIMARY: &str = "https://zec.rocks:443";
const DEFAULT_PEER: &str = "https://us.zec.stardust.rest:443";
const DEPOSIT_TXID: &str = "8f512d50e1ee36eb222537bdba8b8f762f39256e28259a422913392d86b5f86c";
const DEPOSIT_POOL: u32 = 4;
const DEPOSIT_INDEX: u32 = 0;
const DEPOSIT_ZATOSHIS: u64 = 645_937;
const DEPOSIT_HEIGHT: u32 = 3_529_711;

struct WalletLock(PathBuf);

impl Drop for WalletLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn lock_wallet(path: &Path) -> Result<WalletLock> {
    std::fs::create_dir_all(path)?;
    let lock = path.join("process.lock");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock)
        .context("wallet is locked; inspect the recorded process before removing a stale lock")?;
    file.write_all(std::process::id().to_string().as_bytes())?;
    file.sync_all()?;
    Ok(WalletLock(lock))
}

#[derive(Parser)]
#[command(about = "Guarded Zcash mainnet spending and reconciliation wallet")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Read-only two-provider mainnet consensus probe; no wallet or key access.
    Probe {
        #[arg(long, default_value = DEFAULT_PRIMARY)]
        server: String,
        #[arg(long, default_value = DEFAULT_PEER)]
        peer: String,
    },
    /// Unlock from a passphrase line on stdin and report public identity only.
    Identity {
        #[arg(long)]
        keystore: PathBuf,
    },
    /// Decode a mainnet unified address and test exact ownership against the wallet UFVK.
    InspectAddress {
        #[arg(long)]
        keystore: PathBuf,
        #[arg(long)]
        address: String,
        #[arg(long)]
        existing_address: String,
    },
    /// Unlock and inspect an already initialized wallet without synchronization.
    Status(CommonWallet),
    /// Initialize if needed, then synchronize and cross-check both providers.
    Sync(CommonWallet),
    /// Synchronize, reserve source notes, snapshot state, and create a SIGN review.
    Prepare(phase3::PrepareArgs),
    /// Consume the exact SIGN approval, prove, sign, and create a BROADCAST review.
    Sign(phase3::SessionArgs),
    /// Consume the exact BROADCAST approval and invoke the selected guarded broadcaster.
    Broadcast(phase3::BroadcastArgs),
    /// Reconcile a submitted or uncertain transaction against both providers and wallet state.
    Reconcile(phase3::ReconcileArgs),
    /// Show durable transaction history without unlocking the wallet.
    History(phase3::HistoryArgs),
    /// Export a sanitized, read-only browser view. No keystore is accepted.
    BrowserView {
        #[arg(long)]
        wallet: PathBuf,
        #[arg(long)]
        expected_account: String,
        #[arg(long)]
        expected_address: String,
    },
    /// Close a mock-only rehearsal and release its source-note reservation.
    MockClose(phase3::MockCloseArgs),
    /// Expire a stale pre-submission session and release its note reservation.
    Expire(phase3::ExpireArgs),
    /// Interactive two-approval dry run. It proves/signs only after exact SIGN,
    /// exercises a mock BROADCAST gate, and can never submit to mainnet.
    DryRun {
        #[command(flatten)]
        common: CommonWallet,
        #[arg(long)]
        recipient: String,
        #[arg(long)]
        zatoshis: u64,
        #[arg(long, default_value_t = 20_000)]
        max_fee: u64,
        #[arg(long)]
        journal: PathBuf,
        #[arg(long, default_value_t = 1800)]
        approval_validity_seconds: u64,
    },
}

#[derive(clap::Args)]
struct CommonWallet {
    #[arg(long)]
    wallet: PathBuf,
    #[arg(long)]
    keystore: PathBuf,
    #[arg(long)]
    expected_account: String,
    #[arg(long)]
    expected_address: String,
    #[arg(long, default_value_t = 3_528_700)]
    birthday: u32,
    #[arg(long, default_value = DEFAULT_PRIMARY)]
    server: String,
    #[arg(long, default_value = DEFAULT_PEER)]
    peer: String,
}

fn now() -> Result<u64> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs())
}

fn read_line(label: &str) -> Result<Vec<u8>> {
    eprint!("{label}");
    std::io::stderr().flush()?;
    let mut bytes = Vec::new();
    std::io::stdin().lock().read_until(b'\n', &mut bytes)?;
    while bytes.last().is_some_and(|b| *b == b'\n' || *b == b'\r') {
        bytes.pop();
    }
    ensure!(!bytes.is_empty(), "empty stdin value");
    ensure!(bytes.len() <= 4096, "stdin value too long");
    Ok(bytes)
}

#[cfg(windows)]
fn read_passphrase() -> Result<Vec<u8>> {
    use windows_sys::Win32::System::Console::{
        ENABLE_ECHO_INPUT, GetConsoleMode, GetStdHandle, STD_INPUT_HANDLE, SetConsoleMode,
    };

    struct RestoreEcho {
        handle: windows_sys::Win32::Foundation::HANDLE,
        mode: u32,
    }
    impl Drop for RestoreEcho {
        fn drop(&mut self) {
            // Best-effort restoration also runs on input or unlock errors.
            unsafe {
                SetConsoleMode(self.handle, self.mode);
            }
        }
    }

    let handle = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
    ensure!(!handle.is_null(), "secure console stdin is unavailable");
    let mut mode = 0u32;
    // A redirected pipe does not echo input and is used by the local protected
    // launcher. A real console must have echo disabled before reading.
    if unsafe { GetConsoleMode(handle, &mut mode) } == 0 {
        return read_line("Keystore passphrase: ");
    }
    ensure!(
        unsafe { SetConsoleMode(handle, mode & !ENABLE_ECHO_INPUT) } != 0,
        "could not disable passphrase echo"
    );
    let restore = RestoreEcho { handle, mode };
    let result = read_line("Keystore passphrase: ");
    drop(restore);
    eprintln!();
    result
}

#[cfg(not(windows))]
fn read_passphrase() -> Result<Vec<u8>> {
    anyhow::bail!("secure passphrase input is implemented only for the Windows pilot")
}

fn unlock(keystore_path: &PathBuf) -> Result<secrecy::SecretVec<u8>> {
    let mut pass = read_passphrase()?;
    let ks: Value = serde_json::from_slice(&std::fs::read(keystore_path)?)?;
    let result = keystore::unlock_seed(&ks, &pass, "mainnet:zcash:receiver");
    pass.fill(0);
    result
}

fn runtime() -> Result<tokio::runtime::Runtime> {
    Ok(tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?)
}

fn initialize_and_sync(
    rt: &tokio::runtime::Runtime,
    common: &CommonWallet,
    seed: &secrecy::SecretVec<u8>,
) -> Result<(Value, Value, Value)> {
    let identity = rt.block_on(wallet::open_wallet(
        &common.wallet,
        seed,
        common.birthday,
        &common.expected_account,
        &common.expected_address,
        &common.server,
        &common.peer,
    ))?;
    let sync = rt.block_on(wallet::sync(&common.wallet, &common.server, &common.peer))?;
    let deposit = wallet::expected_deposit_status(
        &common.wallet,
        DEPOSIT_TXID,
        DEPOSIT_POOL,
        DEPOSIT_INDEX,
        DEPOSIT_ZATOSHIS,
        DEPOSIT_HEIGHT,
    )?;
    Ok((identity, sync, deposit))
}

fn verify_prepared_funding(
    wallet_path: &Path,
    store: &journal::SessionStore,
    selected: &[wallet::PreparedInput],
) -> Result<Value> {
    let finalized = store
        .history()?
        .into_iter()
        .filter(|status| status.state == journal::State::Finalized)
        .map(|status| {
            Ok(wallet::FinalizedFundingSpend {
                txid: status.txid.context("finalized transaction id missing")?,
                mined_height: status
                    .mined_height
                    .context("finalized transaction height missing")?,
                selected_notes: status
                    .session
                    .selected_notes
                    .into_iter()
                    .map(|note| wallet::PreparedInput {
                        txid: note.txid,
                        pool: note.pool,
                        output_index: note.output_index,
                        zatoshis: note.zatoshis,
                    })
                    .collect(),
                change_zatoshis: status.session.change_zatoshis,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    wallet::verify_funding_lineage(
        wallet_path,
        &finalized,
        selected,
        DEPOSIT_TXID,
        DEPOSIT_POOL,
        u16::try_from(DEPOSIT_INDEX)?,
        DEPOSIT_ZATOSHIS,
        DEPOSIT_HEIGHT,
    )
}

fn exact_approval(prefix: &str, session_id: &str, digest: &str) -> Result<()> {
    let expected = format!("{prefix} {session_id} {digest}");
    println!(
        "{}",
        json!({
            "operatorAction": prefix,
            "exactApproval": expected,
            "automaticApproval": false,
        })
    );
    std::io::stdout().flush()?;
    let mut line = read_line(&format!("Enter exact {prefix} approval: "))?;
    let accepted = line == expected.as_bytes();
    line.fill(0);
    ensure!(accepted, "exact {prefix} approval required");
    Ok(())
}

fn construct_with_prover_stack(
    snapshot: &std::path::Path,
    seed: &secrecy::SecretVec<u8>,
    prepared: &wallet::PreparedTransaction,
    prepared_digest: &str,
) -> Result<wallet::ConstructedTransaction> {
    std::thread::scope(|scope| -> Result<wallet::ConstructedTransaction> {
        let worker = std::thread::Builder::new()
            .name("zecone-zcash-proof-worker".into())
            .stack_size(64 * 1024 * 1024)
            .spawn_scoped(scope, || {
                wallet::construct(snapshot, seed, prepared, prepared_digest)
            })?;
        worker
            .join()
            .map_err(|_| anyhow::anyhow!("shielded proof worker panicked"))?
    })
}

fn main() -> Result<()> {
    rustls::crypto::ring::default_provider()
        .install_default()
        .map_err(|_| anyhow::anyhow!("TLS provider initialization failed"))?;
    match Cli::parse().command {
        Command::Probe { server, peer } => {
            let agreement = runtime()?.block_on(wallet::provider_agreement(&server, &peer))?;
            println!(
                "{}",
                json!({
                    "network":"zcash-mainnet",
                    "providerAgreement":"PASS",
                    "commonHeight":agreement.common_height,
                    "blockHash":agreement.block_hash,
                    "primaryTip":agreement.primary_tip,
                    "peerTip":agreement.peer_tip,
                    "walletAccess":false,
                    "broadcast":false,
                })
            );
        }
        Command::Identity { keystore } => {
            let seed = unlock(&keystore)?;
            let id = keystore::identity(seed.expose_secret())?;
            println!(
                "{}",
                json!({
                    "network":"zcash-mainnet",
                    "account":id.account,
                    "shieldedAddress":id.address,
                    "allReceiversAddress":id.all_receivers_address,
                    "orchardAddress":id.orchard_address,
                    "unlocked":true,
                    "secretMaterialPrinted":false,
                })
            );
        }
        Command::InspectAddress {
            keystore,
            address,
            existing_address,
        } => {
            let seed = unlock(&keystore)?;
            let inspection =
                keystore::inspect_address(seed.expose_secret(), &address, &existing_address)?;
            ensure!(
                inspection.differs_from_existing_address,
                "destination equals existing receiving address"
            );
            ensure!(
                !inspection.belongs_to_existing_account,
                "destination belongs to the existing spending account"
            );
            ensure!(
                inspection.orchard || inspection.sapling,
                "shielded receiver required"
            );
            println!("{}", serde_json::to_string(&inspection)?);
        }
        Command::Status(common) => {
            let _lock = lock_wallet(&common.wallet)?;
            let seed = unlock(&common.keystore)?;
            let rt = runtime()?;
            let identity = rt.block_on(wallet::open_wallet(
                &common.wallet,
                &seed,
                common.birthday,
                &common.expected_account,
                &common.expected_address,
                &common.server,
                &common.peer,
            ))?;
            println!(
                "{}",
                json!({
                    "identity": identity,
                    "summary": wallet::summary(&common.wallet)?,
                    "notes": wallet::notes(&common.wallet)?,
                    "broadcast": false,
                })
            );
        }
        Command::Sync(common) => {
            let _lock = lock_wallet(&common.wallet)?;
            let seed = unlock(&common.keystore)?;
            let rt = runtime()?;
            let (identity, sync, deposit) = initialize_and_sync(&rt, &common, &seed)?;
            println!(
                "{}",
                json!({
                    "identity": identity,
                    "sync": sync,
                    "deposit": deposit,
                    "summary": wallet::summary(&common.wallet)?,
                    "notes": wallet::notes(&common.wallet)?,
                    "broadcast": false,
                })
            );
        }
        Command::Prepare(args) => phase3::prepare(args)?,
        Command::Sign(args) => phase3::sign(args)?,
        Command::Broadcast(args) => phase3::broadcast(args)?,
        Command::Reconcile(args) => phase3::reconcile(args)?,
        Command::History(args) => phase3::history(args)?,
        Command::BrowserView {
            wallet,
            expected_account,
            expected_address,
        } => println!(
            "{}",
            wallet::browser_view(&wallet, &expected_account, &expected_address)?
        ),
        Command::MockClose(args) => phase3::close_mock(args)?,
        Command::Expire(args) => phase3::expire(args)?,
        Command::DryRun {
            common,
            recipient,
            zatoshis,
            max_fee,
            journal,
            approval_validity_seconds,
        } => {
            let _lock = lock_wallet(&common.wallet)?;
            ensure!(
                (60..=21600).contains(&approval_validity_seconds),
                "approval validity must be 60..21600 seconds"
            );
            let seed = unlock(&common.keystore)?;
            let rt = runtime()?;
            let (identity, sync, deposit) = initialize_and_sync(&rt, &common, &seed)?;
            let (prepared, prepared_digest) = wallet::propose(
                &common.wallet,
                &recipient,
                zatoshis,
                max_fee,
                &common.expected_account,
                None,
            )?;
            let lineage_store = journal::SessionStore::open(&journal)?;
            let funding =
                verify_prepared_funding(&common.wallet, &lineage_store, &prepared.inputs)?;
            // Freeze the exact reviewed wallet state before waiting for SIGN.
            // Later chain growth must not silently rewrite target/anchor heights.
            let snapshot_parent = common.wallet.parent().context("wallet has no parent")?;
            let temp = tempfile::Builder::new()
                .prefix("zecone-zcash-dry-run-")
                .tempdir_in(snapshot_parent)?;
            let snapshot = temp.path().join("wallet");
            wallet::snapshot_wallet(&common.wallet, &snapshot)?;
            let created = now()?;
            let session_id = uuid::Uuid::new_v4().simple().to_string();
            let reviewed = session::PreparedSession {
                session_id: session_id.clone(),
                destination: recipient.clone(),
                zatoshis,
                fee_ceiling: max_fee,
                change_destination: prepared.change_destination.clone(),
                prepared_digest: prepared_digest.clone(),
                expires: created
                    .checked_add(approval_validity_seconds)
                    .context("expiry overflow")?,
            };
            let mut store = session::SessionStore::open(&journal)?;
            store.prepare(&reviewed, created)?;
            let sign_digest = session::sign_review_digest(&reviewed)?;
            println!(
                "{}",
                json!({
                    "stage":"SIGN_REVIEW",
                    "identity":identity,
                    "sync":sync,
                    "deposit":deposit,
                    "fundingLineage":funding,
                    "prepared":prepared,
                    "preparedDigest":prepared_digest,
                    "sessionId":session_id,
                    "sessionExpires":reviewed.expires,
                    "signReviewDigest":sign_digest,
                    "broadcastEnabled":false,
                })
            );
            exact_approval("SIGN", &session_id, &sign_digest)?;
            store.record_sign(&reviewed, now()?)?;

            // Revalidate providers and live spendability after SIGN. Chain
            // growth is allowed; construction remains bound to the reviewed
            // snapshot and its exact prepared digest.
            let sign_sync =
                rt.block_on(wallet::sync(&common.wallet, &common.server, &common.peer))?;
            wallet::verify_expected_deposit(
                &common.wallet,
                DEPOSIT_TXID,
                DEPOSIT_POOL,
                DEPOSIT_INDEX,
                DEPOSIT_ZATOSHIS,
                DEPOSIT_HEIGHT,
            )?;
            ensure!(
                (sign_sync["tip"].as_u64().context("sign tip missing")? as u32)
                    < prepared.expiry_height,
                "prepared transaction expired before signing"
            );
            ensure!(now()? < reviewed.expires, "session expired before signing");

            // Construct only on the reviewed disposable snapshot. The durable
            // synchronized wallet is never marked as having spent the real note.
            let signed =
                construct_with_prover_stack(&snapshot, &seed, &prepared, &prepared_digest)?;
            ensure!(now()? < reviewed.expires, "session expired during signing");
            store.record_signed(&reviewed, &signed.signed_digest, now()?)?;

            let broadcast_approval = session::BroadcastApproval {
                session: reviewed.clone(),
                signed_digest: signed.signed_digest.clone(),
            };
            let broadcast_digest = session::broadcast_review_digest(&broadcast_approval)?;
            println!(
                "{}",
                json!({
                    "stage":"BROADCAST_REVIEW",
                    "sessionId":session_id,
                    "transaction": {
                        "txid":signed.txid,
                        "signedDigest":signed.signed_digest,
                        "recipient":recipient,
                        "zatoshis":zatoshis.to_string(),
                        "feeZatoshis":signed.fee_zatoshis.to_string(),
                        "expiryHeight":signed.expiry_height,
                        "serializedBytes":signed.serialized_bytes,
                    },
                    "broadcastReviewDigest":broadcast_digest,
                    "realBroadcastAvailable":false,
                })
            );
            exact_approval("BROADCAST", &session_id, &broadcast_digest)?;

            // Fresh spendability, provider, time, and chain-height gates before
            // consuming the mock approval. No network send path follows.
            let live_sync =
                rt.block_on(wallet::sync(&common.wallet, &common.server, &common.peer))?;
            let live_deposit = wallet::verify_expected_deposit(
                &common.wallet,
                DEPOSIT_TXID,
                DEPOSIT_POOL,
                DEPOSIT_INDEX,
                DEPOSIT_ZATOSHIS,
                DEPOSIT_HEIGHT,
            )?;
            let live_tip = live_sync["tip"].as_u64().context("live tip missing")? as u32;
            ensure!(
                live_tip < signed.expiry_height,
                "signed transaction expired before mock broadcast"
            );
            ensure!(
                now()? < reviewed.expires,
                "session expired before mock broadcast"
            );
            store.record_broadcast(&broadcast_approval, now()?)?;
            let mock = store.mock_broadcast(&session_id, now()?)?;
            // Explicit drop removes the disposable DB containing the signed bytes.
            drop(temp);
            println!(
                "{}",
                json!({
                    "stage":"COMPLETE",
                    "sessionId":session_id,
                    "txid":signed.txid,
                    "signedDigest":signed.signed_digest,
                    "liveSync":live_sync,
                    "liveDeposit":live_deposit,
                    "mockBroadcast":mock,
                    "approvalState":store.status(&session_id)?.map(|s| s.state),
                    "signedBytesPersisted":false,
                    "realBroadcast":false,
                    "broadcastDisabled":"ENFORCED_BY_ABSENT_NETWORK_SUBMISSION_PATH",
                })
            );
        }
    }
    Ok(())
}
