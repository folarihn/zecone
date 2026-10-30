//! Testnet and mainnet UFVK scanner. No seed import, spending key access, signing or broadcast API.
mod cache;
mod mainnet_evidence;
mod phase52_refund;
use anyhow::{Context, Result, ensure};
use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tonic::transport::{Channel, ClientTlsConfig};
use zcash_client_backend::{
    TransferType,
    data_api::{
        Account, AccountBirthday, AccountPurpose, WalletCommitmentTrees, WalletRead, WalletWrite,
    },
    decrypt_transaction,
    proto::{
        compact_formats::CompactBlock,
        service::{self, compact_tx_streamer_client::CompactTxStreamerClient},
    },
};
use zcash_client_sqlite::{WalletDb, util::SystemClock, wallet::init::init_wallet_db};
use zcash_keys::{
    address::UnifiedAddress,
    keys::{UnifiedAddressRequest, UnifiedFullViewingKey},
};
use zcash_primitives::{block::BlockHash, transaction::Transaction};
use zcash_protocol::consensus::{BlockHeight, BranchId, Network};
const NET: Network = Network::TestNetwork;
const MAIN_NET: Network = Network::MainNetwork;
const SERVER: &str = "https://testnet.zec.rocks:443";
type Db = WalletDb<rusqlite::Connection, Network, SystemClock, rand::rngs::ThreadRng>;
#[derive(Parser)]
struct Cli {
    #[arg(long)]
    wallet: PathBuf,
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    /// Offline summary of a dedicated Phase 6C database copy. Never syncs or reads keys.
    SnapshotSummary,
    /// Fixed new-profile unsigned refund export. No seed, key input or signing.
    PreparePhase52Refund {
        #[arg(long)]
        profile_id: String,
    },
    /// Public chain metadata only; does not open the wallet path or fetch wallet data.
    ProbeProvider {
        #[arg(long)]
        server: String,
        #[arg(long)]
        height: u32,
    },
    /// Public mainnet metadata only. Requires two independently operated lightwalletd endpoints.
    ProbeMainnet {
        #[arg(long)]
        server: String,
        #[arg(long)]
        peer: String,
        #[arg(long)]
        height: Option<u32>,
    },
    /// Parse and verify a public mainnet header without contacting the network.
    VerifyHeader {
        #[arg(long)]
        header_file: PathBuf,
        #[arg(long)]
        expected_hash: String,
    },
    /// Parse a public mainnet block and verify Merkle inclusion and proof of work.
    VerifyBlock {
        #[arg(long)]
        block_file: PathBuf,
        #[arg(long)]
        expected_hash: String,
        #[arg(long)]
        height: u32,
        #[arg(long)]
        txid: Option<String>,
    },
    /// New directory only. Viewing keys are sensitive and must be transferred privately.
    Import {
        #[arg(long)]
        ufvk_file: PathBuf,
        #[arg(long)]
        birthday: Option<u32>,
    },
    /// Always performs a fresh network scan. Never serves an offline evidence file.
    Observe,
    /// New directory only. Imports a mainnet UFVK for watch-only scanning.
    ImportMainnet {
        #[arg(long)]
        ufvk_file: PathBuf,
        #[arg(long)]
        birthday: u32,
        #[arg(long)]
        server: String,
        #[arg(long)]
        peer: String,
    },
    /// Fresh mainnet scan from two independently operated providers. No signing.
    ObserveMainnet {
        #[arg(long)]
        server: String,
        #[arg(long)]
        peer: String,
        #[arg(long, default_value_t = 10)]
        minimum_confirmations: u32,
        /// Prior persisted tip; the server must still return the same hash.
        #[arg(long)]
        checkpoint_height: Option<u32>,
        /// External directory containing raw `height-hash.bin` mainnet blocks.
        #[arg(long)]
        authenticated_block_dir: PathBuf,
        /// Additional external directories of targeted candidate-segment blocks. Read only
        /// after `--authenticated-block-dir`; every block is verified exactly the same way.
        #[arg(long)]
        candidate_block_dir: Vec<PathBuf>,
        /// Report a note whose raw confirmation segment is not yet available as an
        /// unverified `pendingCandidates` entry instead of failing the whole scan.
        #[arg(long, default_value_t = false)]
        defer_missing_segments: bool,
        /// Select an already authenticated owned-note address, never rewrite the wallet default.
        #[arg(long)]
        receiving_address: Option<String>,
    },
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Manifest {
    version: u32,
    network: String,
    key_id: String,
    birthday: u32,
    address: String,
}
fn write_new(path: &Path, data: &[u8]) -> Result<()> {
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    f.write_all(data)?;
    f.sync_all()?;
    Ok(())
}

fn contains_historical_component(path: &Path) -> bool {
    path.components().any(|component| {
        matches!(
            component
                .as_os_str()
                .to_string_lossy()
                .to_lowercase()
                .as_str(),
            ".secrets" | ".state"
        )
    })
}

fn repository_root() -> Option<PathBuf> {
    let mut current = std::env::current_dir().ok()?;
    loop {
        if current.join(".git").exists() {
            return Some(current);
        }
        current = current.parent()?.to_path_buf();
    }
}

fn ensure_no_symlink_ancestor(path: &Path) -> Result<()> {
    let mut current = path.parent();
    while let Some(parent) = current {
        if parent.exists() {
            ensure!(
                !fs::symlink_metadata(parent)?.file_type().is_symlink(),
                "symlink_watch_path"
            );
        }
        current = parent.parent();
    }
    Ok(())
}

fn canonical_parent(path: &Path) -> Result<PathBuf> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    ensure!(parent.exists(), "watch_parent_missing");
    fs::canonicalize(parent).context("watch_parent_invalid")
}

fn ensure_outside_repository(path: &Path, canonical: &Path) -> Result<()> {
    ensure!(
        !contains_historical_component(path) && !contains_historical_component(canonical),
        "historical_wallet_path_forbidden"
    );
    if let Some(root) = repository_root() {
        let root = fs::canonicalize(root).context("repository_root_invalid")?;
        ensure!(
            !canonical.starts_with(&root),
            "watch_path_inside_repository"
        );
    }
    Ok(())
}

fn ensure_external_new_directory(path: &Path) -> Result<()> {
    ensure!(!path.exists(), "new_directory_required");
    ensure_no_symlink_ancestor(path)?;
    let parent = canonical_parent(path)?;
    let name = path.file_name().context("watch_directory_name")?;
    let canonical = parent.join(name);
    ensure_outside_repository(path, &canonical)?;
    Ok(())
}

fn ensure_external_watch_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path).context("watch_directory_missing")?;
    ensure!(
        !metadata.file_type().is_symlink() && metadata.is_dir(),
        "watch_directory_required"
    );
    ensure_no_symlink_ancestor(path)?;
    let canonical = fs::canonicalize(path).context("watch_directory_invalid")?;
    ensure_outside_repository(path, &canonical)
}

fn ensure_external_file(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path).context("ufvk_file_missing")?;
    ensure!(
        !metadata.file_type().is_symlink() && metadata.is_file(),
        "ufvk_regular_file_required"
    );
    ensure_no_symlink_ancestor(path)?;
    let canonical = fs::canonicalize(path).context("ufvk_file_invalid")?;
    ensure_outside_repository(path, &canonical)
}
struct Lock(PathBuf);
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn inspect_directory(path: &Path) -> Result<Manifest> {
    inspect_directory_for(path, "zcash-testnet")
}
fn inspect_directory_for(path: &Path, expected: &str) -> Result<Manifest> {
    // Reject legacy wallets, surprise files and symlinks before opening any database.
    ensure!(
        !fs::symlink_metadata(path)?.file_type().is_symlink(),
        "symlink_wallet"
    );
    for f in fs::read_dir(path)? {
        let f = f?;
        let name = f.file_name();
        let name = name.to_str().context("filename")?;
        ensure!(
            f.file_type()?.is_file()
                && [
                    "watch-only.json",
                    "viewing-key.txt",
                    "wallet.sqlite",
                    "wallet.sqlite-wal",
                    "wallet.sqlite-shm",
                    "wallet.sqlite-journal",
                    "process.lock"
                ]
                .contains(&name),
            "not_a_watch_only_directory"
        );
    }
    let m: Manifest = serde_json::from_slice(&fs::read(path.join("watch-only.json"))?)?;
    ensure!(
        m.version == 1 && m.network == expected,
        "watch_only_manifest"
    );
    Ok(m)
}
fn viewing_key(path: &Path) -> Result<(UnifiedFullViewingKey, String)> {
    viewing_key_for(path, &NET, "test")
}
fn viewing_key_for(
    path: &Path,
    network: &Network,
    label: &str,
) -> Result<(UnifiedFullViewingKey, String)> {
    ensure!(fs::metadata(path)?.len() <= 4096, "viewing_key_size");
    let s = fs::read_to_string(path)?;
    let s = s.trim();
    let k = UnifiedFullViewingKey::decode(network, s)
        .map_err(|_| anyhow::anyhow!("invalid_{label}_ufvk"))?;
    ensure!(k.orchard().is_some(), "orchard_viewing_key_required");
    Ok((k, hex::encode(Sha256::digest(s.as_bytes()))))
}
async fn connect() -> Result<CompactTxStreamerClient<Channel>> {
    connect_to(SERVER).await
}
async fn connect_to(server: &str) -> Result<CompactTxStreamerClient<Channel>> {
    connect_to_for(server, &NET, "test").await
}
fn mainnet_provider(value: &str) -> Result<()> {
    ensure!(
        value.starts_with("https://") && value.len() <= 200,
        "mainnet_https_provider_required"
    );
    let authority = value["https://".len()..]
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("");
    let host = authority.split(':').next().unwrap_or("");
    ensure!(
        host.contains('.')
            && !host.eq_ignore_ascii_case("localhost")
            && !host.starts_with("127.")
            && !host.starts_with("10.")
            && !host.starts_with("192.168.")
            && !host.to_ascii_lowercase().contains("test"),
        "unreviewed_mainnet_provider"
    );
    Ok(())
}
async fn connect_to_for(
    server: &str,
    network: &Network,
    chain_name: &str,
) -> Result<CompactTxStreamerClient<Channel>> {
    if chain_name == "test" {
        ensure!(
            [
                SERVER,
                "https://lightwalletd.testnet.electriccoin.co:9067",
                "https://lwd.testnet.zec.pro:443"
            ]
            .contains(&server),
            "unreviewed_provider"
        );
    } else {
        mainnet_provider(server)?;
    }
    let channel = Channel::from_shared(server.to_owned())?
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(120))
        .tls_config(ClientTlsConfig::new().with_webpki_roots())?
        .connect()
        .await?;
    let mut c = CompactTxStreamerClient::new(channel);
    let i = c.get_lightd_info(service::Empty {}).await?.into_inner();
    ensure!(i.chain_name == chain_name, "wrong_network");
    let h = u32::try_from(i.block_height)?;
    ensure!(
        u32::from_str_radix(i.consensus_branch_id.trim_start_matches("0x"), 16)?
            == u32::from(BranchId::for_height(network, h.into())),
        "unsupported_consensus"
    );
    Ok(c)
}
async fn tree(c: &mut CompactTxStreamerClient<Channel>, height: u32) -> Result<service::TreeState> {
    tree_for(c, &NET, "test", height).await
}
async fn tree_for(
    c: &mut CompactTxStreamerClient<Channel>,
    _network: &Network,
    chain_name: &str,
    height: u32,
) -> Result<service::TreeState> {
    let t = c
        .get_tree_state(service::BlockId {
            height: height.into(),
            hash: vec![],
        })
        .await?
        .into_inner();
    ensure!(
        t.network == chain_name && t.height == u64::from(height),
        "wrong_tree_state"
    );
    Ok(t)
}
fn database(path: &Path) -> Result<Db> {
    database_for(path, &NET)
}
fn database_for(path: &Path, network: &Network) -> Result<Db> {
    let mut db = WalletDb::for_path(
        path.join("wallet.sqlite"),
        *network,
        SystemClock,
        rand::rng(),
    )?;
    init_wallet_db(&mut db, None)?;
    Ok(db)
}
async fn probe(server: &str, height: u32) -> Result<Value> {
    let mut c = connect_to(server).await?;
    let info = c.get_lightd_info(service::Empty {}).await?.into_inner();
    let t = tree(&mut c, height).await?;
    ensure!(u64::from(height) <= info.block_height, "height_above_tip");
    Ok(
        json!({"network":"zcash-testnet","source":server,"chainName":info.chain_name,"tip":info.block_height,
        "branch":info.consensus_branch_id,"height":height,"blockHash":t.hash,"ironwoodAnchor":hex::encode(t.ironwood_tree()?.root().to_bytes()),
        "observedAt":SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),"readOnly":true}),
    )
}
async fn probe_mainnet(server: &str, peer: &str, height: Option<u32>) -> Result<Value> {
    ensure!(server != peer, "independent_mainnet_peer_required");
    mainnet_provider(server)?;
    mainnet_provider(peer)?;
    let mut c = connect_to_for(server, &MAIN_NET, "main").await?;
    let mut p = connect_to_for(peer, &MAIN_NET, "main").await?;
    let primary_info = c.get_lightd_info(service::Empty {}).await?.into_inner();
    let peer_info = p.get_lightd_info(service::Empty {}).await?.into_inner();
    ensure!(
        primary_info.chain_name == "main" && peer_info.chain_name == "main",
        "wrong_network"
    );
    let tip = u32::try_from(primary_info.block_height.min(peer_info.block_height))?;
    let h = height.unwrap_or(tip.checked_sub(10).context("tip_too_low")?);
    ensure!(h > 0 && h <= tip, "height_above_tip");
    let primary_tree = tree_for(&mut c, &MAIN_NET, "main", h).await?;
    let peer_tree = tree_for(&mut p, &MAIN_NET, "main", h).await?;
    ensure!(
        primary_tree.hash == peer_tree.hash,
        "mainnet_provider_disagreement"
    );
    ensure!(
        primary_tree.orchard_tree()? == peer_tree.orchard_tree()?,
        "mainnet_provider_disagreement"
    );
    let primary_latest = c
        .get_latest_block(service::ChainSpec::default())
        .await?
        .into_inner();
    let peer_latest = p
        .get_latest_block(service::ChainSpec::default())
        .await?
        .into_inner();
    Ok(json!({
        "network":"zcash-mainnet",
        "source":server,
        "peerSource":peer,
        "primaryTip":primary_info.block_height,
        "peerTip":peer_info.block_height,
        "primaryLatestHash":hex::encode(primary_latest.hash),
        "peerLatestHash":hex::encode(peer_latest.hash),
        "height":h,
        "confirmations":tip.saturating_sub(h),
        "blockHash":primary_tree.hash,
        "orchardRoot":hex::encode(primary_tree.orchard_tree()?.root().to_bytes()),
        "providerAgreement":"PASS",
        "authenticatedProofOfWork":"NOT_CHECKED_BY_GRPC_PROBE",
        "observedAt":SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
        "readOnly":true
    }))
}

fn read_bounded(path: &Path) -> Result<Vec<u8>> {
    ensure!(
        fs::metadata(path)?.len() <= 16 * 1024 * 1024,
        "file_too_large"
    );
    Ok(fs::read(path)?)
}

fn verify_header_file(path: &Path, expected_hash: &str) -> Result<Value> {
    mainnet_evidence::verify_header(&read_bounded(path)?, expected_hash)
}

fn verify_block_file(
    path: &Path,
    expected_hash: &str,
    height: u32,
    txid: Option<&str>,
) -> Result<Value> {
    mainnet_evidence::verify_block(&read_bounded(path)?, expected_hash, height, txid)
}

async fn import(path: &Path, ufvk_file: &Path, height: Option<u32>) -> Result<Value> {
    let (key, id) = viewing_key(ufvk_file)?;
    ensure!(!path.exists(), "new_directory_required");
    let mut c = connect().await?;
    let tip = u32::try_from(
        c.get_latest_block(service::ChainSpec::default())
            .await?
            .into_inner()
            .height,
    )?;
    let prior = height.unwrap_or(tip.checked_sub(100).context("tip_too_low")?);
    ensure!(prior > 0 && prior < tip, "invalid_birthday");
    let t = tree(&mut c, prior).await?;
    let birth = AccountBirthday::from_treestate(t, None)?;
    fs::create_dir(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    let mut db = database(path)?;
    // Retain nullifiers and witnesses for later independent review; no secret is present.
    let a = db.import_account_ufvk(
        "isolated-phase5-watch",
        &key,
        &birth,
        AccountPurpose::Spending { derivation: None },
        Some("independent-test-signer"),
    )?;
    let (ua, _) = db
        .get_next_available_address(a.id(), UnifiedAddressRequest::ORCHARD)?
        .context("missing_address")?;
    let manifest = Manifest {
        version: 1,
        network: "zcash-testnet".into(),
        key_id: id,
        birthday: prior,
        address: ua.encode(&NET),
    };
    write_new(&path.join("viewing-key.txt"), key.encode(&NET)?.as_bytes())?;
    write_new(
        &path.join("watch-only.json"),
        &serde_json::to_vec(&manifest)?,
    )?;
    Ok(
        json!({"network":manifest.network,"account":manifest.key_id,"address":manifest.address,"birthday":prior,"watchOnly":true,"liveRefundsEnabled":false}),
    )
}
async fn import_mainnet(
    path: &Path,
    ufvk_file: &Path,
    prior: u32,
    server: &str,
    peer: &str,
) -> Result<Value> {
    ensure!(server != peer, "independent_mainnet_peer_required");
    mainnet_provider(server)?;
    mainnet_provider(peer)?;
    ensure_external_new_directory(path)?;
    ensure_external_file(ufvk_file)?;
    let (key, id) = viewing_key_for(ufvk_file, &MAIN_NET, "mainnet")?;
    let mut c = connect_to_for(server, &MAIN_NET, "main").await?;
    let tip = u32::try_from(
        c.get_latest_block(service::ChainSpec::default())
            .await?
            .into_inner()
            .height,
    )?;
    ensure!(prior > 0 && prior < tip, "invalid_birthday");
    let t = tree_for(&mut c, &MAIN_NET, "main", prior).await?;
    let mut p = connect_to_for(peer, &MAIN_NET, "main").await?;
    let pt = tree_for(&mut p, &MAIN_NET, "main", prior).await?;
    ensure!(t.hash == pt.hash, "mainnet_provider_disagreement");
    let birth = AccountBirthday::from_treestate(t, None)?;
    fs::create_dir(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    let mut db = database_for(path, &MAIN_NET)?;
    // Retain nullifiers and witnesses for independent review; no spending key is present.
    let a = db.import_account_ufvk(
        "isolated-mainnet-watch",
        &key,
        &birth,
        AccountPurpose::Spending { derivation: None },
        Some("independent-mainnet-watch"),
    )?;
    let (ua, _) = db
        .get_next_available_address(a.id(), UnifiedAddressRequest::ORCHARD)?
        .context("missing_address")?;
    let manifest = Manifest {
        version: 1,
        network: "zcash-mainnet".into(),
        key_id: id,
        birthday: prior,
        address: ua.encode(&MAIN_NET),
    };
    write_new(
        &path.join("viewing-key.txt"),
        key.encode(&MAIN_NET)?.as_bytes(),
    )?;
    write_new(
        &path.join("watch-only.json"),
        &serde_json::to_vec(&manifest)?,
    )?;
    Ok(
        json!({"network":manifest.network,"account":manifest.key_id,"address":manifest.address,"birthday":prior,"watchOnly":true,"liveRefundsEnabled":false,"source":server,"peer":peer,"signing":false,"broadcast":false}),
    )
}
async fn observe(path: &Path) -> Result<Value> {
    let manifest = inspect_directory(path)?;
    let (key, id) = viewing_key(&path.join("viewing-key.txt"))?;
    ensure!(id == manifest.key_id, "viewing_key_changed");
    let lock = path.join("process.lock");
    write_new(&lock, std::process::id().to_string().as_bytes())?;
    let _lock = Lock(lock);
    let mut db = database(path)?;
    let accounts = db.get_account_ids()?;
    ensure!(accounts.len() == 1, "watch_account_count");
    ensure!(
        db.get_account(accounts[0])?
            .context("account_missing")?
            .ufvk()
            .context("missing_ufvk")?
            .encode(&NET)?
            == key.encode(&NET)?,
        "watch_account_mismatch"
    );
    let mut c = connect().await?;
    zcash_client_backend::sync::run(&mut c, &NET, &cache::Cache::default(), &mut db, 1000).await?;
    let tip = u32::from(db.chain_height()?.context("missing_tip")?);
    let scanned = db.block_fully_scanned()?.context("missing_scan")?;
    ensure!(u32::from(scanned.block_height()) == tip, "incomplete_scan");
    let remote = tree(&mut c, tip).await?;
    let mut hash = scanned.block_hash().0;
    hash.reverse();
    ensure!(
        remote.hash.to_lowercase() == hex::encode(hash),
        "chain_hash_disagreement"
    );
    let conn = rusqlite::Connection::open_with_flags(
        path.join("wallet.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    // The wallet checkpoints sparse trees; empty blocks need not have a checkpoint.
    let anchor_height: u32 = conn.query_row(
        "SELECT MAX(checkpoint_id) FROM ironwood_tree_checkpoints WHERE checkpoint_id<=?",
        [tip.checked_sub(9).context("tip_too_low")?],
        |r| r.get(0),
    )?;
    let anchor_state = tree(&mut c, anchor_height).await?;
    let anchor = anchor_state.ironwood_tree()?.root();
    let local = db
        .with_ironwood_tree_mut(|t| t.root_at_checkpoint_id(&anchor_height.into()))?
        .flatten()
        .context("missing_local_anchor")?;
    ensure!(local == anchor, "chain_anchor_disagreement");
    // Refuse evidence when tip moved during export. Caller must rescan/retry.
    let latest = c
        .get_latest_block(service::ChainSpec::default())
        .await?
        .into_inner();
    ensure!(latest.height == u64::from(tip), "tip_changed_retry_scan");
    let final_tree = tree(&mut c, tip).await?;
    ensure!(
        final_tree.hash == remote.hash && final_tree.ironwood_tree == remote.ironwood_tree,
        "chain_changed_retry_scan"
    );
    let mut stmt=conn.prepare("SELECT t.txid,r.pool,r.output_index,r.value,t.mined_height,b.hash FROM v_received_outputs r JOIN transactions t ON t.id_tx=r.transaction_id JOIN blocks b ON b.height=t.mined_height WHERE r.pool IN (2,3,4) AND r.is_change=0 AND r.value>0 ORDER BY t.txid,r.pool,r.output_index")?;
    let payments=stmt.query_map([],|r| {
        let mut tx:Vec<u8>=r.get(0)?;tx.reverse();let mut hash:Vec<u8>=r.get(5)?;hash.reverse();
        Ok(json!({"account":id,"txid":hex::encode(tx),"pool":r.get::<_,u32>(1)?,"index":r.get::<_,u32>(2)?,"zatoshis":r.get::<_,u64>(3)?.to_string(),"height":r.get::<_,u32>(4)?,"blockHash":hex::encode(hash)}))
    })?.collect::<Result<Vec<_>,_>>()?;
    // Conservative: any recorded spend or lock excludes a note, even an expired transaction.
    let mut stmt=conn.prepare("SELECT n.nf,n.value,t.mined_height,t.txid,n.action_index FROM ironwood_received_notes n JOIN transactions t ON t.id_tx=n.transaction_id JOIN blocks b ON b.height=t.mined_height WHERE n.is_change=0 AND n.value>0 AND n.nf IS NOT NULL AND n.commitment_tree_position IS NOT NULL AND n.lock_owner IS NULL AND NOT EXISTS(SELECT 1 FROM ironwood_received_note_spends s WHERE s.ironwood_received_note_id=n.id)")?;
    let inputs=stmt.query_map([],|r| {
        let mut tx:Vec<u8>=r.get(3)?;tx.reverse();
        Ok(json!({"nullifier":hex::encode(r.get::<_,Vec<u8>>(0)?),"zatoshis":r.get::<_,u64>(1)?.to_string(),"minedHeight":r.get::<_,u32>(2)?,"paymentKey":format!("{}:4:{}",hex::encode(tx),r.get::<_,u32>(4)?)}))
    })?.collect::<Result<Vec<_>,_>>()?;
    Ok(
        json!({"network":"zcash-testnet","watchOnly":true,"liveChain":true,"liveRefundsEnabled":false,"source":SERVER,"account":id,"address":manifest.address,"birthday":manifest.birthday,"tip":tip,"scanned":tip,"blockHash":hex::encode(hash),"observedAt":SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),"payments":payments,"native":{"fullViewingKey":hex::encode(key.orchard().unwrap().to_bytes()),"anchor":hex::encode(anchor.to_bytes()),"anchorHeight":anchor_height,"inputs":inputs}}),
    )
}

#[derive(Debug)]
struct MainnetPaymentRow {
    account: String,
    txid: String,
    rpc_txid: Vec<u8>,
    pool: u32,
    index: usize,
    zatoshis: u64,
    height: u32,
    block_hash: String,
    address: String,
    nullifier: Option<Vec<u8>>,
    locked: bool,
    spent: bool,
    is_change: bool,
}

/// Re-establish ownership from provider-corroborated transaction bytes instead of trusting
/// wallet SQLite rows. The database is only a candidate index; the returned memo and evidence
/// digest come from a fresh full-transaction trial decryption with the imported UFVK.
fn compact_txids(block: &CompactBlock) -> Vec<Vec<u8>> {
    block.vtx.iter().map(|tx| tx.txid.clone()).collect()
}

/// A provider-agreed block of a payment's confirmation segment has no raw file yet.
/// Only this condition may defer a note; every other verification failure stays fatal.
#[derive(Debug)]
struct MissingAuthenticatedBlock {
    height: u32,
    hash: String,
}

impl std::fmt::Display for MissingAuthenticatedBlock {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("authenticated_mainnet_block_unavailable")
    }
}

impl std::error::Error for MissingAuthenticatedBlock {}

/// First directory holding `height-hash.bin` for the provider-agreed hash. A file only
/// selects bytes to verify; it is never trusted because of where it was found.
fn locate_authenticated_block(dirs: &[&Path], height: u32, hash: &str) -> Result<PathBuf> {
    let name = format!("{height}-{hash}.bin");
    dirs.iter()
        .map(|dir| dir.join(&name))
        .find(|path| path.exists())
        .ok_or_else(|| {
            anyhow::Error::new(MissingAuthenticatedBlock {
                height,
                hash: hash.to_string(),
            })
        })
}

/// Last block of the bounded segment that proves a payment: up to the tip, at most
/// `minimum_confirmations` blocks.
fn confirmation_end(height: u32, tip: u32, minimum_confirmations: u32) -> Result<u32> {
    let available = tip
        .checked_sub(height)
        .and_then(|depth| depth.checked_add(1))
        .context("mainnet_payment_above_tip")?;
    let proof_blocks = available.min(minimum_confirmations);
    ensure!(proof_blocks > 0, "mainnet_payment_above_tip");
    height
        .checked_add(proof_blocks - 1)
        .context("confirmation_height_overflow")
}

async fn verify_confirmation_chain(
    primary: &mut CompactTxStreamerClient<Channel>,
    peer: &mut CompactTxStreamerClient<Channel>,
    start_height: u32,
    end_height: u32,
    block_dirs: &[&Path],
    expected_txid: &str,
) -> Result<(Value, Value)> {
    ensure!(start_height <= end_height, "invalid_confirmation_range");
    ensure!(
        end_height - start_height < 100,
        "confirmation_chain_too_long"
    );
    let mut primary_blocks = Vec::with_capacity((end_height - start_height + 1) as usize);
    let mut peer_blocks = Vec::with_capacity(primary_blocks.capacity());
    let mut raw_headers = Vec::with_capacity(primary_blocks.capacity());
    let mut payment_block_evidence = None;
    for height in start_height..=end_height {
        let id = service::BlockId {
            height: u64::from(height),
            hash: vec![],
        };
        let primary_block = primary
            .get_block(id.clone())
            .await
            .context("mainnet_primary_confirmation_block_unavailable")?
            .into_inner();
        let peer_block = peer
            .get_block(id)
            .await
            .context("mainnet_peer_confirmation_block_unavailable")?
            .into_inner();
        ensure!(
            primary_block.height == u64::from(height)
                && peer_block.height == u64::from(height)
                && primary_block.hash == peer_block.hash
                && primary_block.prev_hash == peer_block.prev_hash,
            "mainnet_confirmation_provider_disagreement"
        );
        ensure!(
            primary_block.hash.len() == 32,
            "mainnet_confirmation_hash_invalid"
        );
        let hash = BlockHash::from_slice(&primary_block.hash).to_string();
        ensure!(hash.len() == 64, "mainnet_confirmation_hash_invalid");
        let block_path = locate_authenticated_block(block_dirs, height, &hash)?;
        let raw = read_bounded(&block_path).context("authenticated_mainnet_block_unavailable")?;
        let (block_evidence, header) = mainnet_evidence::verify_full_block(
            &raw,
            &hash,
            height,
            (height == start_height).then_some(expected_txid),
        )?;
        if height == start_height {
            payment_block_evidence = Some(block_evidence);
        }
        raw_headers.push(header);
        primary_blocks.push(primary_block);
        peer_blocks.push(peer_block);
    }
    let primary_headers = primary_blocks
        .iter()
        .enumerate()
        .map(|(index, block)| mainnet_evidence::CompactHeader {
            height: u32::try_from(block.height).expect("bounded mainnet height"),
            hash: &block.hash,
            previous_hash: &block.prev_hash,
            header: &raw_headers[index],
        })
        .collect::<Vec<_>>();
    let peer_headers = peer_blocks
        .iter()
        .enumerate()
        .map(|(index, block)| mainnet_evidence::CompactHeader {
            height: u32::try_from(block.height).expect("bounded mainnet height"),
            hash: &block.hash,
            previous_hash: &block.prev_hash,
            header: &raw_headers[index],
        })
        .collect::<Vec<_>>();
    let primary_evidence =
        mainnet_evidence::verify_chain_segment(&primary_headers, start_height, end_height)?;
    let peer_evidence =
        mainnet_evidence::verify_chain_segment(&peer_headers, start_height, end_height)?;
    ensure!(
        primary_evidence.start_hash == peer_evidence.start_hash
            && primary_evidence.end_hash == peer_evidence.end_hash
            && primary_evidence.accumulated_work == peer_evidence.accumulated_work,
        "mainnet_confirmation_provider_disagreement"
    );
    Ok((
        payment_block_evidence.context("missing_authenticated_payment_block")?,
        primary_evidence.to_json(),
    ))
}

struct MainnetPaymentVerification<'a> {
    key: &'a UnifiedFullViewingKey,
    account_id: zcash_client_sqlite::AccountUuid,
    row: &'a MainnetPaymentRow,
    tip: u32,
    minimum_confirmations: u32,
    block_dirs: &'a [&'a Path],
}

async fn verify_mainnet_payment(
    primary: &mut CompactTxStreamerClient<Channel>,
    peer: &mut CompactTxStreamerClient<Channel>,
    verification: MainnetPaymentVerification<'_>,
) -> Result<(String, String, Value, Value)> {
    let MainnetPaymentVerification {
        key,
        account_id,
        row,
        tip,
        minimum_confirmations,
        block_dirs,
    } = verification;
    let filter = service::TxFilter {
        hash: row.rpc_txid.clone(),
        ..Default::default()
    };
    let primary_raw = primary
        .get_transaction(filter.clone())
        .await
        .context("mainnet_primary_transaction_unavailable")?
        .into_inner();
    let peer_raw = peer
        .get_transaction(filter)
        .await
        .context("mainnet_peer_transaction_unavailable")?
        .into_inner();
    ensure!(
        primary_raw.height == u64::from(row.height)
            && peer_raw.height == u64::from(row.height)
            && primary_raw.data == peer_raw.data,
        "mainnet_transaction_provider_disagreement"
    );
    let primary_block = tree_for(primary, &MAIN_NET, "main", row.height).await?;
    let peer_block = tree_for(peer, &MAIN_NET, "main", row.height).await?;
    ensure!(
        primary_block.hash == peer_block.hash
            && primary_block.hash.to_lowercase() == row.block_hash,
        "mainnet_payment_block_disagreement"
    );
    let primary_compact = primary
        .get_block(service::BlockId {
            height: u64::from(row.height),
            hash: vec![],
        })
        .await
        .context("mainnet_primary_compact_block_unavailable")?
        .into_inner();
    let peer_compact = peer
        .get_block(service::BlockId {
            height: u64::from(row.height),
            hash: vec![],
        })
        .await
        .context("mainnet_peer_compact_block_unavailable")?
        .into_inner();
    let primary_txids = compact_txids(&primary_compact);
    let peer_txids = compact_txids(&peer_compact);
    ensure!(
        primary_compact.height == u64::from(row.height)
            && peer_compact.height == u64::from(row.height)
            && primary_compact.hash == peer_compact.hash
            && primary_compact.prev_hash == peer_compact.prev_hash
            && primary_txids == peer_txids,
        "mainnet_compact_block_provider_disagreement"
    );
    let confirmation_end = confirmation_end(row.height, tip, minimum_confirmations)?;
    ensure!(
        primary_txids
            .iter()
            .filter(|txid| txid.as_slice() == row.rpc_txid)
            .count()
            == 1,
        "mainnet_payment_not_in_compact_block"
    );
    let (block_evidence, chain_evidence) = verify_confirmation_chain(
        primary,
        peer,
        row.height,
        confirmation_end,
        block_dirs,
        &row.txid,
    )
    .await?;
    ensure!(
        chain_evidence["startHash"] == row.block_hash,
        "mainnet_confirmation_start_disagreement"
    );
    let height = BlockHeight::from(row.height);
    let tx = Transaction::read(
        primary_raw.data.as_slice(),
        BranchId::for_height(&MAIN_NET, height),
    )
    .context("mainnet_transaction_parse_failed")?;
    ensure!(
        tx.txid().as_ref() == row.rpc_txid.as_slice() && tx.txid().to_string() == row.txid,
        "mainnet_transaction_id_disagreement"
    );
    let mut keys = HashMap::new();
    keys.insert(account_id, key.clone());
    let decrypted = decrypt_transaction(&MAIN_NET, Some(height), Some(height), &tx, &keys);
    let target = UnifiedAddress::decode(&MAIN_NET, &row.address)
        .context("mainnet_payment_address_invalid")?;
    let memo = match row.pool {
        2 => decrypted
            .sapling_outputs()
            .iter()
            .find(|output| {
                output.index() == row.index
                    && output.account() == &account_id
                    && output.transfer_type() == TransferType::Incoming
                    && output.note_value().into_u64() == row.zatoshis
                    && target
                        .sapling()
                        .is_some_and(|receiver| receiver == &output.note().recipient())
            })
            .map(|output| hex::encode(output.memo().as_array())),
        3 => decrypted
            .orchard_outputs()
            .iter()
            .find(|output| {
                output.index() == row.index
                    && output.account() == &account_id
                    && output.transfer_type() == TransferType::Incoming
                    && output.note().0.value().inner() == row.zatoshis
                    && target
                        .orchard()
                        .is_some_and(|receiver| receiver == &output.note().0.recipient())
            })
            .map(|output| hex::encode(output.memo().as_array())),
        4 => decrypted
            .ironwood_outputs()
            .iter()
            .find(|output| {
                output.index() == row.index
                    && output.account() == &account_id
                    && output.transfer_type() == TransferType::Incoming
                    && output.note().0.value().inner() == row.zatoshis
                    && target
                        .orchard()
                        .is_some_and(|receiver| receiver == &output.note().0.recipient())
            })
            .map(|output| hex::encode(output.memo().as_array())),
        _ => None,
    }
    .context("mainnet_owned_note_decryption_failed")?;
    let mut evidence = Sha256::new();
    evidence.update(b"zecone-mainnet-owned-note-v3");
    evidence.update(&primary_raw.data);
    evidence.update(row.height.to_le_bytes());
    evidence.update(row.pool.to_le_bytes());
    evidence.update((row.index as u64).to_le_bytes());
    evidence.update(row.zatoshis.to_le_bytes());
    evidence.update(row.block_hash.as_bytes());
    evidence.update(row.address.as_bytes());
    evidence.update(
        block_evidence["transactionMerkleRoot"]
            .as_str()
            .context("missing_verified_merkle_root")?,
    );
    evidence.update(
        chain_evidence["endHash"]
            .as_str()
            .context("missing_chain_end_hash")?,
    );
    evidence.update(
        chain_evidence["accumulatedWork"]
            .as_str()
            .context("missing_accumulated_work")?,
    );
    Ok((
        memo,
        hex::encode(evidence.finalize()),
        block_evidence,
        chain_evidence,
    ))
}

struct MainnetBlockSources<'a> {
    authenticated_block_dir: &'a Path,
    candidate_block_dirs: &'a [PathBuf],
    defer_missing_segments: bool,
}

async fn observe_mainnet(
    path: &Path,
    server: &str,
    peer: &str,
    minimum_confirmations: u32,
    checkpoint_height: Option<u32>,
    sources: MainnetBlockSources<'_>,
    receiving_address: Option<&str>,
) -> Result<Value> {
    ensure!(server != peer, "independent_mainnet_peer_required");
    ensure!(minimum_confirmations > 0, "invalid_confirmations");
    ensure_external_watch_directory(path)?;
    ensure_external_watch_directory(sources.authenticated_block_dir)
        .context("authenticated_block_directory_invalid")?;
    for dir in sources.candidate_block_dirs {
        ensure_external_watch_directory(dir).context("candidate_block_directory_invalid")?;
    }
    let block_dirs = std::iter::once(sources.authenticated_block_dir)
        .chain(sources.candidate_block_dirs.iter().map(PathBuf::as_path))
        .collect::<Vec<_>>();
    let manifest = inspect_directory_for(path, "zcash-mainnet")?;
    let (key, id) = viewing_key_for(&path.join("viewing-key.txt"), &MAIN_NET, "mainnet")?;
    ensure!(id == manifest.key_id, "viewing_key_changed");
    let lock = path.join("process.lock");
    write_new(&lock, std::process::id().to_string().as_bytes())?;
    let _lock = Lock(lock);
    let mut db = database_for(path, &MAIN_NET)?;
    let accounts = db.get_account_ids()?;
    ensure!(accounts.len() == 1, "watch_account_count");
    ensure!(
        db.get_account(accounts[0])?
            .context("account_missing")?
            .ufvk()
            .context("missing_ufvk")?
            .encode(&MAIN_NET)?
            == key.encode(&MAIN_NET)?,
        "watch_account_mismatch"
    );
    let mut c = connect_to_for(server, &MAIN_NET, "main").await?;
    zcash_client_backend::sync::run(&mut c, &MAIN_NET, &cache::Cache::default(), &mut db, 1000)
        .await?;
    let tip = u32::from(db.chain_height()?.context("missing_tip")?);
    let scanned = db.block_fully_scanned()?.context("missing_scan")?;
    ensure!(u32::from(scanned.block_height()) == tip, "incomplete_scan");
    let remote = tree_for(&mut c, &MAIN_NET, "main", tip).await?;
    let mut hash = scanned.block_hash().0;
    hash.reverse();
    ensure!(
        remote.hash.to_lowercase() == hex::encode(hash),
        "chain_hash_disagreement"
    );
    let conn = rusqlite::Connection::open_with_flags(
        path.join("wallet.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    // Mainnet uses the Orchard commitment tree; checkpoints are sparse.
    let anchor_height: u32 = conn.query_row(
        "SELECT MAX(checkpoint_id) FROM orchard_tree_checkpoints WHERE checkpoint_id<=?",
        [tip.checked_sub(9).context("tip_too_low")?],
        |r| r.get(0),
    )?;
    let anchor_state = tree_for(&mut c, &MAIN_NET, "main", anchor_height).await?;
    let anchor = anchor_state.orchard_tree()?.root();
    let local = db
        .with_orchard_tree_mut(|t| t.root_at_checkpoint_id(&anchor_height.into()))?
        .context("missing_local_anchor")?;
    ensure!(local == anchor, "chain_anchor_disagreement");
    let mut p = connect_to_for(peer, &MAIN_NET, "main").await?;
    let peer_info = p.get_lightd_info(service::Empty {}).await?.into_inner();
    ensure!(
        peer_info.chain_name == "main" && peer_info.block_height >= u64::from(tip),
        "mainnet_peer_stale"
    );
    let peer_tip = tree_for(&mut p, &MAIN_NET, "main", tip).await?;
    let peer_anchor = tree_for(&mut p, &MAIN_NET, "main", anchor_height).await?;
    ensure!(
        peer_tip.hash == remote.hash
            && peer_tip.orchard_tree()? == remote.orchard_tree()?
            && peer_anchor.orchard_tree()?.root() == anchor,
        "mainnet_provider_disagreement"
    );
    let checkpoint_value = if let Some(checkpoint_height) = checkpoint_height {
        ensure!(checkpoint_height <= tip, "checkpoint_above_tip");
        let primary_checkpoint = tree_for(&mut c, &MAIN_NET, "main", checkpoint_height).await?;
        let peer_checkpoint = tree_for(&mut p, &MAIN_NET, "main", checkpoint_height).await?;
        ensure!(
            primary_checkpoint.hash == peer_checkpoint.hash
                && primary_checkpoint.orchard_tree()? == peer_checkpoint.orchard_tree()?,
            "mainnet_checkpoint_disagreement"
        );
        Some(json!({
            "height": checkpoint_height,
            "hash": primary_checkpoint.hash,
            "orchardRoot": hex::encode(primary_checkpoint.orchard_tree()?.root().to_bytes())
        }))
    } else {
        None
    };
    let latest = c
        .get_latest_block(service::ChainSpec::default())
        .await?
        .into_inner();
    ensure!(latest.height == u64::from(tip), "tip_changed_retry_scan");
    let final_tree = tree_for(&mut c, &MAIN_NET, "main", tip).await?;
    ensure!(
        final_tree.hash == remote.hash && final_tree.orchard_tree()? == remote.orchard_tree()?,
        "chain_changed_retry_scan"
    );
    let mut stmt = conn.prepare("SELECT t.txid,r.pool,r.output_index,r.value,t.mined_height,b.hash,a.address,COALESCE(sp.nf,op.nf,ip.nf),CASE WHEN sp.lock_owner IS NOT NULL OR op.lock_owner IS NOT NULL OR ip.lock_owner IS NOT NULL THEN 1 ELSE 0 END,(SELECT COUNT(*) FROM v_received_output_spends s WHERE s.pool=r.pool AND s.received_output_id=r.id_within_pool_table),r.is_change FROM v_received_outputs r JOIN transactions t ON t.id_tx=r.transaction_id JOIN blocks b ON b.height=t.mined_height JOIN addresses a ON a.id=r.address_id LEFT JOIN sapling_received_notes sp ON r.pool=2 AND sp.id=r.id_within_pool_table LEFT JOIN orchard_received_notes op ON r.pool=3 AND op.id=r.id_within_pool_table LEFT JOIN ironwood_received_notes ip ON r.pool=4 AND ip.id=r.id_within_pool_table WHERE r.pool IN (2,3,4) AND r.is_change=0 AND r.value>0 AND t.mined_height IS NOT NULL ORDER BY t.txid,r.pool,r.output_index")?;
    let candidates = stmt
        .query_map([], |r| {
            let rpc_txid: Vec<u8> = r.get(0)?;
            let mut tx = rpc_txid.clone();
            tx.reverse();
            let mut block: Vec<u8> = r.get(5)?;
            block.reverse();
            Ok(MainnetPaymentRow {
                account: id.to_string(),
                txid: hex::encode(tx),
                rpc_txid,
                pool: r.get(1)?,
                index: r.get::<_, u32>(2)? as usize,
                zatoshis: r.get(3)?,
                height: r.get(4)?,
                block_hash: hex::encode(block),
                address: r.get(6)?,
                nullifier: r.get(7)?,
                locked: r.get::<_, u32>(8)? != 0,
                spent: r.get::<_, u32>(9)? != 0,
                is_change: r.get::<_, u32>(10)? != 0,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    drop(conn);
    let mut payments = Vec::with_capacity(candidates.len());
    let mut pending = Vec::new();
    for row in candidates {
        let verified = verify_mainnet_payment(
            &mut c,
            &mut p,
            MainnetPaymentVerification {
                key: &key,
                account_id: accounts[0],
                row: &row,
                tip,
                minimum_confirmations,
                block_dirs: &block_dirs,
            },
        )
        .await;
        let (memo, ownership_digest, block_evidence, chain_evidence) = match verified {
            Ok(value) => value,
            Err(error) if sources.defer_missing_segments => {
                // Only a missing raw block defers; the note is a compact-scan candidate,
                // never a verified payment, and carries no ownership evidence.
                let Some(missing) = error.downcast_ref::<MissingAuthenticatedBlock>() else {
                    return Err(error);
                };
                pending.push(json!({
                    "account":row.account,"txid":row.txid,"pool":row.pool,"index":row.index,
                    "zatoshis":row.zatoshis.to_string(),"height":row.height,"blockHash":row.block_hash,
                    "address":row.address,"isChange":row.is_change,
                    "confirmations":tip.checked_sub(row.height).map(|d|d+1),
                    "verified":false,"evidence":"compact-scan-candidate",
                    "missingHeight":missing.height,"missingHash":missing.hash,
                    "segmentEnd":confirmation_end(row.height, tip, minimum_confirmations)?
                }));
                continue;
            }
            Err(error) => return Err(error),
        };
        payments.push(json!({
            "account":row.account,"txid":row.txid,"pool":row.pool,"index":row.index,
            "zatoshis":row.zatoshis.to_string(),"height":row.height,"blockHash":row.block_hash,
            "address":row.address,"memo":memo,"nullifier":row.nullifier.map(hex::encode),
            "locked":row.locked,"spent":row.spent,"isChange":row.is_change,
            "confirmations":tip.checked_sub(row.height).map(|d|d+1),
            "ownershipEvidence":{"scheme":"zcash-full-transaction-ufvk-v3","digest":ownership_digest,"providers":2,"blockEvidence":block_evidence,"chainEvidence":chain_evidence}
        }));
    }
    let latest_after = c
        .get_latest_block(service::ChainSpec::default())
        .await?
        .into_inner();
    let peer_latest_after = p
        .get_latest_block(service::ChainSpec::default())
        .await?
        .into_inner();
    ensure!(
        latest_after.height == u64::from(tip) && peer_latest_after.height >= u64::from(tip),
        "tip_changed_retry_scan"
    );
    let primary_tip_after = tree_for(&mut c, &MAIN_NET, "main", tip).await?;
    let peer_tip_after = tree_for(&mut p, &MAIN_NET, "main", tip).await?;
    ensure!(
        primary_tip_after.hash == remote.hash
            && peer_tip_after.hash == remote.hash
            && primary_tip_after.orchard_tree()? == remote.orchard_tree()?
            && peer_tip_after.orchard_tree()? == remote.orchard_tree()?,
        "chain_changed_retry_scan"
    );
    let selected_address =
        select_authenticated_receiving_address(&manifest.address, receiving_address, &payments)?;
    let mut snapshot = json!({"network":"zcash-mainnet","watchOnly":true,"liveChain":true,"liveRefundsEnabled":false,"source":server,"peerSource":peer,"account":id,"address":selected_address,"defaultAddress":manifest.address,"birthday":manifest.birthday,"tip":tip,"scanned":tip,"blockHash":hex::encode(hash),"observedAt":SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),"minimumConfirmations":minimum_confirmations,"anchor":hex::encode(anchor.to_bytes()),"anchorHeight":anchor_height,"checkpoint":checkpoint_value,"payments":payments});
    if sources.defer_missing_segments {
        snapshot["pendingCandidates"] = Value::Array(pending);
    }
    Ok(snapshot)
}
// `payments` is populated exclusively by verify_mainnet_payment above, including
// UFVK trial decryption and exact receiver equality for the note's shielded pool.
fn select_authenticated_receiving_address(
    default: &str,
    requested: Option<&str>,
    payments: &[Value],
) -> Result<String> {
    match requested {
        None => Ok(default.to_string()),
        Some(address) => {
            ensure!(
                payments.iter().any(|p| p["address"] == address
                    && p["ownershipEvidence"]["scheme"] == "zcash-full-transaction-ufvk-v3"),
                "receiving_address_not_authenticated"
            );
            Ok(address.to_string())
        }
    }
}
#[tokio::main]
async fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let c = Cli::parse();
    let result = match c.command {
        Command::SnapshotSummary => snapshot_summary(&c.wallet),
        Command::PreparePhase52Refund { profile_id } => {
            phase52_refund::prepare(&c.wallet, &profile_id).await
        }
        Command::ProbeProvider { server, height } => probe(&server, height).await,
        Command::ProbeMainnet {
            server,
            peer,
            height,
        } => probe_mainnet(&server, &peer, height).await,
        Command::VerifyHeader {
            header_file,
            expected_hash,
        } => verify_header_file(&header_file, &expected_hash),
        Command::VerifyBlock {
            block_file,
            expected_hash,
            height,
            txid,
        } => verify_block_file(&block_file, &expected_hash, height, txid.as_deref()),
        Command::Import {
            ufvk_file,
            birthday,
        } => import(&c.wallet, &ufvk_file, birthday).await,
        Command::Observe => observe(&c.wallet).await,
        Command::ImportMainnet {
            ufvk_file,
            birthday,
            server,
            peer,
        } => import_mainnet(&c.wallet, &ufvk_file, birthday, &server, &peer).await,
        Command::ObserveMainnet {
            server,
            peer,
            minimum_confirmations,
            checkpoint_height,
            authenticated_block_dir,
            candidate_block_dir,
            defer_missing_segments,
            receiving_address,
        } => {
            observe_mainnet(
                &c.wallet,
                &server,
                &peer,
                minimum_confirmations,
                checkpoint_height,
                MainnetBlockSources {
                    authenticated_block_dir: &authenticated_block_dir,
                    candidate_block_dirs: &candidate_block_dir,
                    defer_missing_segments,
                },
                receiving_address.as_deref(),
            )
            .await
        }
    };
    match result {
        Ok(v) => println!("{v}"),
        Err(e) => {
            eprintln!("watch_only_operation_failed: {e}");
            std::process::exit(1);
        }
    }
}

fn snapshot_summary(path: &Path) -> Result<Value> {
    let root = std::env::current_dir()?
        .join(".state/phase6c/snapshots")
        .canonicalize()?;
    let file = path.join("wallet.sqlite").canonicalize()?;
    ensure!(file.starts_with(&root), "snapshot_copy_required");
    ensure!(
        !path.join("seed.bin").exists(),
        "snapshot_must_not_contain_seed"
    );
    let conn =
        rusqlite::Connection::open_with_flags(&file, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let db = WalletDb::from_connection(conn, NET, SystemClock, rand::rng());
    let policy = zcash_client_backend::data_api::wallet::ConfirmationsPolicy::new_symmetrical(
        std::num::NonZeroU32::new(10).unwrap(),
        false,
    );
    let summary = db
        .get_wallet_summary(policy)?
        .context("snapshot_summary_unavailable")?;
    let mut total = 0u64;
    let mut available = 0u64;
    for balance in summary.account_balances().values() {
        total += balance.sapling_balance().total().into_u64()
            + balance.orchard_balance().total().into_u64()
            + balance.ironwood_balance().total().into_u64();
        available += balance.spendable_value().into_u64();
    }
    let conn =
        rusqlite::Connection::open_with_flags(file, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut stmt = conn.prepare("SELECT txid,mined_height,account_balance_delta,fee_paid,block_time,expired_unmined FROM v_transactions ORDER BY COALESCE(mined_height,2147483647) DESC LIMIT 30")?;
    let history = stmt.query_map([], |r| {
        let mut tx: Vec<u8> = r.get(0)?; tx.reverse();
        Ok(json!({"txid":hex::encode(tx),"height":r.get::<_,Option<u32>>(1)?,"deltaZatoshis":r.get::<_,i64>(2)?.to_string(),"feeZatoshis":r.get::<_,Option<u64>>(3)?.map(|v|v.to_string()),"time":r.get::<_,Option<u64>>(4)?,"expired":r.get::<_,Option<bool>>(5)?.unwrap_or(false)}))
    })?.collect::<Result<Vec<_>,_>>()?;
    Ok(
        json!({"network":"zcash-testnet","offlineSnapshot":true,"syncPerformed":false,"minimumConfirmations":10,"totalZatoshis":total.to_string(),"spendableZatoshis":available.to_string(),"tip":u32::from(summary.chain_tip_height()),"scanned":u32::from(summary.fully_scanned_height()),"observedAt":SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),"history":history}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_reader_rejects_original_wallet_without_opening_it() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("wallet.sqlite"), b"not-a-database").unwrap();
        let before = fs::read(d.path().join("wallet.sqlite")).unwrap();
        assert!(snapshot_summary(d.path()).is_err());
        assert_eq!(fs::read(d.path().join("wallet.sqlite")).unwrap(), before);
        assert!(!d.path().join("wallet.sqlite-wal").exists());
    }
    #[test]
    fn ufvk_import_reopens_without_seed_and_rejects_mainnet_key() {
        use rand::{Rng, rand_core::UnwrapErr, rngs::SysRng};
        use zcash_client_backend::data_api::{AccountSource, chain::ChainState};
        use zcash_keys::keys::UnifiedSpendingKey;
        use zcash_primitives::block::BlockHash;
        let mut seed = zeroize::Zeroizing::new([0u8; 32]);
        UnwrapErr(SysRng).fill_bytes(&mut *seed);
        let usk = UnifiedSpendingKey::from_seed(&NET, &*seed, 0u32.try_into().unwrap()).unwrap();
        let ufvk = usk.to_unified_full_viewing_key();
        let d = tempfile::tempdir().unwrap();
        let file = d.path().join("viewing-key.txt");
        fs::write(&file, ufvk.encode(&Network::MainNetwork).unwrap()).unwrap();
        assert!(viewing_key(&file).is_err());
        fs::write(&file, ufvk.encode(&NET).unwrap()).unwrap();
        let (view, _) = viewing_key(&file).unwrap();
        let mut db = database(d.path()).unwrap();
        let birth = AccountBirthday::from_parts(
            ChainState::empty(279999u32.into(), BlockHash([0; 32])),
            None,
        );
        let a = db
            .import_account_ufvk(
                "offline-ufvk-test",
                &view,
                &birth,
                AccountPurpose::Spending { derivation: None },
                None,
            )
            .unwrap();
        assert!(matches!(
            a.source(),
            AccountSource::Imported {
                purpose: AccountPurpose::Spending { derivation: None },
                ..
            }
        ));
        let id = a.id();
        drop(db);
        drop(usk);
        drop(seed);
        let db = database(d.path()).unwrap();
        assert_eq!(
            db.get_account(id)
                .unwrap()
                .unwrap()
                .ufvk()
                .unwrap()
                .encode(&NET)
                .unwrap(),
            view.encode(&NET).unwrap()
        );
        assert!(!d.path().join("seed.bin").exists());
    }
    #[test]
    fn refuses_legacy_or_secret_files_without_opening_database() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("seed.bin"), [0; 32]).unwrap();
        assert!(inspect_directory(d.path()).is_err());
        assert!(!d.path().join("wallet.sqlite").exists());
    }
    #[test]
    fn mainnet_import_rejects_historical_existing_and_symlinked_paths() {
        let d = tempfile::tempdir().unwrap();
        let fresh = d.path().join("fresh-mainnet-watch");
        assert!(ensure_external_new_directory(&fresh).is_ok());
        fs::create_dir(&fresh).unwrap();
        assert!(ensure_external_new_directory(&fresh).is_err());
        assert!(ensure_external_watch_directory(&fresh).is_ok());
        fs::create_dir(d.path().join(".secrets")).unwrap();
        fs::create_dir(d.path().join(".state")).unwrap();
        assert!(
            ensure_external_new_directory(&d.path().join(".secrets").join("new-watch")).is_err()
        );
        assert!(ensure_external_new_directory(&d.path().join(".state").join("new-watch")).is_err());
        assert!(ensure_external_watch_directory(&d.path().join(".state")).is_err());
        let file = d.path().join("viewing-key.txt");
        fs::write(&file, b"u1not-a-key").unwrap();
        assert!(ensure_external_file(&file).is_ok());
        let historical = d.path().join(".secrets").join("ufvk.txt");
        fs::write(&historical, b"u1not-a-key").unwrap();
        assert!(ensure_external_file(&historical).is_err());
    }
    #[test]
    fn mainnet_import_accepts_mainnet_ufvk_and_rejects_testnet_ufvk() {
        use rand::{Rng, rand_core::UnwrapErr, rngs::SysRng};
        use zcash_keys::keys::UnifiedSpendingKey;
        let mut seed = zeroize::Zeroizing::new([0u8; 32]);
        UnwrapErr(SysRng).fill_bytes(&mut *seed);
        let usk =
            UnifiedSpendingKey::from_seed(&MAIN_NET, &*seed, 0u32.try_into().unwrap()).unwrap();
        let d = tempfile::tempdir().unwrap();
        let file = d.path().join("viewing-key.txt");
        fs::write(
            &file,
            usk.to_unified_full_viewing_key().encode(&NET).unwrap(),
        )
        .unwrap();
        assert!(viewing_key_for(&file, &MAIN_NET, "mainnet").is_err());
        fs::write(
            &file,
            usk.to_unified_full_viewing_key().encode(&MAIN_NET).unwrap(),
        )
        .unwrap();
        let (view, id) = viewing_key_for(&file, &MAIN_NET, "mainnet").unwrap();
        assert!(view.orchard().is_some());
        assert_eq!(id.len(), 64);
    }
    #[test]
    fn malformed_or_mainnet_manifest_fails_closed() {
        let d = tempfile::tempdir().unwrap();
        fs::write(
            d.path().join("watch-only.json"),
            br#"{"version":1,"network":"zcash-mainnet","keyId":"a","birthday":1,"address":"x"}"#,
        )
        .unwrap();
        assert!(inspect_directory(d.path()).is_err());
        assert!(inspect_directory_for(d.path(), "zcash-mainnet").is_ok());
    }
    #[test]
    fn mainnet_provider_requires_https_and_rejects_testnet_or_private_hosts() {
        assert!(mainnet_provider("https://zec.example.org:443").is_ok());
        for value in [
            "http://zec.example.org:443",
            "https://localhost:443",
            "https://127.0.0.1:443",
            "https://192.168.1.2:443",
            "https://testnet.zec.rocks:443",
            "https://test.example.org",
            "",
        ] {
            assert!(mainnet_provider(value).is_err(), "{value}");
        }
    }
    #[tokio::test]
    async fn mainnet_scan_requires_distinct_providers_and_confirmations() {
        let d = tempfile::tempdir().unwrap();
        assert!(
            observe_mainnet(
                d.path(),
                "https://a.example.org",
                "https://a.example.org",
                10,
                None,
                sources(d.path(), &[]),
                None,
            )
            .await
            .is_err()
        );
        assert!(
            observe_mainnet(
                d.path(),
                "https://a.example.org",
                "https://b.example.org",
                0,
                None,
                sources(d.path(), &[]),
                None,
            )
            .await
            .is_err()
        );
    }
    #[tokio::test]
    async fn mainnet_observe_fails_closed_without_a_watch_profile() {
        let d = tempfile::tempdir().unwrap();
        let result = observe_mainnet(
            d.path(),
            "https://a.example.org",
            "https://b.example.org",
            20,
            None,
            sources(d.path(), &[]),
            None,
        )
        .await;
        assert!(result.is_err());
        assert_eq!(fs::read_dir(d.path()).unwrap().count(), 0);
    }

    fn sources<'a>(dir: &'a Path, candidates: &'a [PathBuf]) -> MainnetBlockSources<'a> {
        MainnetBlockSources {
            authenticated_block_dir: dir,
            candidate_block_dirs: candidates,
            defer_missing_segments: true,
        }
    }

    #[tokio::test]
    async fn mainnet_observe_rejects_missing_candidate_block_directory() {
        let d = tempfile::tempdir().unwrap();
        let missing = vec![d.path().join("not-created")];
        let error = observe_mainnet(
            d.path(),
            "https://a.example.org",
            "https://b.example.org",
            20,
            None,
            sources(d.path(), &missing),
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(error.to_string(), "candidate_block_directory_invalid");
        assert!(!missing[0].exists());
    }

    #[test]
    fn authenticated_block_lookup_prefers_corpus_then_candidate_segments() {
        let corpus = tempfile::tempdir().unwrap();
        let candidates = tempfile::tempdir().unwrap();
        let hash = "ab".repeat(32);
        let name = format!("100-{hash}.bin");
        fs::write(candidates.path().join(&name), b"candidate").unwrap();
        let dirs = [corpus.path(), candidates.path()];
        assert_eq!(
            locate_authenticated_block(&dirs, 100, &hash).unwrap(),
            candidates.path().join(&name)
        );
        fs::write(corpus.path().join(&name), b"corpus").unwrap();
        assert_eq!(
            locate_authenticated_block(&dirs, 100, &hash).unwrap(),
            corpus.path().join(&name)
        );
        // A file for another hash at the same height (a reorged block) is never used.
        let other = "cd".repeat(32);
        let error = locate_authenticated_block(&dirs, 100, &other).unwrap_err();
        let missing = error.downcast_ref::<MissingAuthenticatedBlock>().unwrap();
        assert_eq!(
            (missing.height, missing.hash.as_str()),
            (100, other.as_str())
        );
        assert_eq!(error.to_string(), "authenticated_mainnet_block_unavailable");
    }

    #[test]
    fn only_a_missing_raw_block_can_defer_a_candidate() {
        for error in [
            anyhow::anyhow!("mainnet_confirmation_provider_disagreement"),
            anyhow::anyhow!("mainnet_transaction_provider_disagreement"),
            anyhow::anyhow!("mainnet_owned_note_decryption_failed"),
            anyhow::anyhow!("file_too_large").context("authenticated_mainnet_block_unavailable"),
        ] {
            assert!(error.downcast_ref::<MissingAuthenticatedBlock>().is_none());
        }
        let source = include_str!("main.rs");
        assert!(source.contains(
            "let Some(missing) = error.downcast_ref::<MissingAuthenticatedBlock>() else {"
        ));
        assert!(source.contains("Err(error) => return Err(error),"));
        // Candidate-directory bytes take exactly the corpus verification path.
        assert!(
            source.contains(
                "let block_path = locate_authenticated_block(block_dirs, height, &hash)?;"
            )
        );
        assert!(source.contains(r#""verified":false,"evidence":"compact-scan-candidate""#));
    }

    #[test]
    fn confirmation_segment_is_bounded_by_tip_and_policy() {
        assert_eq!(confirmation_end(100, 100, 20).unwrap(), 100);
        assert_eq!(confirmation_end(100, 109, 20).unwrap(), 109);
        assert_eq!(confirmation_end(100, 119, 20).unwrap(), 119);
        assert_eq!(confirmation_end(100, 5000, 20).unwrap(), 119);
        assert!(confirmation_end(101, 100, 20).is_err());
        assert!(confirmation_end(100, 120, 0).is_err());
    }

    #[test]
    fn mainnet_owned_note_evidence_uses_fresh_full_transaction_decryption() {
        let source = include_str!("main.rs");
        assert!(source.contains("get_transaction(filter.clone())"));
        assert!(source.contains("get_transaction(filter)"));
        assert!(source.contains("get_block(service::BlockId"));
        assert!(source.contains("verify_full_block("));
        assert!(source.contains("authenticated_mainnet_block_unavailable"));
        assert!(source.contains("verify_confirmation_chain("));
        assert!(source.contains("mainnet_confirmation_provider_disagreement"));
        assert!(source.contains("mainnet_compact_block_provider_disagreement"));
        assert!(source.contains("decrypt_transaction("));
        assert!(source.contains("mainnet_owned_note_decryption_failed"));
    }

    #[test]
    fn receiving_address_selection_requires_a_verified_owned_note() {
        let default = "default-account-address";
        let note = json!({"address":"authenticated-note-address","ownershipEvidence":{"scheme":"zcash-full-transaction-ufvk-v3"}});
        assert_eq!(
            select_authenticated_receiving_address(default, None, &[]).unwrap(),
            default
        );
        assert_eq!(
            select_authenticated_receiving_address(
                default,
                Some("authenticated-note-address"),
                &[note.clone()]
            )
            .unwrap(),
            "authenticated-note-address"
        );
        assert!(
            select_authenticated_receiving_address(default, Some("unrelated-address"), &[note])
                .is_err()
        );
        assert!(select_authenticated_receiving_address(default, Some(default), &[]).is_err());
    }
}
