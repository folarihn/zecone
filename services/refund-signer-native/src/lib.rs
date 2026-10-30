//! Strict isolated-development Ironwood refund signer. No wallet files, network,
//! broadcasting, key derivation paths supplied by a backend, or live-enable switch.
pub mod fixture;
use anyhow::{Result, anyhow, ensure};
use orchard::{
    Note,
    keys::{FullViewingKey, Scope, SpendAuthorizingKey, SpendingKey},
    note::ExtractedNoteCommitment,
};
use pczt::{
    Pczt,
    roles::{
        signer::Signer,
        verifier::{OrchardError, Verifier},
    },
};
use rand::{rand_core::UnwrapErr, rngs::SysRng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zcash_keys::address::Address;
use zcash_protocol::{
    consensus::{BlockHeight, BranchId, Network},
    constants::{V6_TX_VERSION, V6_VERSION_GROUP_ID},
};

pub const MAX_PCZT: usize = 262_144;
const MAX_MONEY: u64 = 2_100_000_000_000_000;
pub fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn bytes<const N: usize>(s: &str) -> Result<[u8; N]> {
    ensure!(
        s.len() == N * 2
            && s.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
        "invalid_hex"
    );
    hex::decode(s)?
        .try_into()
        .map_err(|_| anyhow!("invalid_hex"))
}
fn money(s: &str) -> Result<u64> {
    ensure!(
        !s.is_empty()
            && s.len() <= 16
            && s.bytes().all(|c| c.is_ascii_digit())
            && (s == "0" || !s.starts_with('0')),
        "invalid_amount"
    );
    let n: u64 = s.parse()?;
    ensure!(n <= MAX_MONEY, "amount_limit");
    Ok(n)
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Input {
    pub nullifier: String,
    pub zatoshis: String,
    pub mined_height: u32,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Policy {
    pub version: u32,
    pub network: String,
    pub request_digest: String,
    pub order_id: String,
    pub destination: String,
    pub refund_zatoshis: String,
    pub fee_ceiling_zatoshis: String,
    pub eligible_zatoshis: String,
    pub full_viewing_key: String,
    pub anchor: String,
    pub tip: u32,
    pub observed_at: u64,
    pub expires_at: u64,
    pub inputs: Vec<Input>,
}
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub request_digest: String,
    pub pczt_digest: String,
    pub review_digest: String,
    pub shielded_sighash: String,
    pub refund_zatoshis: String,
    pub fee_zatoshis: String,
    pub change_zatoshis: String,
    pub expiry_height: u32,
    pub signed_inputs: usize,
    pub live_enabled: bool,
}
fn fvkey(p: &Policy) -> Result<FullViewingKey> {
    FullViewingKey::from_bytes(&bytes(&p.full_viewing_key)?)
        .ok_or_else(|| anyhow!("invalid_viewing_key"))
}
fn checked(pczt_bytes: &[u8], p: &Policy, now: u64) -> Result<(Pczt, Review, Vec<usize>)> {
    ensure!(
        p.version == 1 && p.network == "zcash-testnet" && pczt_bytes.len() <= MAX_PCZT,
        "testnet_policy_required"
    );
    bytes::<32>(&p.request_digest)?;
    ensure!(
        p.order_id.len() == 66 && p.order_id.starts_with("0x"),
        "invalid_order_id"
    );
    bytes::<32>(&p.order_id[2..])?;
    ensure!(
        p.observed_at <= now.saturating_add(5)
            && now.saturating_sub(p.observed_at) <= 120
            && p.expires_at > now
            && p.expires_at <= now.saturating_add(3600),
        "stale_policy"
    );
    ensure!(
        BranchId::for_height(&Network::TestNetwork, BlockHeight::from_u32(p.tip)) == BranchId::Nu7,
        "nu7_required"
    );
    let refund = money(&p.refund_zatoshis)?;
    let ceiling = money(&p.fee_ceiling_zatoshis)?;
    let eligible = money(&p.eligible_zatoshis)?;
    ensure!(
        refund > 0 && ceiling > 0 && refund.checked_add(ceiling).is_some_and(|n| n <= eligible),
        "refund_limit"
    );
    let fvk = fvkey(p)?;
    ensure!(p.destination.len() <= 512, "address_length");
    let destination = match Address::decode(&Network::TestNetwork, &p.destination) {
        Some(Address::Unified(ua))
            if ua.transparent().is_none()
                && ua.expiry_height().is_none()
                && ua.expiry_time().is_none() =>
        {
            *ua.orchard()
                .ok_or_else(|| anyhow!("ironwood_receiver_required"))?
        }
        _ => return Err(anyhow!("shielded_testnet_ua_required")),
    };
    ensure!(
        fvk.scope_for_address(&destination).is_none(),
        "refund_destination_must_be_external_user"
    );
    let expected_anchor = bytes::<32>(&p.anchor)?;
    ensure!(!p.inputs.is_empty() && p.inputs.len() <= 8, "input_count");
    let mut expected = std::collections::BTreeMap::new();
    for i in &p.inputs {
        ensure!(
            i.mined_height > 0 && p.tip.checked_sub(i.mined_height).is_some_and(|n| n >= 9),
            "unconfirmed_input"
        );
        let value = money(&i.zatoshis)?;
        ensure!(
            value > 0 && expected.insert(bytes::<32>(&i.nullifier)?, value).is_none(),
            "duplicate_input"
        );
    }
    let pczt = Pczt::parse(pczt_bytes).map_err(|_| anyhow!("invalid_pczt"))?;
    let g = pczt.global();
    ensure!(
        *g.coin_type() == 1
            && *g.consensus_branch_id() == u32::from(BranchId::Nu7)
            && *g.tx_version() == V6_TX_VERSION
            && *g.version_group_id() == V6_VERSION_GROUP_ID,
        "wrong_network_or_format"
    );
    ensure!(
        *g.tx_modifiable() == 0 && g.fallback_lock_time().unwrap_or(0) == 0,
        "mutable_or_timelocked_transaction"
    );
    let expiry = *g.expiry_height();
    ensure!(
        expiry > p.tip
            && expiry <= p.tip.saturating_add(40)
            && BranchId::for_height(&Network::TestNetwork, expiry.into()) == BranchId::Nu7,
        "transaction_expiry"
    );
    ensure!(
        pczt.transparent().inputs().is_empty()
            && pczt.transparent().outputs().is_empty()
            && pczt.sapling().spends().is_empty()
            && pczt.sapling().outputs().is_empty()
            && *pczt.sapling().value_sum() == 0
            && pczt.orchard().actions().is_empty()
            && *pczt.orchard().value_sum() == (0, false),
        "unsupported_pool"
    );
    ensure!(
        pczt.ironwood().anchor() == &Some(expected_anchor)
            && (2..=10).contains(&pczt.ironwood().actions().len())
            && *pczt.ironwood().flags() == 7,
        "ironwood_anchor_or_flags"
    );
    // Reject redacted/compacted ciphertexts; verification must inspect the exact bytes
    // that will be signed, not let the parser reconstruct a different encoding.
    ensure!(
        pczt.ironwood().actions().iter().all(|a| matches!(
            a.output().enc_ciphertext(),
            pczt::orchard::EncCiphertext::Encrypted(_)
        )),
        "full_ciphertexts_required"
    );
    let mut indexes = Vec::new();
    let (mut total_in, mut total_out, mut change, mut payments, mut changes) =
        (0u64, 0u64, 0u64, 0usize, 0usize);
    let pczt = Verifier::new(pczt)
        .with_ironwood::<anyhow::Error, _>(|bundle| {
            let check = (|| -> Result<()> {
                bundle
                    .verify_cross_address_restriction()
                    .map_err(|_| anyhow!("cross_address_restriction"))?;
                for (index, action) in bundle.actions().iter().enumerate() {
                    action
                        .verify_cv_net()
                        .map_err(|_| anyhow!("value_commitment"))?;
                    let s = action.spend();
                    s.verify_nullifier(Some(&fvk))
                        .map_err(|_| anyhow!("input_ownership_or_nullifier"))?;
                    s.verify_rk(Some(&fvk))
                        .map_err(|_| anyhow!("spend_verification_key"))?;
                    let input = s
                        .value()
                        .ok_or_else(|| anyhow!("missing_input_value"))?
                        .inner();
                    if input > 0 {
                        ensure!(
                            s.fvk().as_ref() == Some(&fvk) && s.spend_auth_sig().is_none(),
                            "preauthorized_or_foreign_input"
                        );
                        ensure!(
                            expected.remove(&s.nullifier().to_bytes()) == Some(input),
                            "unexpected_input"
                        );
                        let note = Note::from_parts(
                            s.recipient()
                                .ok_or_else(|| anyhow!("missing_input_recipient"))?,
                            s.value().unwrap(),
                            s.rho().ok_or_else(|| anyhow!("missing_rho"))?,
                            s.rseed().ok_or_else(|| anyhow!("missing_rseed"))?,
                            *s.note_version(),
                        )
                        .into_option()
                        .ok_or_else(|| anyhow!("invalid_note"))?;
                        let root = s
                            .witness()
                            .as_ref()
                            .ok_or_else(|| anyhow!("missing_witness"))?
                            .root(ExtractedNoteCommitment::from(note.commitment()));
                        ensure!(root.to_bytes() == expected_anchor, "input_witness_anchor");
                        total_in = total_in
                            .checked_add(input)
                            .ok_or_else(|| anyhow!("amount_overflow"))?;
                        indexes.push(index);
                    }
                    action
                        .output()
                        .verify_note_commitment(s)
                        .map_err(|_| anyhow!("output_commitment"))?;
                    let output = action
                        .output()
                        .value()
                        .ok_or_else(|| anyhow!("missing_output_value"))?
                        .inner();
                    total_out = total_out
                        .checked_add(output)
                        .ok_or_else(|| anyhow!("amount_overflow"))?;
                    if output == 0 {
                        continue;
                    } // Validated zero-value padding may use random ciphertext.
                    let recovered = action
                        .recover_output_with_ovk(
                            &fvk.to_ovk(Scope::External),
                            *bundle.bundle_version(),
                        )
                        .map_err(|_| anyhow!("unknown_encryption_domain"))?
                        .ok_or_else(|| anyhow!("output_ciphertext"))?;
                    ensure!(
                        recovered.0.value().inner() == output
                            && action.output().recipient().as_ref() == Some(&recovered.1),
                        "output_ciphertext_mismatch"
                    );
                    let mut empty_memo = [0u8; 512];
                    empty_memo[0] = 0xf6;
                    ensure!(recovered.2 == empty_memo, "unexpected_memo");
                    if recovered.1 == destination {
                        ensure!(output == refund, "wrong_refund_amount");
                        payments += 1;
                    } else {
                        ensure!(
                            fvk.scope_for_address(&recovered.1) == Some(Scope::Internal),
                            "foreign_change"
                        );
                        // Sender-side recovery alone cannot prove ownership of change.
                        ensure!(
                            action
                                .decrypt_output_with_ivk(
                                    &fvk.to_ivk(Scope::Internal).prepare(),
                                    *bundle.bundle_version()
                                )
                                .map_err(|_| anyhow!("change_domain"))?
                                .is_some(),
                            "change_not_decryptable"
                        );
                        change = change
                            .checked_add(output)
                            .ok_or_else(|| anyhow!("amount_overflow"))?;
                        changes += 1;
                    }
                }
                ensure!(
                    expected.is_empty()
                        && total_in == eligible
                        && total_in <= MAX_MONEY
                        && payments == 1
                        && changes <= 1,
                    "payment_shape_or_input_total"
                );
                Ok(())
            })();
            check.map_err(OrchardError::Custom)
        })
        .map_err(|_| anyhow!("transaction_effects_rejected"))?
        .finish();
    let fee = total_in
        .checked_sub(total_out)
        .ok_or_else(|| anyhow!("negative_fee"))?;
    use zcash_primitives::transaction::fees::zip317::{GRACE_ACTIONS, MARGINAL_FEE};
    let minimum_fee = (MARGINAL_FEE * pczt.ironwood().actions().len().max(GRACE_ACTIONS))
        .ok_or_else(|| anyhow!("fee_overflow"))?
        .into_u64();
    ensure!(
        fee >= minimum_fee && fee <= ceiling && *pczt.ironwood().value_sum() == (fee, false),
        "fee_or_value_balance"
    );
    let signer = Signer::new(pczt.clone()).map_err(|_| anyhow!("invalid_signing_structure"))?;
    let sighash = hex::encode(signer.shielded_sighash());
    let pczt_digest = hash(pczt_bytes);
    let mut binding = b"ZecOne isolated native refund review v1\0".to_vec();
    binding.extend(serde_json::to_vec(p)?);
    binding.extend(pczt_bytes);
    let review = Review {
        request_digest: p.request_digest.clone(),
        pczt_digest,
        review_digest: hash(&binding),
        shielded_sighash: sighash,
        refund_zatoshis: refund.to_string(),
        fee_zatoshis: fee.to_string(),
        change_zatoshis: change.to_string(),
        expiry_height: expiry,
        signed_inputs: indexes.len(),
        live_enabled: false,
    };
    Ok((pczt, review, indexes))
}
pub fn review(pczt: &[u8], p: &Policy, now: u64) -> Result<Review> {
    Ok(checked(pczt, p, now)?.1)
}
pub fn sign_isolated(
    pczt: &[u8],
    p: &Policy,
    now: u64,
    reviewed: &str,
    key: &[u8; 32],
) -> Result<(Vec<u8>, Review)> {
    let (pczt, review, indexes) = checked(pczt, p, now)?;
    ensure!(
        review.review_digest == reviewed,
        "explicit_native_review_required"
    );
    let sk = SpendingKey::from_bytes(*key)
        .into_option()
        .ok_or_else(|| anyhow!("invalid_isolated_key"))?;
    ensure!(
        FullViewingKey::from(&sk) == fvkey(p)?,
        "isolated_key_mismatch"
    );
    let ask = SpendAuthorizingKey::from(&sk);
    let mut signer = Signer::new(pczt.clone()).map_err(|_| anyhow!("invalid_signer"))?;
    for i in indexes {
        signer
            .sign_ironwood(UnwrapErr(SysRng), i, &ask)
            .map_err(|_| anyhow!("native_sign_failed"))?;
    }
    let signed = signer.finish();
    // Verify every returned native signature against the original transaction.
    let mut verifier = Signer::new(pczt).map_err(|_| anyhow!("invalid_signer"))?;
    for signature in pczt::roles::signer::extract_orchard_spend_auth_signatures(&signed) {
        verifier
            .apply_orchard_spend_auth_signature(&signature)
            .map_err(|_| anyhow!("native_signature_check"))?;
    }
    ensure!(
        hex::encode(
            Signer::new(signed.clone())
                .map_err(|_| anyhow!("signed_structure"))?
                .shielded_sighash()
        ) == review.shielded_sighash,
        "signed_effects_changed"
    );
    Ok((
        signed.serialize().map_err(|_| anyhow!("signed_encoding"))?,
        review,
    ))
}

/// Key-free proof/extraction of signatures applied to the reviewed ORIGINAL PCZT.
/// Only signatures are taken from the returned PCZT; its other fields are untrusted.
pub fn finalize_isolated(
    original: &[u8],
    signed: &[u8],
    p: &Policy,
    now: u64,
    reviewed: &str,
) -> Result<(Vec<u8>, String)> {
    use orchard::circuit::{OrchardCircuitVersion, ProvingKey};
    use pczt::roles::{prover::Prover, tx_extractor::TransactionExtractor};
    let (original, r, _) = checked(original, p, now)?;
    ensure!(
        r.review_digest == reviewed,
        "explicit_native_review_required"
    );
    ensure!(signed.len() <= MAX_PCZT, "signed_size");
    let signed = Pczt::parse(signed).map_err(|_| anyhow!("signed_pczt"))?;
    let mut verifier = Signer::new(original).map_err(|_| anyhow!("original_signer"))?;
    for s in pczt::roles::signer::extract_orchard_spend_auth_signatures(&signed) {
        verifier
            .apply_orchard_spend_auth_signature(&s)
            .map_err(|_| anyhow!("signature_rejected"))?;
    }
    let proved = Prover::new(verifier.finish())
        .create_ironwood_proof(
            UnwrapErr(SysRng),
            &ProvingKey::build(OrchardCircuitVersion::PostNu6_3),
        )
        .map_err(|_| anyhow!("proof_failed"))?
        .finish();
    let tx = TransactionExtractor::new(proved)
        .extract(UnwrapErr(SysRng))
        .map_err(|_| anyhow!("extraction_failed"))?;
    let mut raw = Vec::new();
    tx.write(&mut raw)?;
    Ok((raw, tx.txid().to_string()))
}
