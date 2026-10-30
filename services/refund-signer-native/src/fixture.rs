//! SYNTHETIC note/anchor fixture, never a real chain payment. Fresh OS randomness.
use crate::{Input, Policy};
use anyhow::{Result, anyhow};
use orchard::{
    Note,
    keys::{FullViewingKey, Scope, SpendingKey},
    note::{ExtractedNoteCommitment, NoteVersion, RandomSeed, Rho},
    tree::{MerkleHashOrchard, MerklePath},
    value::NoteValue,
};
use pczt::roles::{creator::Creator, io_finalizer::IoFinalizer};
use rand::{Rng, rand_core::UnwrapErr, rngs::SysRng};
use zcash_keys::address::UnifiedAddress;
use zcash_primitives::transaction::{
    builder::{BuildConfig, Builder, BundlePadding},
    fees::zip317,
};
use zcash_protocol::{consensus::Network, memo::MemoBytes, value::Zatoshis};
use zeroize::Zeroizing;
pub struct Fixture {
    pub key: Zeroizing<[u8; 32]>,
    pub pczt: Vec<u8>,
    pub policy: Policy,
}
pub fn generate(now: u64, foreign_change: bool) -> Result<Fixture> {
    let mut rng = UnwrapErr(SysRng);
    let mut key = Zeroizing::new([0u8; 32]);
    let sk = loop {
        rng.fill_bytes(&mut *key);
        if let Some(sk) = SpendingKey::from_bytes(*key).into_option() {
            break sk;
        }
    };
    let fvk = FullViewingKey::from(&sk);
    let mut user_key = Zeroizing::new([0u8; 32]);
    let user_sk = loop {
        rng.fill_bytes(&mut *user_key);
        if let Some(sk) = SpendingKey::from_bytes(*user_key).into_option() {
            break sk;
        }
    };
    let user = FullViewingKey::from(&user_sk).address_at(0u32, Scope::External);
    let rho = loop {
        let mut b = [0u8; 32];
        rng.fill_bytes(&mut b);
        if let Some(r) = Rho::from_bytes(&b).into_option() {
            break r;
        }
    };
    let note = loop {
        let mut b = [0u8; 32];
        rng.fill_bytes(&mut b);
        if let Some(rseed) = RandomSeed::from_bytes(b, &rho).into_option() {
            if let Some(n) = Note::from_parts(
                fvk.address_at(0u32, Scope::External),
                NoteValue::from_raw(1_000_000),
                rho,
                rseed,
                NoteVersion::V3,
            )
            .into_option()
            {
                break n;
            }
        }
    };
    let witness = MerklePath::from_parts(0, [MerkleHashOrchard::from_bytes(&[0; 32]).unwrap(); 32]);
    let anchor = witness.root(ExtractedNoteCommitment::from(note.commitment()));
    let nullifier = note.nullifier(&fvk).to_bytes();
    let tip = 4_500_000;
    let mut builder = Builder::new(
        Network::TestNetwork,
        tip.into(),
        BuildConfig::Standard {
            sapling_anchor: None,
            orchard_anchor: None,
            ironwood_anchor: Some(anchor),
            orchard_padding: BundlePadding::DEFAULT,
            ironwood_padding: BundlePadding::DEFAULT,
        },
    );
    builder
        .add_ironwood_spend::<zip317::FeeRule>(fvk.clone(), note, witness)
        .map_err(|_| anyhow!("fixture_spend"))?;
    for (recipient, value) in [
        (user, 900_000),
        (
            if foreign_change {
                user
            } else {
                fvk.address_at(0u32, Scope::Internal)
            },
            90_000,
        ),
    ] {
        builder
            .add_ironwood_output::<zip317::FeeRule>(
                Some(fvk.to_ovk(Scope::External)),
                recipient,
                Zatoshis::from_u64(value)?,
                MemoBytes::empty(),
            )
            .map_err(|_| anyhow!("fixture_output"))?;
    }
    let parts = builder
        .build_for_pczt(&mut rng, &zip317::FeeRule::standard())
        .map_err(|_| anyhow!("fixture_build"))?;
    let pczt = IoFinalizer::new(
        Creator::build_from_parts(parts.pczt_parts).ok_or_else(|| anyhow!("fixture_pczt"))?,
    )
    .finalize_io(&mut rng)
    .map_err(|_| anyhow!("fixture_finalize"))?
    .serialize()
    .map_err(|_| anyhow!("fixture_encoding"))?;
    let mut id = [0u8; 32];
    rng.fill_bytes(&mut id);
    let policy = Policy {
        version: 1,
        network: "zcash-testnet".into(),
        request_digest: crate::hash(b"SYNTHETIC independent request fixture"),
        order_id: format!("0x{}", hex::encode(id)),
        destination: UnifiedAddress::from_receivers(Some(user), None, None, None, None)
            .unwrap()
            .encode(&Network::TestNetwork),
        refund_zatoshis: "900000".into(),
        fee_ceiling_zatoshis: "20000".into(),
        eligible_zatoshis: "1000000".into(),
        full_viewing_key: hex::encode(fvk.to_bytes()),
        anchor: hex::encode(anchor.to_bytes()),
        tip,
        observed_at: now,
        expires_at: now + 300,
        inputs: vec![Input {
            nullifier: hex::encode(nullifier),
            zatoshis: "1000000".into(),
            mined_height: tip - 9,
        }],
    };
    Ok(Fixture { key, pczt, policy })
}
