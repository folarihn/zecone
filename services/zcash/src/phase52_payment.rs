//! Fixed-purpose fresh payer only. This never loads Wallet B's spending authority.
use super::*;
use std::io::Read;
const PAYMENT: u64 = 100_000;
const FEE_CAP: u64 = 10_000;
#[cfg(test)]
fn context(path: &Path, profile: uuid::Uuid, request: uuid::Uuid) -> Result<(PathBuf, String)> {
    context_for(path, profile, request, "phase52")
}
fn context_for(path: &Path, profile: uuid::Uuid, request: uuid::Uuid, namespace: &str) -> Result<(PathBuf, String)> {
    let root = std::env::current_dir()?;
    ensure!(["phase52", "phase7b", "phase7c", "phase7c-funding"].contains(&namespace), "unsupported payment namespace");
    let modern = namespace != "phase52";
    let expected = root
        .join(format!(".state/{namespace}"))
        .join(profile.to_string())
        .join("payer-native");
    ensure!(path == expected, "isolated payer path required");
    let mut ancestor = Some(path);
    while let Some(p) = ancestor {
        if p.exists() {
            ensure!(
                !fs::symlink_metadata(p)?.file_type().is_symlink(),
                "linked payer path rejected"
            );
        }
        if p == root {
            break;
        }
        ancestor = p.parent();
    }
    let config: Value =
        serde_json::from_slice(&fs::read(root.join(if modern { format!(".state/{namespace}/profile.json") } else { ".state/phase52-profile.json".to_string() }))?)?;
    ensure!(
        config["id"] == profile.to_string()
            && config[if modern { "orderId" } else { "paymentRequestId" }] == request.to_string()
            && config["network"] == "zcash-testnet"
            && config["liveRefundsEnabled"] == false,
        "profile binding conflict"
    );
    if namespace == "phase7c-funding" {
        let destination: Value = serde_json::from_slice(&fs::read(root.join(".state/phase7c/profile.json"))?)?;
        let source: Value = serde_json::from_slice(&fs::read(root.join(".state/phase7b/profile.json"))?)?;
        ensure!(config["sourceProfileId"] == source["id"] && config["destinationProfileId"] == destination["id"] && config["addresses"]["settlement"] == destination["addresses"]["payer"], "funding profile conflict");
    }
    let m: Value = serde_json::from_slice(&fs::read(
        root.join(format!(".state/{namespace}"))
            .join(profile.to_string())
            .join(if modern { "settlement-watch/watch-only.json" } else { "backend/wallet-b-watch/watch-only.json" }),
    )?)?;
    let m = if namespace == "phase7c-funding" {
        let destination: Value = serde_json::from_slice(&fs::read(root.join(".state/phase7c/profile.json"))?)?;
        let target = root.join(".state/phase7c").join(destination["id"].as_str().context("destination profile missing")?).join("payer-watch/watch-only.json");
        let exact: Value = serde_json::from_slice(&fs::read(target)?)?;
        ensure!(exact["keyId"] == m["keyId"] && exact["address"] == config["addresses"]["settlement"], "funding receiver ownership conflict");
        exact
    } else { m };
    let address = m["address"]
        .as_str()
        .context("settlement address missing")?
        .to_owned();
    validate_shielded_destination(&address)?;
    let source_namespace = if namespace == "phase7c" && config["payerSourceProfileId"].is_string() {
        let source: Value = serde_json::from_slice(&fs::read(root.join(".state/phase7b/profile.json"))?)?;
        ensure!(source["id"] == config["payerSourceProfileId"] && source["network"] == "zcash-testnet" && source["status"] == "READY", "explicit source profile binding conflict");
        "phase7b"
    } else { namespace };
    let source_profile = if source_namespace == "phase7b" && namespace == "phase7c" { config["payerSourceProfileId"].as_str().context("source profile missing")?.to_owned() } else { profile.to_string() };
    let key = root
        .join(format!(".secrets/{source_namespace}"))
        .join(source_profile)
        .join("payer/viewing-key.txt");
    Ok((key, address))
}
pub async fn prepare(
    path: &Path,
    server: &str,
    profile: uuid::Uuid,
    request: uuid::Uuid,
    birthday: u32,
) -> Result<Value> {
    prepare_for(path, server, profile, request, birthday, "phase52").await
}
pub async fn prepare_for(path: &Path, server: &str, profile: uuid::Uuid, request: uuid::Uuid, birthday:u32, namespace:&str) -> Result<Value> {
    let (key_file, address) = context_for(path, profile, request, namespace)?;
    // Bind all spending to A's locally generated viewing key before opening a DB.
    let mut bytes = Vec::new();
    std::io::stdin().take(33).read_to_end(&mut bytes)?;
    let secret = SecretVec::new(bytes);
    ensure!(secret.expose_secret().len() == 32, "isolated seed length");
    let usk = UnifiedSpendingKey::from_seed(&NET, secret.expose_secret(), 0u32.try_into().unwrap())
        .map_err(|_| anyhow!("isolated derivation failed"))?;
    let view = usk.to_unified_full_viewing_key();
    ensure!(
        view.encode(&NET)? == fs::read_to_string(key_file)?.trim(),
        "payer seed/viewing identity conflict"
    );
    if !path.exists() {
        fs::create_dir(path)?;
        write_new(&path.join("network"), b"zcash-testnet")?;
        write_new(
            &path.join("phase52-payer.json"),
            serde_json::to_vec(
                &json!({"profileId":profile.to_string(),"network":"zcash-testnet"}),
            )?
            .as_slice(),
        )?;
    }
    let marker: Value = serde_json::from_slice(&fs::read(path.join("phase52-payer.json"))?)?;
    ensure!(
        marker["profileId"] == profile.to_string() && marker["network"] == "zcash-testnet",
        "payer marker conflict"
    );
    let _lock = lock_wallet(path)?;
    let mut client = connect(server).await?;
    let tree = client
        .get_tree_state(service::BlockId {
            height: u64::from(birthday),
            hash: vec![],
        })
        .await?
        .into_inner();
    ensure!(
        tree.network == "test" && tree.height == u64::from(birthday),
        "payer birthday conflict"
    );
    let birth = AccountBirthday::from_treestate(tree, None)?;
    let mut wallet = db(path)?;
    init_wallet_db(
        &mut wallet,
        Some(SecretVec::new(secret.expose_secret().to_vec())),
    )?;
    let id = if let Some(account) = wallet.get_account_for_ufvk(&view)? {
        account.id()
    } else {
        ensure!(
            wallet.get_account_ids()?.is_empty(),
            "unexpected isolated payer account"
        );
        let (id, _) = wallet.create_account("phase52-payer-only", &secret, &birth, None)?;
        id
    };
    ensure!(
        wallet.get_account_for_ufvk(&view)?.is_some(),
        "new account identity mismatch"
    );
    send(
        &mut wallet,
        &mut client,
        path,
        &id.expose_uuid().to_string(),
        &address,
        if namespace == "phase7c-funding" { 200_000 } else { PAYMENT },
        request,
        false,
        Some(FEE_CAP),
        true,
        Some(&secret),
    )
    .await
}
fn claim(path: &Path, request: uuid::Uuid, txid: &str, expiry: u32) -> Result<()> {
    write_new(
        &path.join(format!("request-{request}.broadcast.started.json")),
        serde_json::to_vec(&json!({"txid":txid,"expiryHeight":expiry,"network":"zcash-testnet"}))?
            .as_slice(),
    )
}
pub async fn inspect(
    path: &Path,
    server: &str,
    profile: uuid::Uuid,
    request: uuid::Uuid,
) -> Result<Value> {
    inspect_for(path,server,profile,request,"phase52").await
}
pub async fn inspect_for(path:&Path,server:&str,profile:uuid::Uuid,request:uuid::Uuid,namespace:&str)->Result<Value>{
    context_for(path, profile, request, namespace)?;
    let raw = fs::read(path.join(format!("request-{request}.raw")))?;
    let tx = zcash_primitives::transaction::Transaction::read(
        raw.as_slice(),
        zcash_protocol::consensus::BranchId::Nu7,
    )?;
    let id = tx.txid();
    let mut c = connect(server).await?;
    let tip = c
        .get_latest_block(service::ChainSpec::default())
        .await?
        .into_inner()
        .height;
    let (status, height) = match c
        .get_transaction(service::TxFilter {
            hash: id.as_ref().to_vec(),
            ..Default::default()
        })
        .await
    {
        Ok(r) => {
            let r = r.into_inner();
            ensure!(r.data == raw, "provider transaction bytes differ");
            if r.height > 0 && r.height <= tip {
                ("provider-reports-mined", Some(r.height))
            } else {
                ("provider-knows-unmined", None)
            }
        }
        Err(e) if e.code() == tonic::Code::NotFound => ("not-found-on-this-provider", None),
        Err(_) => ("provider-lookup-unavailable", None),
    };
    Ok(
        json!({"network":"zcash-testnet","txid":id.to_string(),"tip":tip,"expiryHeight":u32::from(tx.expiry_height()),"status":status,"minedHeight":height,"scannersMustVerify":true,"rebroadcastAttempted":false,"replacementAuthorized":false}),
    )
}
pub async fn broadcast(
    path: &Path,
    server: &str,
    profile: uuid::Uuid,
    request: uuid::Uuid,
    approved: &str,
) -> Result<Value> {
    broadcast_for(path,server,profile,request,approved,"phase52").await
}
pub async fn broadcast_for(path:&Path,server:&str,profile:uuid::Uuid,request:uuid::Uuid,approved:&str,namespace:&str)->Result<Value>{
    let (_, address) = context_for(path, profile, request, namespace)?;
    let _lock = lock_wallet(path)?;
    let record: Value =
        serde_json::from_slice(&fs::read(path.join(format!("request-{request}.json")))?)?;
    ensure!(
        record["recipient"] == address && record["zatoshis"] == (if namespace == "phase7c-funding" { 200_000 } else { PAYMENT }).to_string(),
        "payment effects binding conflict"
    );
    let fee = record["feeZatoshis"]
        .as_str()
        .context("missing fee")?
        .parse::<u64>()?;
    enforce_fee_approval(fee, Some(FEE_CAP))?;
    let raw = fs::read(path.join(format!("request-{request}.raw")))?;
    let tx = zcash_primitives::transaction::Transaction::read(
        raw.as_slice(),
        zcash_protocol::consensus::BranchId::Nu7,
    )?;
    let txid = tx.txid().to_string();
    let expiry = u32::from(tx.expiry_height());
    ensure!(
        record["txid"] == txid && approved == txid && record["expiryHeight"] == expiry,
        "exact transaction approval mismatch"
    );
    let mut client = connect(server).await?;
    let tip = u32::try_from(
        client
            .get_latest_block(service::ChainSpec::default())
            .await?
            .into_inner()
            .height,
    )?;
    ensure!(
        expiry > tip,
        "prepared transaction expired; no replacement authorized"
    );
    claim(path, request, &txid, expiry)?; // Exclusive claim BEFORE the only network submission.
    let response = client
        .send_transaction(service::RawTransaction {
            data: raw,
            height: 0,
        })
        .await?
        .into_inner();
    let result = json!({"network":"zcash-testnet","txid":txid,"expiryHeight":expiry,"status":if response.error_code==0{"broadcast-not-confirmed"}else{"broadcast-rejected"},"errorCode":response.error_code,"confirmed":false});
    write_new(
        &path.join(format!("request-{request}.broadcast.json")),
        serde_json::to_vec(&result)?.as_slice(),
    )?;
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn phase7b_rejects_historical_profile_paths_before_reading_files() {
        let id=uuid::Uuid::new_v4();
        let old=std::env::current_dir().unwrap().join(".state/phase52").join(id.to_string()).join("payer-native");
        assert!(context_for(&old,id,id,"phase7b").is_err());
        assert!(context_for(Path::new(".secrets/user/zcash"),id,id,"phase7b").is_err());
    }
    #[test]
    fn phase7c_rejects_historical_paths_and_arbitrary_namespaces() {
        let id=uuid::Uuid::new_v4();
        let old=std::env::current_dir().unwrap().join(".state/phase7b").join(id.to_string()).join("payer-native");
        assert!(context_for(&old,id,id,"phase7c").is_err());
        assert!(context_for(&old,id,id,"../phase7b").is_err());
        assert!(context_for(Path::new(".secrets/user/zcash"),id,id,"phase7c").is_err());
    }
    #[test]
    fn a_broadcast_claim_survives_restart_and_prevents_duplicate_submission() {
        let d = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4();
        claim(d.path(), id, &"a".repeat(64), 100).unwrap();
        let before = fs::read(
            d.path()
                .join(format!("request-{id}.broadcast.started.json")),
        )
        .unwrap();
        assert!(claim(d.path(), id, &"a".repeat(64), 100).is_err());
        assert_eq!(
            fs::read(
                d.path()
                    .join(format!("request-{id}.broadcast.started.json"))
            )
            .unwrap(),
            before
        );
    }
    #[test]
    fn old_wallet_paths_are_rejected_before_seed_or_wallet_access() {
        assert!(
            context(
                Path::new(".secrets/user/zcash"),
                uuid::Uuid::new_v4(),
                uuid::Uuid::new_v4()
            )
            .is_err()
        );
    }
}
