//! Testnet UFVK scanner. No seed import, spending key access, signing or broadcast API.
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
        m.version == 1 && m.network == "zcash-testnet",
        "watch_only_manifest"
    );
    Ok(m)
}
fn viewing_key(path: &Path) -> Result<(UnifiedFullViewingKey, String)> {
    ensure!(fs::metadata(path)?.len() <= 4096, "viewing_key_size");
    let s = fs::read_to_string(path)?;
    let s = s.trim();
    let k = UnifiedFullViewingKey::decode(&NET, s)
        .map_err(|_| anyhow::anyhow!("invalid_testnet_ufvk"))?;
    ensure!(k.orchard().is_some(), "orchard_viewing_key_required");
    Ok((k, hex::encode(Sha256::digest(s.as_bytes()))))
}
async fn connect() -> Result<CompactTxStreamerClient<Channel>> {
    connect_to(SERVER).await
}
async fn connect_to(server: &str) -> Result<CompactTxStreamerClient<Channel>> {
    ensure!(
        [
            SERVER,
            "https://lightwalletd.testnet.electriccoin.co:9067",
            "https://lwd.testnet.zec.pro:443"
        ]
        .contains(&server),
        "unreviewed_provider"
    );
    let channel = Channel::from_shared(server.to_owned())?
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(120))
        .tls_config(ClientTlsConfig::new().with_webpki_roots())?
        .connect()
        .await?;
    let mut c = CompactTxStreamerClient::new(channel);
    let i = c.get_lightd_info(service::Empty {}).await?.into_inner();
    ensure!(i.chain_name == "test", "wrong_network");
    let h = u32::try_from(i.block_height)?;
    ensure!(
        u32::from_str_radix(i.consensus_branch_id.trim_start_matches("0x"), 16)?
            == u32::from(BranchId::for_height(&NET, h.into())),
        "unsupported_consensus"
    );
    Ok(c)
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
async fn tree(c: &mut CompactTxStreamerClient<Channel>, height: u32) -> Result<service::TreeState> {
    let t = c
        .get_tree_state(service::BlockId {
            height: height.into(),
            hash: vec![],
        })
        .await?
        .into_inner();
    ensure!(
        t.network == "test" && t.height == u64::from(height),
        "wrong_tree_state"
    );
    Ok(t)
}
fn database(path: &Path) -> Result<Db> {
    let mut db = WalletDb::for_path(path.join("wallet.sqlite"), NET, SystemClock, rand::rng())?;
    init_wallet_db(&mut db, None)?;
    Ok(db)
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
#[tokio::main]
async fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let c = Cli::parse();
    let result = match c.command {
        Command::PreparePhase52Refund { profile_id } => {
            phase52_refund::prepare(&c.wallet, &profile_id).await
        }
        Command::ProbeProvider { server, height } => probe(&server, height).await,
        Command::Import {
            ufvk_file,
            birthday,
        } => import(&c.wallet, &ufvk_file, birthday).await,
        Command::Observe => observe(&c.wallet).await,
    };
    match result {
        Ok(v) => println!("{v}"),
        Err(e) => {
            eprintln!("watch_only_operation_failed: {e}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
    }
}
