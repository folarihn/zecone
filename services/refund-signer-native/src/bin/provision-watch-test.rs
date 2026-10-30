//! Fresh isolated test keys only. No networking, existing key import, or signing.
use anyhow::Result;
use rand::{Rng, rand_core::UnwrapErr, rngs::SysRng};
use std::{fs::OpenOptions, io::Write};
use zcash_keys::keys::UnifiedSpendingKey;
use zcash_protocol::consensus::Network;
use zeroize::Zeroizing;
fn run() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    anyhow::ensure!(args.len() == 1, "new_directory_required");
    let dir = std::path::Path::new(&args[0]);
    std::fs::create_dir(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let mut seed = Zeroizing::new([0u8; 32]);
    UnwrapErr(SysRng).fill_bytes(&mut *seed);
    let usk = UnifiedSpendingKey::from_seed(
        &Network::TestNetwork,
        &*seed,
        0u32.try_into().expect("zero account"),
    )?;
    let ufvk = usk
        .to_unified_full_viewing_key()
        .encode(&Network::TestNetwork)?;
    for (name, data) in [
        ("isolated-seed.bin", seed.as_slice()),
        ("isolated-key.bin", usk.orchard().to_bytes().as_slice()),
        ("viewing-key.txt", ufvk.as_bytes()),
    ] {
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(dir.join(name))?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    println!(
        "{{\"network\":\"zcash-testnet\",\"freshIsolatedCredentials\":true,\"liveRefundsEnabled\":false}}"
    );
    Ok(())
}
fn main() {
    std::panic::set_hook(Box::new(|_| eprintln!("isolated_provision_failed")));
    if run().is_err() {
        eprintln!("isolated_provision_failed");
        std::process::exit(1);
    }
}
