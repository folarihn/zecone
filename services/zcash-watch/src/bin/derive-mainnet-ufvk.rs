//! Offline derivation of a mainnet UFVK from a 32-byte seed supplied on stdin.
//! It prints only the public viewing key, address and account identifier. It
//! never signs, stores the seed, or opens a network connection.
use anyhow::{Result, ensure};
use sha2::{Digest, Sha256};
use std::io::Read;
use zcash_keys::keys::{UnifiedAddressRequest, UnifiedSpendingKey};
use zcash_protocol::consensus::Network;
use zeroize::Zeroizing;

fn run() -> Result<()> {
    let mut seed = Zeroizing::new([0u8; 32]);
    std::io::stdin().read_exact(&mut *seed)?;
    let mut extra = [0u8; 1];
    ensure!(
        std::io::stdin().read(&mut extra)? == 0,
        "seed_must_be_32_bytes"
    );
    let key = UnifiedSpendingKey::from_seed(
        &Network::MainNetwork,
        &*seed,
        0u32.try_into()
            .map_err(|_| anyhow::anyhow!("invalid_account"))?,
    )?;
    let ufvk = key.to_unified_full_viewing_key();
    let encoded = ufvk.encode(&Network::MainNetwork)?;
    let (address, _) = ufvk.default_address(UnifiedAddressRequest::SHIELDED)?;
    println!(
        "{}",
        serde_json::json!({
            "network": "zcash-mainnet",
            "account": hex::encode(Sha256::digest(encoded.as_bytes())),
            "address": address.encode(&Network::MainNetwork),
            "ufvk": encoded,
            "spendingKeyRetained": false
        })
    );
    Ok(())
}

fn main() {
    std::panic::set_hook(Box::new(|_| eprintln!("mainnet_ufvk_derivation_failed")));
    if run().is_err() {
        eprintln!("mainnet_ufvk_derivation_failed");
        std::process::exit(1);
    }
}
