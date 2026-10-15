//! Fixed-purpose, UFVK-only export from a confirmed real test payment.
use super::*;
use std::num::{NonZeroU32, NonZeroUsize};
use zcash_client_backend::{
    data_api::wallet::{
        ConfirmationsPolicy, create_pczt_from_proposal,
        input_selection::{GreedyInputSelector, SpendPolicy},
        propose_transfer,
    },
    fees::{DustOutputPolicy, SplitPolicy, StandardFeeRule, standard::MultiOutputChangeStrategy},
    wallet::OvkPolicy,
};
use zcash_protocol::{ShieldedPool, consensus::BlockHeight, value::Zatoshis};
pub async fn prepare(path: &Path, id: &str) -> Result<Value> {
    ensure!(
        id.len() == 36 && id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-'),
        "invalid_profile_id"
    );
    let root = std::env::current_dir()?.join(".state/phase52").join(id);
    ensure!(
        path == root.join("backend/wallet-b-watch"),
        "new_backend_watch_required"
    );
    let config: Value = serde_json::from_slice(&fs::read(
        std::env::current_dir()?.join(".state/phase52-profile.json"),
    )?)?;
    ensure!(
        config["id"] == id
            && config["network"] == "zcash-testnet"
            && config["liveRefundsEnabled"] == false,
        "profile_conflict"
    );
    let order = config["paymentRequestId"].as_str().context("order_id")?;
    let orders = rusqlite::Connection::open_with_flags(
        root.join("backend/settlement.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let state: String = orders.query_row(
        "SELECT state FROM settlement_lifecycle WHERE id=?",
        [order],
        |r| r.get(0),
    )?;
    let veto: u32 = orders.query_row(
        "SELECT count(*) FROM phase52_execution_veto WHERE id=?",
        [order],
        |r| r.get(0),
    )?;
    ensure!(
        state == "RECOVERY_REQUIRED" && veto == 1,
        "confirmed_recovery_veto_required"
    );
    let review: String = orders.query_row(
        "SELECT review FROM phase52_test_orders WHERE id=?",
        [order],
        |r| r.get(0),
    )?;
    let review: Value = serde_json::from_str(&review)?;
    drop(orders);
    let dest: Value = serde_json::from_slice(&fs::read(
        root.join("refund-destination-watch/watch-only.json"),
    )?)?;
    let address = dest["address"].as_str().context("destination")?;
    let snapshot = observe(path).await?;
    let inputs = snapshot["native"]["inputs"].as_array().context("inputs")?;
    ensure!(
        inputs.len() == 1 && inputs[0]["zatoshis"] == "100000",
        "single_expected_payment_input_required"
    );
    let tip = snapshot["tip"].as_u64().context("tip")?;
    let mined = inputs[0]["minedHeight"].as_u64().context("mined")?;
    ensure!(tip >= mined + 9, "ten_confirmations_required");
    let expected = format!("{}:4:", review["txid"].as_str().context("txid")?);
    ensure!(
        inputs[0]["paymentKey"]
            .as_str()
            .context("payment_key")?
            .starts_with(&expected),
        "input_attribution_conflict"
    );
    let manifest = inspect_directory(path)?;
    let lock = path.join("process.lock");
    write_new(&lock, std::process::id().to_string().as_bytes())?;
    let _guard = Lock(lock);
    let mut db = database(path)?;
    let account = db.get_account_ids()?;
    ensure!(account.len() == 1, "single_account_required");
    let payment = zcash_client_backend::zip321::Payment::new(
        address.parse()?,
        Some(Zatoshis::from_u64(90000)?),
        None,
        None,
        None,
        vec![],
    );
    let payment = payment.context("invalid_refund_payment")?;
    let request = zcash_client_backend::zip321::TransactionRequest::new(vec![payment])?;
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
        &mut db,
        &NET,
        account[0],
        &GreedyInputSelector::new(),
        &change,
        request,
        ConfirmationsPolicy::new_symmetrical(NonZeroU32::new(10).unwrap(), false),
        &SpendPolicy::default(),
        None,
        None,
    )
    .map_err(|_| anyhow::anyhow!("unsigned_refund_proposal_failed"))?;
    ensure!(
        proposal.steps().len() == 1
            && proposal.steps().first().balance().fee_required().into_u64() == 10000,
        "exact_refund_fee_required"
    );
    let expiry = BlockHeight::from(proposal.min_target_height()) + 39;
    let output = root.join("transfer/unsigned-refund.pczt");
    let claim = root.join("unsigned-refund.started.json");
    ensure!(
        !output.exists() && !claim.exists(),
        "unsigned_refund_already_claimed_no_regeneration"
    );
    write_new(&claim,serde_json::to_vec(&json!({"orderId":order,"refundRequestId":config["refundRequestId"],"expiryHeight":u32::from(expiry),"signingEnabled":false}))?.as_slice())?;
    let pczt = create_pczt_from_proposal::<
        _,
        _,
        std::convert::Infallible,
        _,
        std::convert::Infallible,
        _,
    >(
        &mut db,
        &NET,
        &SystemClock,
        &mut rand::rng(),
        account[0],
        OvkPolicy::Sender,
        &proposal,
        Some(expiry),
        zcash_primitives::transaction::builder::BundlePadding::DEFAULT,
    )
    .map_err(|_| anyhow::anyhow!("unsigned_refund_pczt_failed"))?;
    ensure!(
        pczt.transparent().inputs().is_empty()
            && pczt.transparent().outputs().is_empty()
            && pczt.sapling().spends().is_empty()
            && pczt.sapling().outputs().is_empty()
            && pczt.orchard().actions().is_empty(),
        "ironwood_only_required"
    );
    let bytes = pczt
        .serialize()
        .map_err(|_| anyhow::anyhow!("pczt_serialization_failed"))?;
    ensure!(bytes.len() <= 262144, "pczt_size");
    fs::create_dir_all(output.parent().unwrap())?;
    write_new(&output, &bytes)?;
    let result = json!({"network":"zcash-testnet","profileId":id,"orderId":order,"requestId":config["refundRequestId"],"destination":address,"refundZatoshis":"90000","feeZatoshis":"10000","expiryHeight":u32::from(expiry),"anchorHeight":snapshot["native"]["anchorHeight"],"pcztSha256":hex::encode(Sha256::digest(&bytes)),"pcztBytes":bytes.len(),"account":manifest.key_id,"signed":false,"broadcast":false,"liveRefundsEnabled":false});
    write_new(
        &root.join("transfer/unsigned-refund.json"),
        serde_json::to_vec(&result)?.as_slice(),
    )?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn historical_wallet_paths_are_rejected_before_any_database_or_network_access() {
        assert!(
            prepare(
                Path::new(".secrets/user/zcash"),
                "11111111-1111-4111-8111-111111111111"
            )
            .await
            .is_err()
        );
        assert!(
            prepare(
                Path::new(".state/phase52/anything/backend/wallet-b-watch"),
                "../user"
            )
            .await
            .is_err()
        );
    }
}
