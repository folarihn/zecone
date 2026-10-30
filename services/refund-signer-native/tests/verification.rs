use pczt::{Pczt, roles::redactor::Redactor};
use zecone_refund_signer::{fixture, review, sign_isolated};
const NOW: u64 = 1_900_000_000;
#[test]
#[ignore = "expensive isolated proof/extraction; run explicitly, never broadcasts"]
fn signed_synthetic_pczt_proves_and_extracts_a_native_transaction() {
    use orchard::circuit::{OrchardCircuitVersion, ProvingKey};
    use pczt::roles::{prover::Prover, tx_extractor::TransactionExtractor};
    use rand::{rand_core::UnwrapErr, rngs::SysRng};
    let f = fixture::generate(NOW, false).unwrap();
    let r = review(&f.pczt, &f.policy, NOW).unwrap();
    let (signed, _) = sign_isolated(&f.pczt, &f.policy, NOW, &r.review_digest, &f.key).unwrap();
    let proving_key = ProvingKey::build(OrchardCircuitVersion::PostNu6_3);
    let proved = Prover::new(Pczt::parse(&signed).unwrap())
        .create_ironwood_proof(UnwrapErr(SysRng), &proving_key)
        .unwrap()
        .finish();
    let tx = TransactionExtractor::new(proved)
        .extract(UnwrapErr(SysRng))
        .unwrap();
    assert_eq!(u32::from(tx.expiry_height()), f.policy.tip + 40);
    let mut serialized = Vec::new();
    tx.write(&mut serialized).unwrap();
    assert!(!serialized.is_empty());
    // No txid is published: this synthetic anchor is not evidence of a chain payment.
}
#[test]
fn encrypted_output_tampering_is_not_accepted_as_a_valid_plaintext_hint() {
    let f = fixture::generate(NOW, false).unwrap();
    let parsed = Pczt::parse(&f.pczt).unwrap();
    let ciphertext = parsed
        .ironwood()
        .actions()
        .iter()
        .find(|a| a.output().value().is_some_and(|v| v > 0))
        .unwrap()
        .output()
        .enc_ciphertext()
        .clone()
        .into_encrypted()
        .unwrap();
    let at = f
        .pczt
        .windows(ciphertext.len())
        .position(|b| b == ciphertext)
        .unwrap();
    let mut corrupted = f.pczt.clone();
    corrupted[at + ciphertext.len() - 1] ^= 1;
    assert!(Pczt::parse(&corrupted).is_ok());
    assert!(review(&corrupted, &f.policy, NOW).is_err());
}
#[test]
fn genuine_native_signatures_bind_reviewed_synthetic_transaction() {
    let f = fixture::generate(NOW, false).unwrap();
    let r = review(&f.pczt, &f.policy, NOW).unwrap();
    assert_eq!(r.fee_zatoshis, "10000");
    assert_eq!(r.change_zatoshis, "90000");
    assert!(!r.live_enabled);
    let (signed, after) = sign_isolated(&f.pczt, &f.policy, NOW, &r.review_digest, &f.key).unwrap();
    assert_eq!(r, after);
    assert_ne!(signed, f.pczt);
    assert!(review(&signed, &f.policy, NOW).is_err());
    assert!(sign_isolated(&f.pczt, &f.policy, NOW, "unreviewed", &f.key).is_err());
}
#[test]
fn substitution_fee_network_age_input_and_amount_checks() {
    let f = fixture::generate(NOW, false).unwrap();
    for mutation in 0..10 {
        let mut p = f.policy.clone();
        match mutation {
            0 => p.network = "mainnet".into(),
            1 => p.refund_zatoshis = "899999".into(),
            2 => p.fee_ceiling_zatoshis = "9999".into(),
            3 => p.observed_at = NOW - 121,
            4 => p.inputs[0].mined_height = p.tip - 8,
            5 => p.inputs[0].nullifier = "00".repeat(32),
            6 => p.anchor = "00".repeat(32),
            7 => p.eligible_zatoshis = "2100000000000001".into(),
            8 => p.expires_at = NOW,
            _ => p.inputs.push(p.inputs[0].clone()),
        }
        assert!(review(&f.pczt, &p, NOW).is_err(), "mutation {mutation}");
    }
    let other = fixture::generate(NOW, false).unwrap();
    let r = review(&f.pczt, &f.policy, NOW).unwrap();
    assert!(sign_isolated(&f.pczt, &f.policy, NOW, &r.review_digest, &other.key).is_err());
    let mut p = f.policy.clone();
    p.destination = other.policy.destination;
    assert!(review(&f.pczt, &p, NOW).is_err());
}
#[test]
fn foreign_change_and_missing_effects_are_rejected() {
    let malicious = fixture::generate(NOW, true).unwrap();
    assert!(review(&malicious.pczt, &malicious.policy, NOW).is_err());
    let f = fixture::generate(NOW, false).unwrap();
    for field in 0..5 {
        let redacted = Redactor::new(Pczt::parse(&f.pczt).unwrap())
            .redact_ironwood_with(|mut bundle| {
                if field == 4 {
                    bundle.clear_anchor();
                } else {
                    bundle.redact_actions(|mut a| match field {
                        0 => a.clear_spend_value(),
                        1 => a.clear_rcv(),
                        2 => a.clear_spend_witness(),
                        _ => a.clear_output_value(),
                    });
                }
            })
            .finish()
            .serialize()
            .unwrap();
        assert!(
            review(&redacted, &f.policy, NOW).is_err(),
            "redaction {field}"
        );
    }
}
