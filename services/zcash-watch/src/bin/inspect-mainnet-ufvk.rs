//! Offline validation and public-address derivation from a mainnet UFVK on
//! stdin. No seed, spending key, storage, signing or network access.
use anyhow::{Result, ensure};
use sha2::{Digest, Sha256};
use std::io::Read;
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
    println!(
        "{}",
        serde_json::json!({
            "network": "zcash-mainnet",
            "account": hex::encode(Sha256::digest(text.as_bytes())),
            "address": address.encode(&Network::MainNetwork),
            "ufvk": text,
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
