//! Offline derivation of a mainnet UFVK from a 32-byte seed supplied on stdin.
//! It writes only the viewing key to an explicitly selected new file and prints
//! public metadata. It never signs, stores the seed, or opens a network connection.
use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::PathBuf;
use zcash_keys::keys::{UnifiedAddressRequest, UnifiedSpendingKey};
use zcash_protocol::consensus::Network;
use zeroize::Zeroizing;

fn output_path() -> Result<PathBuf> {
    let mut args = std::env::args().skip(1);
    ensure!(args.next().as_deref() == Some("--out"), "ufvk_out_required");
    let path = args.next().context("ufvk_out_required")?;
    ensure!(args.next().is_none(), "unexpected_arguments");
    Ok(PathBuf::from(path))
}

fn write_new(path: &PathBuf, data: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(data)?;
    file.sync_all()?;
    Ok(())
}

fn run() -> Result<()> {
    let out = output_path()?;
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
    write_new(&out, encoded.as_bytes())?;
    println!(
        "{}",
        serde_json::json!({
            "network": "zcash-mainnet",
            "account": hex::encode(Sha256::digest(encoded.as_bytes())),
            "address": address.encode(&Network::MainNetwork),
            "ufvkWritten": true,
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
