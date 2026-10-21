//! Testnet and mainnet UFVK scanner. No seed import, spending key access, signing or broadcast API.
mod cache;
mod phase52_refund;
use anyhow::{Context, Result, ensure};
use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tonic::transport::{Channel, ClientTlsConfig};
use zcash_client_backend::{
    data_api::{
        Account, AccountBirthday, AccountPurpose, WalletCommitmentTrees, WalletRead, WalletWrite,
    },
    proto::service::{self, compact_tx_streamer_client::CompactTxStreamerClient},
};
use zcash_client_sqlite::{WalletDb, util::SystemClock, wallet::init::init_wallet_db};
use zcash_keys::keys::{UnifiedAddressRequest, UnifiedFullViewingKey};
use zcash_protocol::consensus::{BranchId, Network};
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
    let (key, id) = viewing_key_for(ufvk_file, &MAIN_NET, "mainnet")?;
    ensure!(!path.exists(), "new_directory_required");
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
async fn observe_mainnet(
    path: &Path,
    server: &str,
    peer: &str,
    minimum_confirmations: u32,
    checkpoint_height: Option<u32>,
) -> Result<Value> {
    ensure!(server != peer, "independent_mainnet_peer_required");
    ensure!(minimum_confirmations > 0, "invalid_confirmations");
    // sync::run performs genuine trial decryption, but exporting mutable SQL
    // rows does not re-establish per-note ownership/inclusion. Never present
    // those rows as mainnet settlement evidence until that verifier is audited.
    const MAINNET_NOTE_EVIDENCE_VALIDATED: bool = false;
    ensure!(
        MAINNET_NOTE_EVIDENCE_VALIDATED,
        "mainnet_owned_note_verifier_not_validated"
    );
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
    let mut stmt = conn.prepare("SELECT t.txid,r.pool,r.output_index,r.value,t.mined_height,b.hash,a.address,r.memo,COALESCE(sp.nf,op.nf,ip.nf),CASE WHEN sp.lock_owner IS NOT NULL OR op.lock_owner IS NOT NULL OR ip.lock_owner IS NOT NULL THEN 1 ELSE 0 END,(SELECT COUNT(*) FROM v_received_output_spends s WHERE s.pool=r.pool AND s.received_output_id=r.id_within_pool_table),r.is_change FROM v_received_outputs r JOIN transactions t ON t.id_tx=r.transaction_id JOIN blocks b ON b.height=t.mined_height JOIN addresses a ON a.id=r.address_id LEFT JOIN sapling_received_notes sp ON r.pool=2 AND sp.id=r.id_within_pool_table LEFT JOIN orchard_received_notes op ON r.pool=3 AND op.id=r.id_within_pool_table LEFT JOIN ironwood_received_notes ip ON r.pool=4 AND ip.id=r.id_within_pool_table WHERE r.pool IN (2,3,4) AND r.value>0 AND t.mined_height IS NOT NULL ORDER BY t.txid,r.pool,r.output_index")?;
    let payments = stmt
        .query_map([], |r| {
            let mut tx: Vec<u8> = r.get(0)?;
            tx.reverse();
            let mut block: Vec<u8> = r.get(5)?;
            block.reverse();
            let nf: Option<Vec<u8>> = r.get(8)?;
            let memo: Option<Vec<u8>> = r.get(7)?;
            let height: u32 = r.get(4)?;
            Ok(json!({"account":id,"txid":hex::encode(tx),"pool":r.get::<_,u32>(1)?,"index":r.get::<_,u32>(2)?,"zatoshis":r.get::<_,u64>(3)?.to_string(),"height":height,"blockHash":hex::encode(block),"address":r.get::<_,String>(6)?,"memo":memo.map(hex::encode),"nullifier":nf.map(hex::encode),"locked":r.get::<_,u32>(9)?!=0,"spent":r.get::<_,u32>(10)?!=0,"isChange":r.get::<_,u32>(11)?!=0,"confirmations":tip.checked_sub(height).map(|d|d+1)}))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(
        json!({"network":"zcash-mainnet","watchOnly":true,"liveChain":true,"liveRefundsEnabled":false,"source":server,"peerSource":peer,"account":id,"address":manifest.address,"birthday":manifest.birthday,"tip":tip,"scanned":tip,"blockHash":hex::encode(hash),"observedAt":SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),"minimumConfirmations":minimum_confirmations,"anchor":hex::encode(anchor.to_bytes()),"anchorHeight":anchor_height,"checkpoint":checkpoint_value,"payments":payments}),
    )
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
        } => {
            observe_mainnet(
                &c.wallet,
                &server,
                &peer,
                minimum_confirmations,
                checkpoint_height,
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
                None
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
                None
            )
            .await
            .is_err()
        );
    }
    #[tokio::test]
    async fn mainnet_owned_note_gate_precedes_wallet_or_network_access() {
        let d = tempfile::tempdir().unwrap();
        let result = observe_mainnet(
            d.path(),
            "https://a.example.org",
            "https://b.example.org",
            20,
            None,
        )
        .await;
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("mainnet_owned_note_verifier_not_validated")
        );
        assert_eq!(fs::read_dir(d.path()).unwrap().count(), 0);
    }
}
