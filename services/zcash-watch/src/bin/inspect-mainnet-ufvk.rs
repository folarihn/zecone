//! Offline validation and public-address derivation from a mainnet UFVK on
//! stdin. It prints no viewing key, seed or spending key. No storage, signing or
//! network access.
use anyhow::{Result, ensure};
use sha2::{Digest, Sha256};
use std::io::Read;
use zcash_keys::address::UnifiedAddress;
use zcash_keys::keys::{UnifiedAddressRequest, UnifiedFullViewingKey};
use zcash_protocol::consensus::Network;

fn run() -> Result<()> {
    let mut text = String::new();
    std::io::stdin().take(4097).read_to_string(&mut text)?;
    let text = text.trim();
    ensure!(!text.is_empty() && text.len() <= 4096, "invalid_ufvk_size");
    let ufvk = UnifiedFullViewingKey::decode(&Network::MainNetwork, text)
        .map_err(|_| anyhow::anyhow!("invalid_mainnet_ufvk"))?;
    ensure!(ufvk.orchard().is_some(), "orchard_viewing_key_required");
    let (address, _) = ufvk.default_address(UnifiedAddressRequest::SHIELDED)?;
    let (all, _) = ufvk.default_address(UnifiedAddressRequest::AllAvailableKeys)?;
    let (orchard, _) = ufvk.default_address(UnifiedAddressRequest::ORCHARD)?;
    let target = std::env::args()
        .nth(1)
        .map(|s| {
            UnifiedAddress::decode(&Network::MainNetwork, &s)
                .map_err(|_| anyhow::anyhow!("invalid_target_address"))
        })
        .transpose()?;
    let configured = std::env::args()
        .nth(2)
        .map(|s| {
            UnifiedAddress::decode(&Network::MainNetwork, &s)
                .map_err(|_| anyhow::anyhow!("invalid_configured_address"))
        })
        .transpose()?;
    println!(
        "{}",
        serde_json::json!({
            "network": "zcash-mainnet",
            "account": hex::encode(Sha256::digest(text.as_bytes())),
            "address": address.encode(&Network::MainNetwork),
            "allReceiversAddress": all.encode(&Network::MainNetwork),
            "orchardOnlyAddress": orchard.encode(&Network::MainNetwork),
            "targetMatchesAllReceiversDefault": target.as_ref().map(|t|t.encode(&Network::MainNetwork)==all.encode(&Network::MainNetwork)),
            "targetOrchardReceiverMatchesDefault": target.as_ref().map(|t|t.orchard().is_some()&&t.orchard()==orchard.orchard()),
            "targetShieldedDiversifierOwned": target.as_ref().map(|t|!ufvk.to_unified_incoming_viewing_key().decrypt_diversifiers(t).is_empty()),
            "configuredDefaultShieldedDiversifierOwned": configured.as_ref().map(|t|!ufvk.to_unified_incoming_viewing_key().decrypt_diversifiers(t).is_empty()),
            "targetAndConfiguredOrchardReceiverEqual": target.as_ref().zip(configured.as_ref()).map(|(t,c)|t.orchard().is_some()&&t.orchard()==c.orchard()),
            "ufvkValid": true,
            "spendingKeyRetained": false
        })
    );
    Ok(())
}

fn main() {
    std::panic::set_hook(Box::new(|_| eprintln!("mainnet_ufvk_inspection_failed")));
    if run().is_err() {
        eprintln!("mainnet_ufvk_inspection_failed");
        std::process::exit(1);
    }
}
