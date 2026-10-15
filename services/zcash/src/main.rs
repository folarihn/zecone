mod cache;
mod phase52_payment;
use anyhow::{Context, Result, anyhow, bail, ensure};
use clap::{Parser, Subcommand};
use rand::{RngCore, rngs::OsRng};
use rand10::{
    SeedableRng,
    rngs::{StdRng, SysRng},
};
use secrecy::{ExposeSecret, SecretVec};
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    num::NonZeroUsize,
    path::{Path, PathBuf},
    str::FromStr,
    time::{SystemTime, UNIX_EPOCH},
};
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
    proto::service::{self, compact_tx_streamer_client::CompactTxStreamerClient},
    wallet::OvkPolicy,
};
use zcash_client_sqlite::{WalletDb, util::SystemClock, wallet::init::init_wallet_db};
use zcash_keys::{
    address::Address,
    keys::{UnifiedAddressRequest, UnifiedSpendingKey},
};
use zcash_protocol::{ShieldedPool, consensus::Network, value::Zatoshis};
const NET: Network = Network::TestNetwork;
type Db = WalletDb<rusqlite::Connection, Network, SystemClock, rand10::rngs::ThreadRng>;

#[derive(Parser)]
struct Cli {
    #[arg(long)]
    wallet: PathBuf,
    #[arg(long, default_value = "https://testnet.zec.rocks:443")]
    server: String,
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    /// Read public status for the exact new-profile transaction; never resubmit.
    InspectPhase52Payment {
        #[arg(long)]
        profile_id: uuid::Uuid,
        #[arg(long)]
        request_id: uuid::Uuid,
    },
    /// Fresh Phase 5.2 payer only; a 32-byte seed is read from stdin, never stored.
    PreparePhase52Payment {
        #[arg(long)]
        profile_id: uuid::Uuid,
        #[arg(long)]
        request_id: uuid::Uuid,
        #[arg(long)]
        birthday: u32,
    },
    /// Submit the exact persisted Phase 5.2 payer transaction once, after review.
    BroadcastPhase52Payment {
        #[arg(long)]
        profile_id: uuid::Uuid,
        #[arg(long)]
        request_id: uuid::Uuid,
        #[arg(long)]
        approved_txid: String,
        #[arg(long)]
        allow_testnet_broadcast: bool,
    },
    /// Decode a shielded testnet address offline, without opening a wallet or seed.
    ValidateAddress {
        #[arg(long)]
        address: String,
    },
    Init,
    /// Idempotent, dedicated shielded account for a payment request.
    Allocate {
        #[arg(long)]
        label: String,
    },
    Sync,
    /// Syncs first; never emits stale offline settlement evidence.
    Observe,
    /// Native balances and sanitized wallet history after a complete scan.
    Summary,
    /// Build an unsigned proposal to calculate the actual fee; never sign or broadcast.
    Quote {
        #[arg(long)]
        account: String,
        #[arg(long)]
        address: String,
        #[arg(long)]
        zatoshis: u64,
    },
    /// Read public server network and consensus information.
    NetworkInfo,
    /// Reconcile and optionally rebroadcast the exact persisted transaction; never reconstruct.
    ReconcileSend {
        #[arg(long)]
        request_id: uuid::Uuid,
        #[arg(long)]
        allow_testnet_broadcast: bool,
    },
    /// Local signing, shielded destinations only. Explicit live flag required.
    Send {
        /// Stable UUID for this payment; reuse it after an uncertain outcome.
        #[arg(long)]
        request_id: uuid::Uuid,
        #[arg(long)]
        account: String,
        #[arg(long)]
        address: String,
        #[arg(long)]
        zatoshis: u64,
        #[arg(long)]
        allow_testnet_broadcast: bool,
        /// When supplied, refuse a proposal whose fee exceeds the user's approval.
        #[arg(long)]
        max_fee_zatoshis: Option<u64>,
    },
    /// Read already generated public addresses only.
    Addresses,
}

struct WalletLock(PathBuf);
impl Drop for WalletLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn lock_wallet(path: &Path) -> Result<WalletLock> {
    fs::create_dir_all(path)?;
    let file = path.join("process.lock");
    write_new(&file, std::process::id().to_string().as_bytes())
        .context("wallet is locked; review the recorded process before removing a stale lock")?;
    Ok(WalletLock(file))
}

fn db(path: &Path) -> Result<Db> {
    ensure!(
        fs::read_to_string(path.join("network"))? == "zcash-testnet",
        "wallet is not testnet"
    );
    Ok(WalletDb::for_path(
        path.join("wallet.sqlite"),
        NET,
        SystemClock,
        rand10::rng(),
    )?)
}
fn seed(path: &Path) -> Result<SecretVec<u8>> {
    let bytes = fs::read(path.join("seed.bin"))?;
    ensure!(bytes.len() == 32, "invalid seed length");
    Ok(SecretVec::new(bytes))
}
fn validate_shielded_destination(recipient: &str) -> Result<()> {
    ensure!(recipient.len() <= 512, "address too long");
    match Address::decode(&NET, recipient).context("invalid testnet recipient")? {
        Address::Sapling(_) => Ok(()),
        Address::Unified(ua)
            if ua.transparent().is_none() && (ua.orchard().is_some() || ua.sapling().is_some()) =>
        {
            Ok(())
        }
        _ => bail!("shielded-only recipient required"),
    }
}
async fn connect(url: &str) -> Result<CompactTxStreamerClient<Channel>> {
    ensure!(url.starts_with("https://"), "TLS is required");
    let channel = Channel::from_shared(url.to_string())?
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(120))
        .tls_config(ClientTlsConfig::new().with_webpki_roots())?
        .connect()
        .await?;
    let mut client = CompactTxStreamerClient::new(channel);
    let info = client
        .get_lightd_info(service::Empty {})
        .await?
        .into_inner();
    ensure!(
        info.chain_name == "test",
        "lightwalletd is not standard Zcash testnet"
    );
    verify_branch(info.block_height, &info.consensus_branch_id)?;
    Ok(client)
}

fn verify_branch(height: u64, reported: &str) -> Result<()> {
    let height = u32::try_from(height).context("invalid chain height")?;
    let expected = u32::from(zcash_protocol::consensus::BranchId::for_height(
        &NET,
        height.into(),
    ));
    let actual = u32::from_str_radix(reported.trim_start_matches("0x"), 16)
        .context("invalid server consensus branch")?;
    ensure!(
        actual == expected,
        "unsupported testnet consensus: server {actual:08x}, library {expected:08x}; upgrade before spending"
    );
    Ok(())
}
async fn birthday(client: &mut CompactTxStreamerClient<Channel>) -> Result<AccountBirthday> {
    let height = client
        .get_latest_block(service::ChainSpec::default())
        .await?
        .into_inner()
        .height;
    ensure!(height > 100, "invalid chain tip");
    let tree = client
        .get_tree_state(service::BlockId {
            height: height - 100,
            hash: vec![],
        })
        .await?
        .into_inner();
    ensure!(tree.network == "test", "tree state is not testnet");
    Ok(AccountBirthday::from_treestate(tree, None)?)
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}
fn addresses(path: &Path) -> Result<Value> {
    let conn = rusqlite::Connection::open_with_flags(
        path.join("wallet.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let mut stmt = conn.prepare("SELECT a.name, a.uuid, d.address FROM accounts a JOIN addresses d ON d.account_id = a.id WHERE d.exposed_at_height IS NOT NULL ORDER BY a.id, d.id")?;
    let rows = stmt.query_map([], |r| {
        let uuid: Vec<u8> = r.get(1)?;
        let address: String = r.get(2)?;
        let sapling = match Address::decode(&NET, &address) {
            Some(Address::Unified(ua)) => ua.sapling().map(|a| Address::Sapling(Box::new(*a)).encode(&NET)),
            _ => None,
        };
        Ok(json!({"label": r.get::<_, String>(0)?, "account": uuid::Uuid::from_slice(&uuid).unwrap().to_string(), "address":address, "saplingAddress":sapling}))
    })?;
    Ok(Value::Array(rows.collect::<Result<Vec<_>, _>>()?))
}
fn existing_address(path: &Path, label: &str) -> Result<Option<Value>> {
    let all = addresses(path)?;
    for value in all
        .as_array()
        .unwrap()
        .iter()
        .filter(|v| v["label"] == label)
    {
        if matches!(Address::decode(&NET, value["address"].as_str().unwrap()), Some(Address::Unified(ua)) if ua.transparent().is_none())
        {
            return Ok(Some(value.clone()));
        }
    }
    Ok(None)
}
async fn allocate(
    path: &Path,
    wallet: &mut Db,
    client: &mut CompactTxStreamerClient<Channel>,
    label: &str,
) -> Result<Value> {
    ensure!(
        !label.is_empty() && label.len() <= 128,
        "invalid account label"
    );
    if let Some(found) = existing_address(path, label)? {
        return Ok(found);
    }
    // Reuse an account after a crash between account creation and address exposure.
    let existing = wallet.get_account_ids()?.into_iter().find(|id| {
        wallet
            .get_account(*id)
            .ok()
            .flatten()
            .is_some_and(|a| a.name() == Some(label))
    });
    let id = match existing {
        Some(id) => id,
        None => {
            wallet
                .create_account(label, &seed(path)?, &birthday(client).await?, None)?
                .0
        }
    };
    // create_account already exposes a default address. Return that same address on first
    // creation and retry; do not accidentally allocate a second address on the first call.
    if let Some(found) = existing_address(path, label)? {
        return Ok(found);
    }
    let (ua, _) = wallet
        .get_next_available_address(id, UnifiedAddressRequest::SHIELDED)?
        .ok_or(anyhow!("address unavailable"))?;
    ensure!(
        ua.transparent().is_none(),
        "transparent receiver prohibited"
    );
    Ok(json!({"label":label, "account":id.expose_uuid().to_string(), "address":ua.encode(&NET)}))
}
async fn sync(wallet: &mut Db, client: &mut CompactTxStreamerClient<Channel>) -> Result<()> {
    zcash_client_backend::sync::run(client, &NET, &cache::Cache::default(), wallet, 1000).await?;
    let tip = wallet.chain_height()?.context("chain tip missing")?;
    let scanned = wallet
        .block_fully_scanned()?
        .context("wallet has not scanned any blocks")?;
    ensure!(scanned.block_height() == tip, "wallet scan is incomplete");
    Ok(())
}
fn observation(path: &Path, wallet: &Db) -> Result<Value> {
    let tip = u32::from(wallet.chain_height()?.context("missing chain tip")?);
    let scanned = u32::from(
        wallet
            .block_fully_scanned()?
            .context("missing scan")?
            .block_height(),
    );
    let conn = rusqlite::Connection::open_with_flags(
        path.join("wallet.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let mut stmt = conn.prepare("SELECT a.uuid, t.txid, r.pool, r.output_index, r.value, t.mined_height, b.hash FROM v_received_outputs r JOIN accounts a ON a.id=r.account_id JOIN transactions t ON t.id_tx=r.transaction_id JOIN blocks b ON b.height=t.mined_height WHERE r.pool IN (2,3,4) AND r.is_change=0 AND r.value>0")?;
    let rows = stmt.query_map([], |r| {
        let uuid: Vec<u8> = r.get(0)?;
        let mut txid: Vec<u8> = r.get(1)?; txid.reverse();
        let mut hash: Vec<u8> = r.get(6)?; hash.reverse();
        Ok(json!({"account": uuid::Uuid::from_slice(&uuid).unwrap().to_string(), "txid":hex::encode(txid), "pool":r.get::<_,u32>(2)?, "index":r.get::<_,u32>(3)?, "zatoshis":r.get::<_,u64>(4)?.to_string(), "height":r.get::<_,u32>(5)?, "blockHash":hex::encode(hash)}))
    })?;
    Ok(
        json!({"network":"zcash-testnet", "tip":tip, "scanned":scanned, "observedAt":SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(), "payments":rows.collect::<Result<Vec<_>, _>>()?}),
    )
}
fn enforce_fee_approval(fee: u64, max_fee: Option<u64>) -> Result<()> {
    ensure!(
        max_fee.is_none_or(|limit| fee <= limit),
        "network fee exceeds approval; request a new quote"
    );
    Ok(())
}
// A new request ID must not bypass an earlier interrupted construction. This is
// read-only: resolving a claim is an explicit recovery operation, never a timeout.
fn ensure_no_unresolved_construction(path: &Path) -> Result<()> {
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_str().context("non-UTF8 wallet entry")?;
        if let Some(id) = name
            .strip_prefix("request-")
            .and_then(|s| s.strip_suffix(".started.json"))
        {
            let id = uuid::Uuid::parse_str(id).context("unrecognized construction marker")?;
            ensure!(entry.file_type()?.is_file(), "invalid construction marker");
            let saved = path.join(format!("request-{id}.json"));
            ensure!(
                saved.is_file(),
                "wallet has an unresolved construction; a new request ID cannot authorize a replacement"
            );
            let started: Value = serde_json::from_slice(&fs::read(entry.path())?)?;
            let record: Value = serde_json::from_slice(&fs::read(saved)?)?;
            ensure!(
                record["account"].is_string()
                    && record["recipient"].is_string()
                    && record["zatoshis"].is_string(),
                "invalid persisted construction binding"
            );
            ensure!(
                ["account", "recipient", "zatoshis"]
                    .iter()
                    .all(|k| started[*k] == record[*k]),
                "construction binding conflict"
            );
            zcash_protocol::TxId::from_hex(
                record["txid"]
                    .as_str()
                    .context("persisted transaction reference missing")?,
            )
            .context("invalid persisted transaction reference")?;
        }
    }
    Ok(())
}
async fn send(
    wallet: &mut Db,
    client: &mut CompactTxStreamerClient<Channel>,
    path: &Path,
    account: &str,
    recipient: &str,
    value: u64,
    request_id: uuid::Uuid,
    quote_only: bool,
    max_fee: Option<u64>,
    prepare_only: bool,
    seed_override: Option<&SecretVec<u8>>,
) -> Result<Value> {
    let request_file = path.join(format!("request-{request_id}.json"));
    let started_file = path.join(format!("request-{request_id}.started.json"));
    if request_file.exists() {
        let prior: Value = serde_json::from_slice(&fs::read(&request_file)?)?;
        ensure!(
            prior["recipient"] == recipient
                && prior["zatoshis"] == value.to_string()
                && prior["account"] == account,
            "payment request idempotency conflict"
        );
        return Ok(
            json!({"txid":prior["txid"], "status":"previously-constructed-reconcile-before-retry"}),
        );
    }
    ensure!(
        !started_file.exists(),
        "previous construction has an uncertain outcome; reconcile the wallet transaction history before retrying"
    );
    if !quote_only {
        ensure_no_unresolved_construction(path)?;
    }
    validate_shielded_destination(recipient)?;
    ensure!(value > 0, "amount must be positive");
    sync(wallet, client).await?;
    let id = wallet
        .get_account_ids()?
        .into_iter()
        .find(|id| id.expose_uuid().to_string() == account)
        .context("account not found")?;
    let acc = wallet.get_account(id)?.context("account missing")?;
    let derivation = acc
        .source()
        .key_derivation()
        .context("not a spending account")?;
    let account_index = derivation.account_index();
    let request = zip321::TransactionRequest::new(vec![
        zip321::Payment::new(
            zcash_address::ZcashAddress::from_str(recipient)?,
            Some(Zatoshis::from_u64(value)?),
            None,
            None,
            None,
            vec![],
        )
        .map_err(|_| anyhow!("invalid payment"))?,
    ])?;
    let change = MultiOutputChangeStrategy::new(
        StandardFeeRule::Zip317,
        None,
        ShieldedPool::Orchard,
        DustOutputPolicy::default(),
        SplitPolicy::with_min_output_value(
            NonZeroUsize::new(1).unwrap(),
            Zatoshis::from_u64(10000000)?,
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
    let fee = proposal.steps().first().balance().fee_required().into_u64();
    enforce_fee_approval(fee, max_fee)?;
    if quote_only {
        return Ok(
            json!({"zatoshis":value.to_string(),"feeZatoshis":fee.to_string(),"totalZatoshis":(value+fee).to_string(),"tip":u32::from(wallet.chain_height()?.context("missing tip")?),"quotedAt":SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs()}),
        );
    }
    let legacy_seed;
    let spend_seed = if let Some(s) = seed_override {
        s
    } else {
        legacy_seed = seed(path)?;
        &legacy_seed
    };
    let usk = UnifiedSpendingKey::from_seed(&NET, spend_seed.expose_secret(), account_index)
        .map_err(|_| anyhow!("key derivation failed"))?;
    let prover = zcash_proofs::prover::LocalTxProver::bundled();
    let expiry_override = if prepare_only {
        Some(
            zcash_protocol::consensus::BlockHeight::from(proposal.min_target_height())
                + zcash_primitives::transaction::builder::DEFAULT_TX_EXPIRY_DELTA,
        )
    } else {
        None
    };
    write_new(
        &started_file,
        serde_json::to_string(
            &json!({"account":account,"recipient":recipient,"zatoshis":value.to_string(),"plannedExpiryHeight":expiry_override.map(u32::from),"feeZatoshis":fee.to_string()}),
        )?
        .as_bytes(),
    )?;
    let txids = create_proposed_transactions::<
        _,
        _,
        std::convert::Infallible,
        _,
        std::convert::Infallible,
        _,
    >(
        wallet,
        &NET,
        &SystemClock,
        &mut StdRng::try_from_rng(&mut SysRng).map_err(|_| anyhow!("OS randomness unavailable"))?,
        &prover,
        &prover,
        &SpendingKeys::from_unified_spending_key(usk),
        OvkPolicy::Sender,
        &proposal,
        expiry_override,
    )
    .map_err(|e| anyhow!("transaction construction failed: {e:?}"))?;
    ensure!(
        txids.len() == 1,
        "multi-transaction proposal requires manual recovery"
    );
    let txid = *txids.first();
    let tx = wallet
        .get_transaction(txid)?
        .context("constructed transaction missing")?;
    let mut raw = service::RawTransaction::default();
    tx.write(&mut raw.data)?;
    // Save reference before broadcast. Unknown outcomes need txid reconciliation, never blind re-send.
    if prepare_only {
        write_new(&path.join(format!("request-{request_id}.raw")), &raw.data)?;
    }
    let pending = json!({"txid":txid.to_string(), "status":"constructed", "recipient":recipient, "zatoshis":value.to_string(), "account":account,"feeZatoshis":fee.to_string(),"expiryHeight":u32::from(tx.expiry_height())});
    write_new(
        &request_file,
        serde_json::to_string_pretty(&pending)?.as_bytes(),
    )?;
    if prepare_only {
        return Ok(
            json!({"txid":txid.to_string(),"status":"prepared-not-broadcast","recipient":recipient,"zatoshis":value.to_string(),"feeZatoshis":fee.to_string(),"expiryHeight":u32::from(tx.expiry_height()),"broadcast":false}),
        );
    }
    let response = client.send_transaction(raw).await?.into_inner();
    ensure!(
        response.error_code == 0,
        "testnet broadcast rejected (code {}): {}",
        response.error_code,
        response
            .error_message
            .chars()
            .take(1000)
            .collect::<String>()
    );
    Ok(json!({"txid":txid.to_string(), "status":"broadcast-not-confirmed"}))
}
fn main() -> Result<()> {
    // Shielded proving in debug builds can exceed Windows' default main-thread stack.
    // Run the async entry point on an explicitly sized stack; RUST_MIN_STACK alone
    // does not change the process main thread's stack.
    std::thread::Builder::new()
        .name("zcash-wallet".into())
        .stack_size(64 * 1024 * 1024)
        .spawn(|| {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .thread_stack_size(64 * 1024 * 1024)
                .build()?
                .block_on(run())
        })?
        .join()
        .map_err(|_| anyhow!("wallet worker panicked; reconcile saved request before retrying"))?
}

async fn run() -> Result<()> {
    rustls::crypto::ring::default_provider()
        .install_default()
        .map_err(|_| anyhow!("TLS provider initialization failed"))?;
    let args = Cli::parse();
    match &args.command {
        Command::InspectPhase52Payment {
            profile_id,
            request_id,
        } => {
            let v = phase52_payment::inspect(&args.wallet, &args.server, *profile_id, *request_id)
                .await?;
            println!("{v}");
            return Ok(());
        }
        Command::PreparePhase52Payment {
            profile_id,
            request_id,
            birthday,
        } => {
            let v = phase52_payment::prepare(
                &args.wallet,
                &args.server,
                *profile_id,
                *request_id,
                *birthday,
            )
            .await?;
            println!("{v}");
            return Ok(());
        }
        Command::BroadcastPhase52Payment {
            profile_id,
            request_id,
            approved_txid,
            allow_testnet_broadcast,
        } => {
            ensure!(
                *allow_testnet_broadcast,
                "explicit broadcast approval required"
            );
            let v = phase52_payment::broadcast(
                &args.wallet,
                &args.server,
                *profile_id,
                *request_id,
                approved_txid,
            )
            .await?;
            println!("{v}");
            return Ok(());
        }
        _ => (),
    }
    if let Command::ValidateAddress { address } = &args.command {
        validate_shielded_destination(address)?;
        let receivers = match Address::decode(&NET, address).context("invalid recipient")? {
            Address::Sapling(_) => json!({"sapling":true,"orchard":false,"transparent":false}),
            Address::Unified(ua) => {
                json!({"sapling":ua.sapling().is_some(),"orchard":ua.orchard().is_some(),"transparent":ua.transparent().is_some()})
            }
            _ => bail!("shielded-only recipient required"),
        };
        println!(
            "{}",
            json!({"network":"zcash-testnet","shielded":true,"valid":true,"receivers":receivers})
        );
        return Ok(());
    }
    let _lock = lock_wallet(&args.wallet)?;
    if matches!(args.command, Command::Init) {
        fs::create_dir_all(&args.wallet)?;
        ensure!(
            !args.wallet.join("seed.bin").exists(),
            "wallet exists; refusing to overwrite"
        );
        let mut client = connect(&args.server).await?;
        let birthday = birthday(&mut client).await?;
        // CSPRNG output is never printed.
        let mut entropy = [0u8; 32];
        OsRng.fill_bytes(&mut entropy);
        write_new(&args.wallet.join("seed.bin"), &entropy)?;
        use secrecy::Zeroize;
        entropy.zeroize();
        let bytes = seed(&args.wallet)?;
        write_new(&args.wallet.join("network"), b"zcash-testnet")?;
        let mut wallet = db(&args.wallet)?;
        init_wallet_db(&mut wallet, Some(seed(&args.wallet)?))?;
        let (id, _) = wallet.create_account("funding", &bytes, &birthday, None)?;
        let (ua, _) = wallet
            .get_next_available_address(id, UnifiedAddressRequest::SHIELDED)?
            .context("no address")?;
        let sapling = ua
            .sapling()
            .map(|a| Address::Sapling(Box::new(*a)).encode(&NET));
        println!(
            "{}",
            json!({"network":"zcash-testnet", "account":id.expose_uuid().to_string(), "address":ua.encode(&NET), "saplingAddress":sapling, "birthday":u32::from(birthday.height())})
        );
        return Ok(());
    }
    let mut wallet = db(&args.wallet)?;
    init_wallet_db(&mut wallet, Some(seed(&args.wallet)?))?;
    if matches!(args.command, Command::Addresses) {
        println!("{}", addresses(&args.wallet)?);
        return Ok(());
    }
    let mut client = connect(&args.server).await?;
    let value = match args.command {
        Command::Summary => {
            sync(&mut wallet, &mut client).await?;
            let summary = wallet
                .get_wallet_summary(ConfirmationsPolicy::default())?
                .context("wallet summary unavailable")?;
            let mut total = 0u64;
            let mut spendable = 0u64;
            for balance in summary.account_balances().values() {
                total += balance.sapling_balance().total().into_u64()
                    + balance.orchard_balance().total().into_u64()
                    + balance.ironwood_balance().total().into_u64();
                spendable += balance.spendable_value().into_u64();
            }
            let conn = rusqlite::Connection::open_with_flags(
                args.wallet.join("wallet.sqlite"),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )?;
            let mut query = conn.prepare("SELECT txid,mined_height,account_balance_delta,fee_paid,block_time,expired_unmined FROM v_transactions ORDER BY COALESCE(mined_height,2147483647) DESC LIMIT 30")?;
            let history = query.query_map([], |r| {
                let mut txid:Vec<u8> = r.get(0)?; txid.reverse();
                Ok(json!({"txid":hex::encode(txid),"height":r.get::<_,Option<u32>>(1)?,"deltaZatoshis":r.get::<_,i64>(2)?.to_string(),"feeZatoshis":r.get::<_,Option<u64>>(3)?.map(|v|v.to_string()),"time":r.get::<_,Option<u64>>(4)?,"expired":r.get::<_,Option<bool>>(5)?.unwrap_or(false)}))
            })?.collect::<Result<Vec<_>,_>>()?;
            json!({"totalZatoshis":total.to_string(),"spendableZatoshis":spendable.to_string(),"tip":u32::from(summary.chain_tip_height()),"scanned":u32::from(summary.fully_scanned_height()),"observedAt":SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),"history":history})
        }
        Command::Quote {
            account,
            address,
            zatoshis,
        } => {
            send(
                &mut wallet,
                &mut client,
                &args.wallet,
                &account,
                &address,
                zatoshis,
                uuid::Uuid::nil(),
                true,
                None,
                false,
                None,
            )
            .await?
        }
        Command::NetworkInfo => {
            let info = client
                .get_lightd_info(service::Empty {})
                .await?
                .into_inner();
            json!({"network": info.chain_name, "height": info.block_height, "consensusBranchId": info.consensus_branch_id, "serverVersion": info.version, "nodeVersion": info.zcashd_build, "upgradeName": info.upgrade_name, "upgradeHeight": info.upgrade_height})
        }
        Command::ReconcileSend {
            request_id,
            allow_testnet_broadcast,
        } => {
            let saved: Value = serde_json::from_slice(&fs::read(
                args.wallet.join(format!("request-{request_id}.json")),
            )?)?;
            let txid = zcash_protocol::TxId::from_hex(
                saved["txid"].as_str().context("saved txid missing")?,
            )
            .context("invalid saved txid")?;
            match client
                .get_transaction(service::TxFilter {
                    hash: txid.as_ref().to_vec(),
                    ..Default::default()
                })
                .await
            {
                Ok(found) => {
                    json!({"txid":txid.to_string(), "status":"known-to-server-requires-wallet-confirmation", "height":found.into_inner().height})
                }
                Err(e) if e.code() == tonic::Code::NotFound => {
                    if allow_testnet_broadcast {
                        let tx = wallet
                            .get_transaction(txid)?
                            .context("saved transaction missing from wallet")?;
                        ensure!(tx.txid() == txid, "saved transaction ID mismatch");
                        let mut raw = service::RawTransaction::default();
                        tx.write(&mut raw.data)?;
                        let r = client.send_transaction(raw).await?.into_inner();
                        json!({"txid":txid.to_string(), "status":if r.error_code == 0 {"broadcast-not-confirmed"} else {"broadcast-rejected"}, "errorCode":r.error_code, "errorMessage":r.error_message.chars().take(1000).collect::<String>()})
                    } else {
                        sync(&mut wallet, &mut client).await?;
                        // Refresh absence after sync so the native status is tied to that tip.
                        match client
                            .get_transaction(service::TxFilter {
                                hash: txid.as_ref().to_vec(),
                                ..Default::default()
                            })
                            .await
                        {
                            Err(e) if e.code() == tonic::Code::NotFound => (),
                            _ => bail!(
                                "transaction absence changed or lookup failed; reconcile again"
                            ),
                        }
                        let tx = wallet
                            .get_transaction(txid)?
                            .context("saved transaction missing")?;
                        let expiry = u32::from(tx.expiry_height());
                        let tip = u32::from(wallet.chain_height()?.context("missing tip")?);
                        wallet.set_transaction_status(
                            txid,
                            zcash_client_backend::data_api::TransactionStatus::TxidNotRecognized,
                        )?;
                        json!({"txid":txid.to_string(), "status":if expiry > 0 && tip > expiry {"expired-unmined"} else {"not-found-on-server"}, "expiryHeight":expiry, "tip":tip})
                    }
                }
                Err(e) => {
                    return Err(anyhow!(
                        "transaction lookup failed with gRPC code {:?}; no rebroadcast attempted",
                        e.code()
                    ));
                }
            }
        }
        Command::Allocate { label } => {
            allocate(&args.wallet, &mut wallet, &mut client, &label).await?
        }
        Command::Sync | Command::Observe => {
            sync(&mut wallet, &mut client).await?;
            observation(&args.wallet, &wallet)?
        }
        Command::Send {
            request_id,
            account,
            address,
            zatoshis,
            allow_testnet_broadcast,
            max_fee_zatoshis,
        } => {
            ensure!(
                allow_testnet_broadcast,
                "explicit --allow-testnet-broadcast required"
            );
            send(
                &mut wallet,
                &mut client,
                &args.wallet,
                &account,
                &address,
                zatoshis,
                request_id,
                false,
                max_fee_zatoshis,
                false,
                None,
            )
            .await?
        }
        _ => unreachable!(),
    };
    println!("{value}");
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn unresolved_construction_blocks_new_request_ids_and_survives_restart() {
        let tmp = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4();
        let marker = tmp.path().join(format!("request-{id}.started.json"));
        let bytes = br#"{"account":"a","recipient":"r","zatoshis":"200000"}"#;
        super::write_new(&marker, bytes).unwrap();
        assert!(super::ensure_no_unresolved_construction(tmp.path()).is_err());
        assert!(super::ensure_no_unresolved_construction(tmp.path()).is_err());
        assert_eq!(std::fs::read(marker).unwrap(), bytes);
    }
    #[test]
    fn persisted_binding_must_match_before_old_markers_stop_blocking_new_sends() {
        let tmp = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4();
        super::write_new(
            &tmp.path().join(format!("request-{id}.started.json")),
            br#"{"account":"a","recipient":"r","zatoshis":"200000"}"#,
        )
        .unwrap();
        let file = tmp.path().join(format!("request-{id}.json"));
        std::fs::write(&file, br#"{"account":"a","recipient":"other","zatoshis":"200000","txid":"0000000000000000000000000000000000000000000000000000000000000000"}"#).unwrap();
        assert!(super::ensure_no_unresolved_construction(tmp.path()).is_err());
        std::fs::write(
            &file,
            br#"{"account":"a","recipient":"r","zatoshis":"200000","txid":"invalid"}"#,
        )
        .unwrap();
        assert!(super::ensure_no_unresolved_construction(tmp.path()).is_err());
        std::fs::write(&file, br#"{"account":"a","recipient":"r","zatoshis":"200000","txid":"0000000000000000000000000000000000000000000000000000000000000000"}"#).unwrap();
        assert!(super::ensure_no_unresolved_construction(tmp.path()).is_ok());
    }
    #[test]
    fn fee_increase_cannot_exceed_approved_ceiling() {
        assert!(super::enforce_fee_approval(20_000, Some(20_000)).is_ok());
        assert!(super::enforce_fee_approval(20_001, Some(20_000)).is_err());
        assert!(super::enforce_fee_approval(10_000, Some(20_000)).is_ok());
        assert!(super::enforce_fee_approval(1, Some(0)).is_err());
    }
    use super::*;
    #[test]
    fn consensus_preflight_rejects_old_or_unknown_branch() {
        assert!(verify_branch(4_465_026, "77190ad9").is_ok());
        assert!(verify_branch(4_465_026, "37a5165b").is_err());
        assert!(verify_branch(4_465_025, "37a5165b").is_ok());
        assert!(verify_branch(4_465_026, "ffffffff").is_err());
    }
    #[test]
    fn wallet_schema_matches_observation_query() {
        use zcash_client_backend::data_api::chain::ChainState;
        use zcash_primitives::block::BlockHash;
        let tmp = tempfile::tempdir().unwrap();
        write_new(&tmp.path().join("network"), b"zcash-testnet").unwrap();
        let mut entropy = vec![0u8; 32];
        OsRng.fill_bytes(&mut entropy);
        let secret = SecretVec::new(entropy);
        let mut wallet = db(tmp.path()).unwrap();
        init_wallet_db(&mut wallet, None).unwrap();
        // Synthetic pre-Sapling birthday is confined to this offline schema test.
        let birthday = AccountBirthday::from_parts(
            ChainState::empty(279999u32.into(), BlockHash([0; 32])),
            None,
        );
        let (id, _) = wallet
            .create_account("fixture", &secret, &birthday, None)
            .unwrap();
        wallet.update_chain_tip(280000u32.into()).unwrap();
        let first = existing_address(tmp.path(), "fixture").unwrap().unwrap();
        assert_eq!(
            first,
            existing_address(tmp.path(), "fixture").unwrap().unwrap()
        );
        wallet
            .get_next_available_address(id, UnifiedAddressRequest::SHIELDED)
            .unwrap()
            .unwrap();
        assert!(
            !addresses(tmp.path())
                .unwrap()
                .as_array()
                .unwrap()
                .is_empty()
        );
        let conn = rusqlite::Connection::open_with_flags(
            tmp.path().join("wallet.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        conn.prepare("SELECT a.uuid,t.txid,r.pool,r.output_index,r.value,t.mined_height,b.hash FROM v_received_outputs r JOIN accounts a ON a.id=r.account_id JOIN transactions t ON t.id_tx=r.transaction_id JOIN blocks b ON b.height=t.mined_height WHERE r.pool IN (2,3,4) AND r.is_change=0 AND r.value>0").unwrap();
    }
    #[test]
    fn seed_is_exclusive_and_address_is_testnet_shielded() {
        let tmp = tempfile::tempdir().unwrap();
        let mut entropy = [0u8; 32];
        OsRng.fill_bytes(&mut entropy);
        write_new(&tmp.path().join("seed.bin"), &entropy).unwrap();
        assert!(write_new(&tmp.path().join("seed.bin"), &entropy).is_err());
        let usk = UnifiedSpendingKey::from_seed(&NET, &entropy, 0u32.try_into().unwrap()).unwrap();
        let (ua, _) = usk
            .to_unified_full_viewing_key()
            .default_address(UnifiedAddressRequest::SHIELDED)
            .unwrap();
        assert!(ua.encode(&NET).starts_with("utest"));
        assert!(ua.transparent().is_none());
        assert!(Address::decode(&Network::MainNetwork, &ua.encode(&NET)).is_none());
        assert!(validate_shielded_destination(&ua.encode(&NET)).is_ok());
        assert!(validate_shielded_destination(&ua.encode(&Network::MainNetwork)).is_err());
        assert!(validate_shielded_destination("utest1invalidchecksum").is_err());
        assert!(validate_shielded_destination(&"x".repeat(513)).is_err());
    }
}
