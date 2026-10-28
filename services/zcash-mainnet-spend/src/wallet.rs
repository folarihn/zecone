//! Mainnet shielded wallet: provider-checked initialization, synchronization,
//! spendability, proposal, offline proving/signing, and authenticated lookup.
use anyhow::{Context, Result, anyhow, bail, ensure};
use rand::{
    SeedableRng,
    rngs::{StdRng, SysRng},
};
use secrecy::{ExposeSecret, SecretVec};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{io::Cursor, num::NonZeroUsize, path::Path};
use tonic::transport::{Channel, ClientTlsConfig};
use zcash_client_backend::{
    data_api::{
        Account, AccountBirthday, WalletRead, WalletWrite,
        wallet::{
            ConfirmationsPolicy, SpendingKeys, create_proposed_transactions,
            input_selection::{GreedyInputSelector, SpendPolicy},
            propose_transfer,
        },
    },
    fees::{DustOutputPolicy, SplitPolicy, StandardFeeRule, standard::MultiOutputChangeStrategy},
    proposal::Proposal,
    proto::service::{self, TreeState, compact_tx_streamer_client::CompactTxStreamerClient},
    wallet::OvkPolicy,
};
use zcash_client_sqlite::{
    ReceivedNoteId, WalletDb, util::SystemClock, wallet::init::init_wallet_db,
};
use zcash_keys::{
    address::{Address, UnifiedAddress},
    keys::{UnifiedFullViewingKey, UnifiedSpendingKey},
};
use zcash_primitives::transaction::Transaction;
use zcash_protocol::TxId;
use zcash_protocol::{
    ShieldedPool,
    consensus::{BranchId, Network},
    value::Zatoshis,
};

use crate::{cache::Cache, keystore};

const NET: Network = Network::MainNetwork;
const MIN_CONFIRMATIONS: u32 = 20;
type Db = WalletDb<rusqlite::Connection, Network, SystemClock, rand::rngs::ThreadRng>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreparedTransaction {
    pub recipient: String,
    pub zatoshis: u64,
    pub fee_zatoshis: u64,
    pub max_fee_zatoshis: u64,
    pub change_zatoshis: u64,
    pub change_destination: String,
    pub input_total_zatoshis: u64,
    pub inputs: Vec<PreparedInput>,
    pub anchor_height: u32,
    pub target_height: u32,
    pub expiry_height: u32,
    pub account_fingerprint: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreparedInput {
    pub txid: String,
    pub pool: String,
    pub output_index: u16,
    pub zatoshis: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FinalizedFundingSpend {
    pub txid: String,
    pub mined_height: u32,
    pub selected_notes: Vec<PreparedInput>,
    pub change_zatoshis: u64,
}

#[derive(Clone, Debug)]
pub struct ProviderAgreement {
    pub common_height: u32,
    pub block_hash: String,
    pub primary_tip: u32,
    pub peer_tip: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TransactionObservation {
    pub status: String,
    pub mined_height: Option<u32>,
    pub common_tip: u32,
    pub authenticated_block_hash: Option<String>,
    pub provider_agreement: bool,
}

#[derive(Clone)]
pub struct ConstructedTransaction {
    pub txid: String,
    pub signed_digest: String,
    pub fee_zatoshis: u64,
    pub expiry_height: u32,
    pub serialized_bytes: usize,
    /// Secret-bearing only in the sense that it is an immediately submit-able
    /// signed transaction. Callers must encrypt it durably and never log it.
    pub raw: zeroize::Zeroizing<Vec<u8>>,
}

pub async fn connect(server: &str) -> Result<CompactTxStreamerClient<Channel>> {
    ensure!(server.starts_with("https://"), "TLS is required");
    let channel = Channel::from_shared(server.to_string())?
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(120))
        .tls_config(ClientTlsConfig::new().with_webpki_roots())?
        .connect()
        .await?;
    let mut client = CompactTxStreamerClient::new(channel);
    validate_server(&mut client).await?;
    Ok(client)
}

async fn validate_server(client: &mut CompactTxStreamerClient<Channel>) -> Result<u32> {
    let info = client
        .get_lightd_info(service::Empty {})
        .await?
        .into_inner();
    ensure!(
        info.chain_name == "main",
        "lightwalletd is not Zcash mainnet"
    );
    let height = u32::try_from(info.block_height).context("chain height")?;
    let expected = u32::from(zcash_protocol::consensus::BranchId::for_height(
        &NET,
        height.into(),
    ));
    let actual = u32::from_str_radix(info.consensus_branch_id.trim_start_matches("0x"), 16)
        .context("consensus branch")?;
    ensure!(
        actual == expected,
        "unsupported mainnet consensus: server {actual:08x}, library {expected:08x}"
    );
    Ok(height)
}

async fn tree(client: &mut CompactTxStreamerClient<Channel>, height: u32) -> Result<TreeState> {
    let state = client
        .get_tree_state(service::BlockId {
            height: u64::from(height),
            hash: vec![],
        })
        .await?
        .into_inner();
    ensure!(state.network == "main", "tree state is not mainnet");
    ensure!(
        state.height == u64::from(height),
        "tree state height mismatch"
    );
    Ok(state)
}

fn same_tree(a: &TreeState, b: &TreeState) -> bool {
    a.height == b.height
        && a.hash == b.hash
        && a.sapling_tree == b.sapling_tree
        && a.orchard_tree == b.orchard_tree
        && a.ironwood_tree == b.ironwood_tree
}

pub async fn provider_agreement(primary: &str, peer: &str) -> Result<ProviderAgreement> {
    ensure!(primary != peer, "independent mainnet peer required");
    let (mut a, mut b) = tokio::try_join!(connect(primary), connect(peer))?;
    let (a_tip, b_tip) = tokio::try_join!(validate_server(&mut a), validate_server(&mut b))?;
    let common = a_tip.min(b_tip);
    let (a_tree, b_tree) = tokio::try_join!(tree(&mut a, common), tree(&mut b, common))?;
    ensure!(
        same_tree(&a_tree, &b_tree),
        "mainnet provider disagreement at {common}"
    );
    Ok(ProviderAgreement {
        common_height: common,
        block_hash: a_tree.hash,
        primary_tip: a_tip,
        peer_tip: b_tip,
    })
}

/// Queries both independent providers for the same transaction. A mined result
/// is accepted only when both providers report the same height and the full
/// authenticated tree state at that height agrees.
pub async fn observe_transaction(
    primary: &str,
    peer: &str,
    txid: &str,
) -> Result<TransactionObservation> {
    ensure!(primary != peer, "independent mainnet peer required");
    let txid = TxId::from_hex(txid).context("invalid transaction id")?;
    let (mut a, mut b) = tokio::try_join!(connect(primary), connect(peer))?;
    let (a_tip, b_tip) = tokio::try_join!(validate_server(&mut a), validate_server(&mut b))?;
    let common_tip = a_tip.min(b_tip);
    let filter = service::TxFilter {
        block: None,
        index: 0,
        hash: txid.as_ref().to_vec(),
    };
    async fn lookup(
        client: &mut CompactTxStreamerClient<Channel>,
        filter: service::TxFilter,
        expected_txid: TxId,
        consensus_height: u32,
    ) -> Result<Option<u64>> {
        match client.get_transaction(filter).await {
            Ok(response) => {
                let raw = response.into_inner();
                validate_observed_raw(&raw.data, expected_txid, consensus_height)?;
                Ok(Some(raw.height))
            }
            Err(status) if status.code() == tonic::Code::NotFound => Ok(None),
            Err(status) => Err(status.into()),
        }
    }
    let (left, right) = tokio::try_join!(
        lookup(&mut a, filter.clone(), txid, common_tip),
        lookup(&mut b, filter, txid, common_tip)
    )?;
    if !provider_locations_agree(left, right) {
        return Ok(TransactionObservation {
            status: "PROVIDER_DISAGREEMENT".into(),
            mined_height: None,
            common_tip,
            authenticated_block_hash: None,
            provider_agreement: false,
        });
    }
    match (left, right) {
        (Some(l), Some(r)) if l == r && l == 0 => Ok(TransactionObservation {
            status: "MEMPOOL".into(),
            mined_height: None,
            common_tip,
            authenticated_block_hash: None,
            provider_agreement: true,
        }),
        (Some(l), Some(r)) if l == r && l == u64::MAX => Ok(TransactionObservation {
            status: "REORGANIZED".into(),
            mined_height: None,
            common_tip,
            authenticated_block_hash: None,
            provider_agreement: true,
        }),
        (Some(l), Some(r)) if l == r => {
            let height = u32::try_from(l).context("mined height overflow")?;
            ensure!(
                height <= common_tip,
                "provider reported a future mined height"
            );
            let (ta, tb) = tokio::try_join!(tree(&mut a, height), tree(&mut b, height))?;
            ensure!(
                same_tree(&ta, &tb),
                "provider chain disagreement at mined height"
            );
            Ok(TransactionObservation {
                status: "MINED".into(),
                mined_height: Some(height),
                common_tip,
                authenticated_block_hash: Some(ta.hash),
                provider_agreement: true,
            })
        }
        (None, None) => Ok(TransactionObservation {
            status: "UNKNOWN".into(),
            mined_height: None,
            common_tip,
            authenticated_block_hash: None,
            provider_agreement: true,
        }),
        _ => unreachable!("provider locations were checked above"),
    }
}

fn provider_locations_agree(left: Option<u64>, right: Option<u64>) -> bool {
    left == right
}

fn validate_observed_raw(data: &[u8], expected_txid: TxId, consensus_height: u32) -> Result<()> {
    ensure!(!data.is_empty(), "provider returned an empty transaction");
    let mut cursor = Cursor::new(data);
    let transaction = Transaction::read(
        &mut cursor,
        BranchId::for_height(&NET, consensus_height.into()),
    )
    .context("provider returned invalid transaction encoding")?;
    ensure!(
        usize::try_from(cursor.position())? == data.len(),
        "provider returned trailing transaction bytes"
    );
    ensure!(
        transaction.txid() == expected_txid,
        "provider returned the wrong transaction"
    );
    Ok(())
}

fn db(path: &Path) -> Result<Db> {
    ensure!(
        std::fs::read_to_string(path.join("network"))? == "zcash-mainnet",
        "wallet is not mainnet"
    );
    Ok(WalletDb::for_path(
        path.join("wallet.sqlite"),
        NET,
        SystemClock,
        rand::rng(),
    )?)
}

fn derive_usk(seed: &SecretVec<u8>) -> Result<UnifiedSpendingKey> {
    UnifiedSpendingKey::from_seed(&NET, seed.expose_secret(), 0u32.try_into().unwrap())
        .map_err(|_| anyhow!("spending key derivation failed"))
}

fn verify_identity(
    seed: &SecretVec<u8>,
    expected_account: &str,
    expected_address: &str,
) -> Result<keystore::Identity> {
    let identity = keystore::identity(seed.expose_secret())?;
    ensure!(
        identity.account == expected_account,
        "wallet account fingerprint mismatch"
    );
    ensure!(
        keystore::address_belongs_to_seed(seed.expose_secret(), expected_address)?,
        "watcher receiving address does not belong to spending identity"
    );
    Ok(identity)
}

/// Initialize the wallet from a genuine, independently agreed birthday tree.
/// Existing wallets are never re-created; their UFVK, birthday, and address are
/// reconciled against the unlocked seed on every open.
pub async fn open_wallet(
    path: &Path,
    seed: &SecretVec<u8>,
    birthday_prior_height: u32,
    expected_account: &str,
    expected_address: &str,
    primary: &str,
    peer: &str,
) -> Result<Value> {
    let identity = verify_identity(seed, expected_account, expected_address)?;
    std::fs::create_dir_all(path)?;
    let marker = path.join("network");
    if marker.exists() {
        ensure!(
            std::fs::read_to_string(&marker)? == "zcash-mainnet",
            "wallet is not mainnet"
        );
    } else {
        write_new(&marker, b"zcash-mainnet")?;
    }
    let mut wallet = db(path)?;
    init_wallet_db(&mut wallet, None)?;
    let ids = wallet.get_account_ids()?;
    if ids.is_empty() {
        let (mut a, mut b) = tokio::try_join!(connect(primary), connect(peer))?;
        let (ta, tb) = tokio::try_join!(
            tree(&mut a, birthday_prior_height),
            tree(&mut b, birthday_prior_height)
        )?;
        ensure!(same_tree(&ta, &tb), "birthday provider disagreement");
        let birthday = AccountBirthday::from_treestate(ta, None)?;
        wallet.create_account("mainnet-receiver", seed, &birthday, None)?;
    }
    let ids = wallet.get_account_ids()?;
    ensure!(ids.len() == 1, "unexpected account count");
    let account = wallet.get_account(ids[0])?.context("account missing")?;
    ensure!(
        u32::from(account.birthday_height()) == birthday_prior_height + 1,
        "wallet birthday mismatch"
    );
    let stored = account.ufvk().context("wallet account has no UFVK")?;
    let stored_encoded = stored.encode(&NET)?;
    ensure!(
        hex::encode(Sha256::digest(stored_encoded.as_bytes())) == expected_account,
        "stored wallet fingerprint mismatch"
    );
    let usk = derive_usk(seed)?;
    ensure!(
        usk.to_unified_full_viewing_key().encode(&NET)? == stored_encoded,
        "stored wallet UFVK does not match spending seed"
    );
    Ok(json!({
        "network": "zcash-mainnet",
        "account": identity.account,
        "watcherAddressVerified": true,
        "birthdayPriorHeight": birthday_prior_height,
        "broadcast": false,
    }))
}

/// Synchronize with one provider, then pin the resulting height against an
/// independent provider. Legitimate tip skew is allowed; a hash/tree mismatch
/// at the exact scanned height fails closed.
pub async fn sync(path: &Path, primary: &str, peer: &str) -> Result<Value> {
    let before = provider_agreement(primary, peer).await?;
    let mut wallet = db(path)?;
    let mut client = connect(primary).await?;
    zcash_client_backend::sync::run(&mut client, &NET, &Cache::default(), &mut wallet, 1000)
        .await?;
    let tip = wallet.chain_height()?.context("chain tip missing")?;
    let scanned = wallet.block_fully_scanned()?.context("scan missing")?;
    ensure!(scanned.block_height() == tip, "wallet scan is incomplete");
    let scanned_height = u32::from(scanned.block_height());
    drop(wallet);

    // The primary can advance while the peer is a block behind. Pin the
    // already-scanned height and give the peer a bounded opportunity to expose
    // that same state; never compare different heights or mask a tree mismatch.
    let mut verified = None;
    for attempt in 0..=6 {
        let (mut a, mut b) = tokio::try_join!(connect(primary), connect(peer))?;
        let (a_tip, b_tip) = tokio::try_join!(validate_server(&mut a), validate_server(&mut b))?;
        if a_tip >= scanned_height && b_tip >= scanned_height {
            let (ta, tb) =
                tokio::try_join!(tree(&mut a, scanned_height), tree(&mut b, scanned_height))?;
            ensure!(
                same_tree(&ta, &tb),
                "mainnet provider disagreement after sync"
            );
            verified = Some((ta, a_tip, b_tip));
            break;
        }
        ensure!(attempt < 6, "provider has not reached scanned height");
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
    let (ta, a_tip, b_tip) = verified.context("provider catch-up verification missing")?;
    Ok(json!({
        "network": "zcash-mainnet",
        "tip": scanned_height,
        "scanned": scanned_height,
        "blockHash": ta.hash,
        "providerAgreement": "PASS",
        "preflightCommonHeight": before.common_height,
        "preflightBlockHash": before.block_hash,
        "preflightPrimaryTip": before.primary_tip,
        "preflightPeerTip": before.peer_tip,
        "primaryTip": a_tip,
        "peerTip": b_tip,
    }))
}

/// List non-change notes and their durable spent/nullifier status.
pub fn notes(path: &Path) -> Result<Value> {
    let conn = rusqlite::Connection::open_with_flags(
        path.join("wallet.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let mut stmt = conn.prepare(
        "SELECT t.txid, r.pool, r.output_index, r.value, t.mined_height,
                (SELECT COUNT(*) FROM v_received_output_spends s
                 WHERE s.pool=r.pool AND s.received_output_id=r.id_within_pool_table) AS spend_count
         FROM v_received_outputs r JOIN transactions t ON t.id_tx=r.transaction_id
         WHERE r.value>0 AND r.is_change=0 ORDER BY t.mined_height,r.pool,r.output_index",
    )?;
    let rows = stmt.query_map([], |r| {
        let mut txid: Vec<u8> = r.get(0)?;
        txid.reverse();
        let spent: u32 = r.get(5)?;
        Ok(json!({
            "txid": hex::encode(txid),
            "pool": r.get::<_, u32>(1)?,
            "index": r.get::<_, u32>(2)?,
            "zatoshis": r.get::<_, u64>(3)?.to_string(),
            "height": r.get::<_, Option<u32>>(4)?,
            "spent": spent > 0,
        }))
    })?;
    let values = rows.collect::<Result<Vec<_>, _>>()?;
    let mut keys = std::collections::HashSet::new();
    for row in &values {
        let key = format!("{}:{}:{}", row["txid"], row["pool"], row["index"]);
        ensure!(keys.insert(key), "duplicate received note");
    }
    Ok(Value::Array(values))
}

pub fn summary(path: &Path) -> Result<Value> {
    let wallet = db(path)?;
    let s = wallet
        .get_wallet_summary(ConfirmationsPolicy::default())?
        .context("summary unavailable")?;
    let mut total = 0u64;
    let mut spendable = 0u64;
    for balance in s.account_balances().values() {
        total += balance.sapling_balance().total().into_u64()
            + balance.orchard_balance().total().into_u64()
            + balance.ironwood_balance().total().into_u64();
        spendable += balance.spendable_value().into_u64();
    }
    Ok(json!({
        "network": "zcash-mainnet",
        "tip": u32::from(s.chain_tip_height()),
        "scanned": u32::from(s.fully_scanned_height()),
        "totalZatoshis": total.to_string(),
        "spendableZatoshis": spendable.to_string(),
    }))
}

/// Sanitized projection for the paired local browser. This deliberately opens
/// only the viewing database: it accepts no keystore, seed, approval, signer,
/// proposal, or broadcaster configuration.
pub fn browser_view(path: &Path, expected_account: &str, expected_address: &str) -> Result<Value> {
    ensure!(
        expected_account.len() == 64 && expected_account.bytes().all(|b| b.is_ascii_hexdigit()),
        "invalid expected account fingerprint"
    );
    let wallet = db(path)?;
    let ids = wallet.get_account_ids()?;
    ensure!(ids.len() == 1, "unexpected account count");
    let account = wallet.get_account(ids[0])?.context("account missing")?;
    let ufvk = account.ufvk().context("wallet account has no UFVK")?;
    let address = validate_browser_identity(ufvk, expected_account, expected_address)?;
    drop(wallet);

    let summary = summary(path)?;
    let history = wallet_history(path)?;
    let observed_at = std::fs::metadata(path.join("wallet.sqlite"))?
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs();
    Ok(json!({
        "network": "zcash-mainnet",
        "mode": "READ_ONLY",
        "receivingAddress": expected_address,
        "accountFingerprint": expected_account.to_ascii_lowercase(),
        "addressStandard": "ZIP-316",
        "receivers": {
            "orchard": address.orchard().is_some(),
            "sapling": address.sapling().is_some(),
            "transparent": address.transparent().is_some(),
            "unknownTypecodes": address.unknown().iter().map(|(t, _)| *t).collect::<Vec<_>>(),
        },
        "summary": {
            "totalZatoshis": summary["totalZatoshis"],
            "spendableZatoshis": summary["spendableZatoshis"],
            "tip": summary["tip"],
            "scanned": summary["scanned"],
            "observedAt": observed_at,
            "history": history,
        },
        "sync": {
            "tip": summary["tip"],
            "scanned": summary["scanned"],
            "complete": summary["tip"] == summary["scanned"],
            "source": "verified-mainnet-wallet-database",
        },
        "capabilities": {
            "receive": true,
            "balance": true,
            "history": true,
            "sign": false,
            "broadcast": false,
        },
        "sendUnavailableReason": "Mainnet browser signing and broadcasting are disabled pending approval-flow integration.",
        "secretMaterialLoaded": false,
        "broadcast": false,
    }))
}

fn wallet_history(path: &Path) -> Result<Vec<Value>> {
    let conn = rusqlite::Connection::open_with_flags(
        path.join("wallet.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let mut stmt = conn.prepare(
        "SELECT t.txid,t.mined_height,t.fee,
          (SELECT COALESCE(SUM(r.value),0) FROM v_received_outputs r
             WHERE r.transaction_id=t.id_tx) AS received,
          (SELECT COALESCE(SUM(prior.value),0)
             FROM v_received_output_spends s
             JOIN v_received_outputs prior
               ON prior.pool=s.pool AND prior.id_within_pool_table=s.received_output_id
            WHERE s.transaction_id=t.id_tx) AS spent
         FROM transactions t
         WHERE t.mined_height IS NOT NULL
         ORDER BY t.mined_height DESC,t.id_tx DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        let mut txid: Vec<u8> = row.get(0)?;
        txid.reverse();
        let received: i64 = row.get(3)?;
        let spent: i64 = row.get(4)?;
        Ok(json!({
            "txid": hex::encode(txid),
            "height": row.get::<_, Option<u32>>(1)?,
            "deltaZatoshis": (received - spent).to_string(),
            "feeZatoshis": row.get::<_, Option<u64>>(2)?.map(|v| v.to_string()),
            "time": Value::Null,
            "expired": false,
        }))
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn validate_browser_identity(
    ufvk: &UnifiedFullViewingKey,
    expected_account: &str,
    expected_address: &str,
) -> Result<UnifiedAddress> {
    let encoded = ufvk.encode(&NET)?;
    ensure!(
        hex::encode(Sha256::digest(encoded.as_bytes())).eq_ignore_ascii_case(expected_account),
        "stored wallet fingerprint mismatch"
    );
    let address = UnifiedAddress::decode(&NET, expected_address)
        .map_err(|_| anyhow!("invalid ZIP-316 mainnet unified address"))?;
    ensure!(
        address.orchard().is_some() || address.sapling().is_some(),
        "shielded receiver required"
    );
    ensure!(
        !ufvk
            .to_unified_incoming_viewing_key()
            .decrypt_diversifiers(&address)
            .is_empty(),
        "receiving address does not belong to stored wallet identity"
    );
    Ok(address)
}

pub fn verify_expected_deposit(
    path: &Path,
    txid: &str,
    pool: u32,
    index: u32,
    zatoshis: u64,
    mined_height: u32,
) -> Result<Value> {
    let tip = summary(path)?["tip"].as_u64().context("tip missing")? as u32;
    let list = notes(path)?;
    verify_note_rows(&list, tip, txid, pool, index, zatoshis, mined_height)
}

/// Returns the exact expected note's current spent state without assuming the
/// answer. Preparation separately proves that any selected change descends
/// from this authenticated deposit through finalized journal entries.
pub fn expected_deposit_status(
    path: &Path,
    txid: &str,
    pool: u32,
    index: u32,
    zatoshis: u64,
    mined_height: u32,
) -> Result<Value> {
    let tip = summary(path)?["tip"].as_u64().context("tip missing")? as u32;
    let list = notes(path)?;
    let expected_zatoshis = zatoshis.to_string();
    let matches: Vec<&Value> = list
        .as_array()
        .context("notes are not an array")?
        .iter()
        .filter(|n| {
            n["txid"] == txid
                && n["pool"] == pool
                && n["index"] == index
                && n["zatoshis"].as_str() == Some(expected_zatoshis.as_str())
                && n["height"] == mined_height
        })
        .collect();
    ensure!(
        matches.len() == 1,
        "expected deposit not found exactly once"
    );
    let confirmations = tip.saturating_sub(mined_height) + 1;
    ensure!(
        confirmations >= MIN_CONFIRMATIONS,
        "insufficient confirmations"
    );
    Ok(json!({
        "txid": txid, "pool": pool, "index": index, "zatoshis": zatoshis.to_string(),
        "height": mined_height, "confirmations": confirmations,
        "spent": matches[0]["spent"], "verified": true,
    }))
}

fn txid_display(mut bytes: Vec<u8>) -> String {
    bytes.reverse();
    hex::encode(bytes)
}

fn funding_rows(path: &Path) -> Result<Value> {
    let conn = rusqlite::Connection::open_with_flags(
        path.join("wallet.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let mut stmt = conn.prepare(
        "SELECT t.txid,t.mined_height,r.pool,r.output_index,r.value,r.is_change,
                (SELECT st.txid FROM v_received_output_spends s
                  JOIN transactions st ON st.id_tx=s.transaction_id
                 WHERE s.pool=r.pool AND s.received_output_id=r.id_within_pool_table)
         FROM v_received_outputs r JOIN transactions t ON t.id_tx=r.transaction_id
         WHERE r.value>0 ORDER BY t.mined_height,r.pool,r.output_index",
    )?;
    let rows = stmt.query_map([], |row| {
        let txid = txid_display(row.get(0)?);
        let spent_by = row.get::<_, Option<Vec<u8>>>(6)?.map(txid_display);
        Ok(json!({
            "txid": txid,
            "height": row.get::<_, Option<u32>>(1)?,
            "pool": row.get::<_, u32>(2)?,
            "index": row.get::<_, u16>(3)?,
            "zatoshis": row.get::<_, u64>(4)?.to_string(),
            "change": row.get::<_, bool>(5)?,
            "spentBy": spent_by,
        }))
    })?;
    Ok(Value::Array(rows.collect::<Result<Vec<_>, _>>()?))
}

fn funding_key(txid: &str, pool: &str, index: u16) -> String {
    format!("{}:{}:{}", txid.to_ascii_lowercase(), pool, index)
}

fn funding_pool(pool: u32) -> Result<&'static str> {
    match pool {
        2 => Ok("sapling"),
        3 => Ok("orchard"),
        4 => Ok("ironwood"),
        _ => bail!("unsupported funding pool"),
    }
}

fn verify_funding_rows(
    rows: &Value,
    tip: u32,
    finalized: &[FinalizedFundingSpend],
    selected: &[PreparedInput],
    deposit_txid: &str,
    deposit_pool: u32,
    deposit_index: u16,
    deposit_zatoshis: u64,
    deposit_height: u32,
) -> Result<Value> {
    let rows = rows.as_array().context("funding rows are not an array")?;
    let mut by_key = std::collections::HashMap::<String, &Value>::new();
    for row in rows {
        let key = funding_key(
            row["txid"].as_str().context("funding txid missing")?,
            funding_pool(row["pool"].as_u64().context("funding pool missing")? as u32)?,
            u16::try_from(row["index"].as_u64().context("funding index missing")?)?,
        );
        ensure!(
            by_key.insert(key, row).is_none(),
            "duplicate funding output"
        );
    }

    let deposit_key = funding_key(deposit_txid, funding_pool(deposit_pool)?, deposit_index);
    let deposit = by_key
        .get(&deposit_key)
        .context("authenticated deposit output missing")?;
    ensure!(
        deposit["zatoshis"].as_str() == Some(&deposit_zatoshis.to_string()),
        "authenticated deposit value mismatch"
    );
    ensure!(
        deposit["height"] == deposit_height,
        "authenticated deposit height mismatch"
    );
    ensure!(
        deposit["change"] == false,
        "authenticated deposit marked as change"
    );
    ensure!(
        tip.saturating_sub(deposit_height) + 1 >= MIN_CONFIRMATIONS,
        "authenticated deposit has insufficient confirmations"
    );

    let mut authorized = std::collections::HashSet::from([deposit_key]);
    let mut finalized = finalized.to_vec();
    finalized.sort_by_key(|spend| spend.mined_height);
    let mut finalized_txids = std::collections::HashSet::new();
    for spend in finalized {
        ensure!(
            finalized_txids.insert(spend.txid.to_ascii_lowercase()),
            "duplicate finalized funding transaction"
        );
        ensure!(
            tip.saturating_sub(spend.mined_height) + 1 >= MIN_CONFIRMATIONS,
            "finalized funding transaction has insufficient confirmations"
        );
        for input in &spend.selected_notes {
            let key = funding_key(&input.txid, &input.pool, input.output_index);
            ensure!(
                authorized.contains(&key),
                "unrelated note entered funding lineage"
            );
            let row = by_key
                .get(&key)
                .context("finalized input missing from wallet")?;
            ensure!(
                row["zatoshis"].as_str() == Some(&input.zatoshis.to_string()),
                "finalized input value mismatch"
            );
            ensure!(
                row["spentBy"]
                    .as_str()
                    .is_some_and(|txid| txid.eq_ignore_ascii_case(&spend.txid)),
                "finalized transaction does not spend its reviewed input"
            );
        }
        let change = rows
            .iter()
            .filter(|row| {
                row["change"] == true
                    && row["txid"]
                        .as_str()
                        .is_some_and(|txid| txid.eq_ignore_ascii_case(&spend.txid))
            })
            .collect::<Vec<_>>();
        ensure!(
            !change.is_empty(),
            "finalized transaction change is missing"
        );
        let change_total = change.iter().try_fold(0u64, |sum, row| {
            sum.checked_add(
                row["zatoshis"]
                    .as_str()
                    .context("change value missing")?
                    .parse::<u64>()?,
            )
            .context("change value overflow")
        })?;
        ensure!(
            change_total == spend.change_zatoshis,
            "finalized change value mismatch"
        );
        for row in change {
            ensure!(
                row["height"] == spend.mined_height,
                "finalized change height mismatch"
            );
            authorized.insert(funding_key(
                row["txid"].as_str().context("change txid missing")?,
                funding_pool(row["pool"].as_u64().context("change pool missing")? as u32)?,
                u16::try_from(row["index"].as_u64().context("change index missing")?)?,
            ));
        }
    }

    ensure!(!selected.is_empty(), "proposal has no funding inputs");
    let mut selected_total = 0u64;
    for input in selected {
        let key = funding_key(&input.txid, &input.pool, input.output_index);
        ensure!(
            authorized.contains(&key),
            "proposal selected an unrelated deposit"
        );
        let row = by_key
            .get(&key)
            .context("proposal input missing from wallet")?;
        ensure!(
            row["zatoshis"].as_str() == Some(&input.zatoshis.to_string()),
            "proposal input value mismatch"
        );
        ensure!(row["spentBy"].is_null(), "proposal input is already spent");
        let height = u32::try_from(
            row["height"]
                .as_u64()
                .context("proposal input height missing")?,
        )?;
        ensure!(
            tip.saturating_sub(height) + 1 >= MIN_CONFIRMATIONS,
            "proposal input has insufficient confirmations"
        );
        selected_total = selected_total
            .checked_add(input.zatoshis)
            .context("selected input total overflow")?;
    }
    Ok(json!({
        "authenticatedDeposit": deposit_txid,
        "finalizedDescendants": finalized_txids.len(),
        "selectedInputs": selected.len(),
        "selectedZatoshis": selected_total.to_string(),
        "verified": true,
    }))
}

pub fn verify_funding_lineage(
    path: &Path,
    finalized: &[FinalizedFundingSpend],
    selected: &[PreparedInput],
    deposit_txid: &str,
    deposit_pool: u32,
    deposit_index: u16,
    deposit_zatoshis: u64,
    deposit_height: u32,
) -> Result<Value> {
    let tip = summary(path)?["tip"].as_u64().context("tip missing")? as u32;
    verify_funding_rows(
        &funding_rows(path)?,
        tip,
        finalized,
        selected,
        deposit_txid,
        deposit_pool,
        deposit_index,
        deposit_zatoshis,
        deposit_height,
    )
}

fn verify_note_rows(
    list: &Value,
    tip: u32,
    txid: &str,
    pool: u32,
    index: u32,
    zatoshis: u64,
    mined_height: u32,
) -> Result<Value> {
    let expected_zatoshis = zatoshis.to_string();
    let matches: Vec<&Value> = list
        .as_array()
        .context("notes are not an array")?
        .iter()
        .filter(|n| {
            n["txid"] == txid
                && n["pool"] == pool
                && n["index"] == index
                && n["zatoshis"].as_str() == Some(expected_zatoshis.as_str())
                && n["height"] == mined_height
        })
        .collect();
    ensure!(
        matches.len() == 1,
        "expected deposit not found exactly once"
    );
    ensure!(
        matches[0]["spent"] == false,
        "expected deposit is already spent"
    );
    let confirmations = tip.saturating_sub(mined_height) + 1;
    ensure!(
        confirmations >= MIN_CONFIRMATIONS,
        "insufficient confirmations"
    );
    Ok(json!({
        "txid": txid,
        "pool": pool,
        "index": index,
        "zatoshis": zatoshis.to_string(),
        "height": mined_height,
        "confirmations": confirmations,
        "spent": false,
        "verified": true,
    }))
}

fn validate_recipient(recipient: &str) -> Result<()> {
    ensure!(recipient.len() <= 512, "address too long");
    match Address::decode(&NET, recipient).context("invalid mainnet recipient")? {
        Address::Sapling(_) => Ok(()),
        Address::Unified(ua)
            if ua.transparent().is_none() && (ua.orchard().is_some() || ua.sapling().is_some()) =>
        {
            Ok(())
        }
        _ => bail!("shielded-only mainnet recipient required"),
    }
}

fn pool_name(pool: ShieldedPool) -> &'static str {
    match pool {
        ShieldedPool::Sapling => "sapling",
        ShieldedPool::Orchard => "orchard",
        ShieldedPool::Ironwood => "ironwood",
    }
}

fn validate_accounting(input: u64, amount: u64, fee: u64, change: u64) -> Result<()> {
    let outputs = amount
        .checked_add(fee)
        .and_then(|v| v.checked_add(change))
        .context("accounting overflow")?;
    ensure!(input == outputs, "proposal accounting mismatch");
    Ok(())
}

fn proposal_for(
    wallet: &mut Db,
    recipient: &str,
    zatoshis: u64,
    max_fee: u64,
    account_fingerprint: &str,
) -> Result<(
    PreparedTransaction,
    Proposal<StandardFeeRule, ReceivedNoteId>,
)> {
    validate_recipient(recipient)?;
    ensure!(zatoshis > 0, "amount must be positive");
    let id = wallet
        .get_account_ids()?
        .into_iter()
        .next()
        .context("no account")?;
    let addr = zcash_address::ZcashAddress::try_from_encoded(recipient)
        .context("invalid recipient encoding")?;
    let request = zip321::TransactionRequest::new(vec![
        zip321::Payment::new(
            addr,
            Some(Zatoshis::from_u64(zatoshis)?),
            None,
            None,
            None,
            vec![],
        )
        .map_err(|_| anyhow!("invalid payment"))?,
    ])?;
    // After Ironwood activation, recipient routing and change must not create
    // new Orchard value. Use the current shielded pool explicitly.
    let change = MultiOutputChangeStrategy::new(
        StandardFeeRule::Zip317,
        None,
        ShieldedPool::Ironwood,
        DustOutputPolicy::default(),
        SplitPolicy::with_min_output_value(
            NonZeroUsize::new(1).unwrap(),
            Zatoshis::from_u64(10_000_000)?,
        ),
    );
    let proposal = propose_transfer::<_, _, _, _, std::convert::Infallible>(
        wallet,
        &NET,
        id,
        &GreedyInputSelector::new(),
        &change,
        request,
        ConfirmationsPolicy::default(),
        &SpendPolicy::default(),
        None,
        None,
    )
    .map_err(|e| anyhow!("proposal failed: {e:?}"))?;
    ensure!(
        proposal.steps().len() == 1,
        "multi-transaction proposal requires review"
    );
    let step = proposal.steps().first();
    let fee = step.balance().fee_required().into_u64();
    ensure!(fee <= max_fee, "network fee exceeds approval ceiling");
    let change_total = step
        .balance()
        .proposed_change()
        .iter()
        .try_fold(0u64, |sum, c| sum.checked_add(c.value().into_u64()))
        .context("change overflow")?;
    ensure!(
        step.balance()
            .proposed_change()
            .iter()
            .all(|c| c.output_pool() == zcash_protocol::PoolType::IRONWOOD),
        "unexpected change pool"
    );
    let inputs = step
        .shielded_inputs()
        .context("proposal has no shielded inputs")?
        .notes()
        .iter()
        .map(|note| PreparedInput {
            txid: note.txid().to_string(),
            pool: pool_name(note.note().pool()).to_owned(),
            output_index: note.output_index(),
            zatoshis: note.note().value().into_u64(),
        })
        .collect::<Vec<_>>();
    let input_total = inputs
        .iter()
        .try_fold(0u64, |sum, n| sum.checked_add(n.zatoshis))
        .context("input total overflow")?;
    validate_accounting(input_total, zatoshis, fee, change_total)?;
    let target = u32::from(proposal.min_target_height());
    let expiry = target
        .checked_add(zcash_primitives::transaction::builder::DEFAULT_TX_EXPIRY_DELTA)
        .context("expiry height overflow")?;
    let prepared = PreparedTransaction {
        recipient: recipient.to_owned(),
        zatoshis,
        fee_zatoshis: fee,
        max_fee_zatoshis: max_fee,
        change_zatoshis: change_total,
        change_destination: format!("wallet-internal:ironwood:{account_fingerprint}"),
        input_total_zatoshis: input_total,
        inputs,
        anchor_height: u32::from(step.anchor_height().context("missing shielded anchor")?),
        target_height: target,
        expiry_height: expiry,
        account_fingerprint: account_fingerprint.to_owned(),
    };
    Ok((prepared, proposal))
}

pub fn prepared_digest(prepared: &PreparedTransaction) -> Result<String> {
    let mut hasher = Sha256::new();
    hasher.update(b"zecone-zcash-mainnet-prepared-v1\0");
    hasher.update(serde_json::to_vec(prepared)?);
    Ok(hex::encode(hasher.finalize()))
}

pub fn propose(
    path: &Path,
    recipient: &str,
    zatoshis: u64,
    max_fee: u64,
    account_fingerprint: &str,
) -> Result<(PreparedTransaction, String)> {
    let mut wallet = db(path)?;
    let (prepared, _) = proposal_for(
        &mut wallet,
        recipient,
        zatoshis,
        max_fee,
        account_fingerprint,
    )?;
    let digest = prepared_digest(&prepared)?;
    Ok((prepared, digest))
}

/// Prove and sign on a disposable wallet snapshot. The caller must already
/// have consumed an exact SIGN approval. Raw bytes exist only in memory and in
/// the disposable SDK database until that snapshot is deleted.
pub fn construct(
    snapshot_path: &Path,
    seed: &SecretVec<u8>,
    expected: &PreparedTransaction,
    expected_digest: &str,
) -> Result<ConstructedTransaction> {
    ensure!(
        prepared_digest(expected)? == expected_digest,
        "prepared digest mismatch"
    );
    let mut wallet = db(snapshot_path)?;
    let (prepared, proposal) = proposal_for(
        &mut wallet,
        &expected.recipient,
        expected.zatoshis,
        expected.max_fee_zatoshis,
        &expected.account_fingerprint,
    )?;
    ensure!(
        prepared == *expected,
        "wallet state changed after SIGN review"
    );
    let id = wallet
        .get_account_ids()?
        .into_iter()
        .next()
        .context("no account")?;
    let account = wallet.get_account(id)?.context("account missing")?;
    let account_index = account
        .source()
        .key_derivation()
        .context("not a spending account")?
        .account_index();
    let usk = UnifiedSpendingKey::from_seed(&NET, seed.expose_secret(), account_index)
        .map_err(|_| anyhow!("spending key derivation failed"))?;
    let prover = zcash_proofs::prover::LocalTxProver::bundled();
    let txids = create_proposed_transactions::<
        _,
        _,
        std::convert::Infallible,
        _,
        std::convert::Infallible,
        _,
    >(
        &mut wallet,
        &NET,
        &SystemClock,
        &mut StdRng::try_from_rng(&mut SysRng).map_err(|_| anyhow!("OS randomness unavailable"))?,
        &prover,
        &prover,
        &SpendingKeys::from_unified_spending_key(usk),
        OvkPolicy::Sender,
        &proposal,
        Some(expected.expiry_height.into()),
    )
    .map_err(|e| anyhow!("transaction construction failed: {e:?}"))?;
    ensure!(txids.len() == 1, "multi-transaction construction rejected");
    let txid = *txids.first();
    let tx = wallet
        .get_transaction(txid)?
        .context("constructed transaction missing")?;
    ensure!(
        u32::from(tx.expiry_height()) == expected.expiry_height,
        "signed expiry mismatch"
    );
    let mut raw = Vec::new();
    tx.write(&mut raw)?;
    ensure!(!raw.is_empty(), "empty signed transaction");
    let signed_digest = hex::encode(Sha256::digest(&raw));
    Ok(ConstructedTransaction {
        txid: txid.to_string(),
        signed_digest,
        fee_zatoshis: expected.fee_zatoshis,
        expiry_height: expected.expiry_height,
        serialized_bytes: raw.len(),
        raw: zeroize::Zeroizing::new(raw),
    })
}

pub fn snapshot_wallet(source: &Path, destination: &Path) -> Result<()> {
    ensure!(!destination.exists(), "snapshot destination already exists");
    std::fs::create_dir(destination)?;
    write_new(&destination.join("network"), b"zcash-mainnet")?;
    let src = rusqlite::Connection::open_with_flags(
        source.join("wallet.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let target = destination.join("wallet.sqlite");
    src.execute("VACUUM INTO ?1", [target.to_string_lossy().as_ref()])?;
    Ok(())
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(path)?;
    std::io::Write::write_all(&mut file, bytes)?;
    file.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use secrecy::SecretVec;

    fn prepared() -> PreparedTransaction {
        PreparedTransaction {
            recipient: "u1fixture".into(),
            zatoshis: 100_000,
            fee_zatoshis: 10_000,
            max_fee_zatoshis: 20_000,
            change_zatoshis: 535_937,
            change_destination: "wallet-internal:ironwood:abc".into(),
            input_total_zatoshis: 645_937,
            inputs: vec![PreparedInput {
                txid: "8f".repeat(32),
                pool: "ironwood".into(),
                output_index: 0,
                zatoshis: 645_937,
            }],
            anchor_height: 3_529_900,
            target_height: 3_529_901,
            expiry_height: 3_529_941,
            account_fingerprint: "c8".repeat(32),
        }
    }

    #[test]
    fn prepared_digest_binds_every_accounting_field() {
        let p = prepared();
        let digest = prepared_digest(&p).unwrap();
        let mut changed = p.clone();
        changed.change_zatoshis += 1;
        assert_ne!(digest, prepared_digest(&changed).unwrap());
        let mut changed = p.clone();
        changed.inputs[0].txid = "00".repeat(32);
        assert_ne!(digest, prepared_digest(&changed).unwrap());
    }

    #[test]
    fn invalid_destination_is_rejected() {
        assert!(validate_recipient("not-an-address").is_err());
        // A mainnet transparent destination is deliberately outside this
        // shielded-only pilot even though it is a valid Zcash address.
        assert!(validate_recipient("t1Ke3VHrWdh8yG6J7r9kZ5Z6wX2Bqj3WvJL").is_err());
    }

    #[test]
    fn tree_comparison_detects_reorganizations() {
        let a = TreeState {
            network: "main".into(),
            height: 10,
            hash: "aa".into(),
            time: 0,
            sapling_tree: "s".into(),
            orchard_tree: "o".into(),
            ironwood_tree: "i".into(),
        };
        let mut b = a.clone();
        assert!(same_tree(&a, &b));
        b.hash = "bb".into();
        assert!(!same_tree(&a, &b));
    }

    #[test]
    fn transaction_lookup_requires_same_provider_state() {
        assert!(provider_locations_agree(None, None));
        assert!(provider_locations_agree(Some(0), Some(0)));
        assert!(provider_locations_agree(Some(123), Some(123)));
        assert!(!provider_locations_agree(None, Some(0)));
        assert!(!provider_locations_agree(Some(123), Some(124)));
        assert!(validate_observed_raw(b"not-a-transaction", TxId::NULL, 3_530_000).is_err());
    }

    #[test]
    fn wallet_identity_rejects_wrong_fingerprint_and_address() {
        let seed = SecretVec::new(vec![0u8; 32]);
        let id = keystore::identity(seed.expose_secret()).unwrap();
        assert!(verify_identity(&seed, &"00".repeat(32), &id.orchard_address).is_err());
        assert!(verify_identity(&seed, &id.account, "u1unrelated").is_err());
        verify_identity(&seed, &id.account, &id.orchard_address).unwrap();
    }

    #[test]
    fn browser_identity_is_mainnet_zip316_and_account_bound() {
        let seed = [0u8; 32];
        let id = keystore::identity(&seed).unwrap();
        let usk = UnifiedSpendingKey::from_seed(&NET, &seed, 0u32.try_into().unwrap()).unwrap();
        let ufvk = usk.to_unified_full_viewing_key();
        let decoded = validate_browser_identity(&ufvk, &id.account, &id.address).unwrap();
        assert!(decoded.orchard().is_some() || decoded.sapling().is_some());
        assert!(validate_browser_identity(&ufvk, &"00".repeat(32), &id.address).is_err());
        let other = keystore::identity(&[1u8; 32]).unwrap();
        assert!(validate_browser_identity(&ufvk, &id.account, &other.address).is_err());
        let test_usk =
            UnifiedSpendingKey::from_seed(&Network::TestNetwork, &seed, 0u32.try_into().unwrap())
                .unwrap();
        let (test_address, _) = test_usk
            .to_unified_full_viewing_key()
            .default_address(zcash_keys::keys::UnifiedAddressRequest::SHIELDED)
            .unwrap();
        assert!(
            validate_browser_identity(
                &ufvk,
                &id.account,
                &test_address.encode(&Network::TestNetwork)
            )
            .is_err()
        );
    }

    #[test]
    fn proposal_accounting_detects_insufficient_or_inconsistent_inputs() {
        let p = prepared();
        validate_accounting(
            p.input_total_zatoshis,
            p.zatoshis,
            p.fee_zatoshis,
            p.change_zatoshis,
        )
        .unwrap();
        assert!(validate_accounting(100, 91, 10, 0).is_err());
        assert!(validate_accounting(u64::MAX, u64::MAX, 1, 0).is_err());
    }

    #[test]
    fn deposit_verification_rejects_duplicates_spent_and_immature_notes() {
        let note = json!({
            "txid":"ab", "pool":4, "index":0,
            "zatoshis":"645937", "height":100, "spent":false,
        });
        let one = json!([note.clone()]);
        verify_note_rows(&one, 119, "ab", 4, 0, 645_937, 100).unwrap();
        assert!(
            verify_note_rows(
                &json!([note.clone(), note.clone()]),
                119,
                "ab",
                4,
                0,
                645_937,
                100
            )
            .is_err()
        );
        let mut spent = note.clone();
        spent["spent"] = json!(true);
        assert!(verify_note_rows(&json!([spent]), 119, "ab", 4, 0, 645_937, 100).is_err());
        assert!(verify_note_rows(&one, 118, "ab", 4, 0, 645_937, 100).is_err());
    }

    #[test]
    fn funding_lineage_accepts_finalized_change_and_rejects_substitution() {
        let rows = json!([
            {"txid":"deposit","height":100,"pool":4,"index":0,"zatoshis":"645937","change":false,"spentBy":"withdrawal"},
            {"txid":"withdrawal","height":130,"pool":4,"index":1,"zatoshis":"535937","change":true,"spentBy":null},
            {"txid":"unrelated","height":140,"pool":4,"index":0,"zatoshis":"535937","change":false,"spentBy":null}
        ]);
        let finalized = [FinalizedFundingSpend {
            txid: "withdrawal".into(),
            mined_height: 130,
            selected_notes: vec![PreparedInput {
                txid: "deposit".into(),
                pool: "ironwood".into(),
                output_index: 0,
                zatoshis: 645_937,
            }],
            change_zatoshis: 535_937,
        }];
        let change = [PreparedInput {
            txid: "withdrawal".into(),
            pool: "ironwood".into(),
            output_index: 1,
            zatoshis: 535_937,
        }];
        verify_funding_rows(
            &rows, 160, &finalized, &change, "deposit", 4, 0, 645_937, 100,
        )
        .unwrap();

        let unrelated = [PreparedInput {
            txid: "unrelated".into(),
            pool: "ironwood".into(),
            output_index: 0,
            zatoshis: 535_937,
        }];
        assert!(
            verify_funding_rows(
                &rows, 160, &finalized, &unrelated, "deposit", 4, 0, 645_937, 100,
            )
            .is_err()
        );
        let mut wrong = finalized[0].clone();
        wrong.change_zatoshis -= 1;
        assert!(
            verify_funding_rows(&rows, 160, &[wrong], &change, "deposit", 4, 0, 645_937, 100,)
                .is_err()
        );
    }
}
