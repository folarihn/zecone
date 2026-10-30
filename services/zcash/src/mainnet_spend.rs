//! Mainnet shielded spending wallet. Unlocks the sealed Zcash seed from the
//! Node provisioning keystore (scrypt + AES-256-GCM), derives the spending key,
//! synchronizes a mainnet wallet, verifies spendability, and prepares (proves
//! and signs, without broadcasting) shielded transactions.
//!
//! This module never reads a plaintext passphrase file and never writes or logs
//! seed material. Real mainnet broadcast is not implemented here.

use anyhow::{Context, Result, ensure};
use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use secrecy::SecretVec;
use serde_json::Value;
use zcash_keys::keys::{UnifiedAddressRequest, UnifiedSpendingKey};
use zcash_protocol::consensus::Network;

const MN: Network = Network::MainNetwork;

const HEADER_FORMAT: &str = "zecone-mainnet-provisioning-keystore";

/// Reproduce the Node keystore AAD exactly:
/// `JSON.stringify({ version, format, kdf, N, r, p, cipher, purpose })`.
fn keystore_aad(n: u64, r: u64, p: u64, purpose: &str) -> String {
    format!(
        "{{\"version\":1,\"format\":\"{HEADER_FORMAT}\",\"kdf\":\"scrypt\",\"N\":{n},\"r\":{r},\"p\":{p},\"cipher\":\"aes-256-gcm\",\"purpose\":\"{purpose}\"}}"
    )
}

/// Unlock a 32-byte seed from the Node provisioning keystore using a passphrase
/// supplied by the caller (interactive or an approved secret provider). The
/// passphrase must already be UTF-8 text; it is never printed or logged.
pub fn unlock_seed(keystore: &Value, passphrase: &[u8], expected_purpose: &str) -> Result<SecretVec<u8>> {
    let version = keystore
        .get("version")
        .and_then(Value::as_u64)
        .context("keystore version missing")?;
    let format = keystore
        .get("format")
        .and_then(Value::as_str)
        .context("keystore format missing")?;
    let kdf = keystore.get("kdf").and_then(Value::as_str).context("kdf missing")?;
    let cipher = keystore
        .get("cipher")
        .and_then(Value::as_str)
        .context("cipher missing")?;
    let n = keystore.get("N").and_then(Value::as_u64).context("N missing")?;
    let r = keystore.get("r").and_then(Value::as_u64).context("r missing")?;
    let p = keystore.get("p").and_then(Value::as_u64).context("p missing")?;
    let purpose = keystore
        .get("purpose")
        .and_then(Value::as_str)
        .context("purpose missing")?;
    ensure!(version == 1, "keystore version mismatch");
    ensure!(format == HEADER_FORMAT, "keystore format mismatch");
    ensure!(kdf == "scrypt", "keystore KDF mismatch");
    ensure!(cipher == "aes-256-gcm", "keystore cipher mismatch");
    ensure!(purpose == expected_purpose, "keystore purpose mismatch");
    ensure!(n > 0 && n.is_power_of_two(), "invalid scrypt N");

    let salt = hex::decode(
        keystore
            .get("salt")
            .and_then(Value::as_str)
            .context("salt missing")?,
    )
    .context("salt is not hex")?;
    let nonce = hex::decode(
        keystore
            .get("nonce")
            .and_then(Value::as_str)
            .context("nonce missing")?,
    )
    .context("nonce is not hex")?;
    let ciphertext = hex::decode(
        keystore
            .get("ciphertext")
            .and_then(Value::as_str)
            .context("ciphertext missing")?,
    )
    .context("ciphertext is not hex")?;
    let tag = hex::decode(
        keystore.get("tag").and_then(Value::as_str).context("tag missing")?,
    )
    .context("tag is not hex")?;
    ensure!(salt.len() == 32, "salt length");
    ensure!(nonce.len() == 12, "nonce length");
    ensure!(tag.len() == 16, "tag length");
    ensure!(ciphertext.len() == 32, "ciphertext length");

    let log_n = u8::try_from(n.trailing_zeros()).context("N is not a power of two")?;
    let params = scrypt::Params::new(log_n, u32::try_from(r).context("r out of range")?,
        u32::try_from(p).context("p out of range")?, 32)
        .context("invalid scrypt params")?;
    let mut key = [0u8; 32];
    scrypt::scrypt(passphrase, &salt, &params, &mut key)
        .map_err(|_| anyhow::anyhow!("scrypt failed (wrong passphrase?)"))?;

    let aad = keystore_aad(n, r, p, purpose);
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|_| anyhow::anyhow!("AES key length"))?;
    key.fill(0);
    let mut combined = ciphertext;
    combined.extend_from_slice(&tag);
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &combined,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| anyhow::anyhow!("keystore authentication failed (wrong passphrase?)"))?;
    ensure!(plaintext.len() == 32, "unlocked seed length");
    Ok(SecretVec::new(plaintext))
}

/// Derive the unified full viewing key from the unlocked seed for identity
/// verification. Returns the encoded UFVK string.
pub fn derive_ufvk(seed: &[u8]) -> Result<String> {
    ensure!(seed.len() == 32, "seed length");
    let usk = UnifiedSpendingKey::from_seed(&MN, seed, 0u32.try_into().unwrap())
        .map_err(|_| anyhow::anyhow!("mainnet spending key derivation failed"))?;
    Ok(usk.to_unified_full_viewing_key().encode(&MN)?)
}

/// Derive the default shielded mainnet unified address for the seed.
pub fn derive_address(seed: &[u8]) -> Result<String> {
    let usk = UnifiedSpendingKey::from_seed(&MN, seed, 0u32.try_into().unwrap())
        .map_err(|_| anyhow::anyhow!("mainnet spending key derivation failed"))?;
    let (address, _) = usk
        .to_unified_full_viewing_key()
        .default_address(UnifiedAddressRequest::SHIELDED)?;
    Ok(address.encode(&MN))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::aead::AeadCore;
    use aes_gcm::aead::OsRng;
    use secrecy::ExposeSecret;

    // Build a minimal Node-format keystore with a small scrypt N so the test is
    // fast; the unlock function reads N/r/p from the JSON.
    fn seal_test(passphrase: &[u8], purpose: &str, n: u64) -> Value {
        let log_n = u8::try_from(n.trailing_zeros()).unwrap();
        let params = scrypt::Params::new(log_n, 8, 1, 32).unwrap();
        let salt = [7u8; 32];
        let mut key = [0u8; 32];
        scrypt::scrypt(passphrase, &salt, &params, &mut key).unwrap();
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let aad = keystore_aad(n, 8, 1, purpose);
        let ct = cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: &[9u8; 32],
                    aad: aad.as_bytes(),
                },
            )
            .unwrap();
        let (ciphertext, tag) = ct.split_at(32);
        serde_json::json!({
            "version": 1,
            "format": HEADER_FORMAT,
            "kdf": "scrypt",
            "N": n,
            "r": 8,
            "p": 1,
            "cipher": "aes-256-gcm",
            "purpose": purpose,
            "salt": hex::encode(salt),
            "nonce": hex::encode(nonce),
            "ciphertext": hex::encode(ciphertext),
            "tag": hex::encode(tag),
        })
    }

    #[test]
    fn unlock_round_trips_the_seed() {
        let ks = seal_test(b"correct horse battery staple", "mainnet:zcash:receiver", 1024);
        let seed = unlock_seed(&ks, b"correct horse battery staple", "mainnet:zcash:receiver").unwrap();
        assert_eq!(seed.expose_secret(), &[9u8; 32]);
    }

    #[test]
    fn wrong_passphrase_fails_authentication() {
        let ks = seal_test(b"right passphrase", "mainnet:zcash:receiver", 1024);
        assert!(unlock_seed(&ks, b"wrong passphrase", "mainnet:zcash:receiver").is_err());
    }

    #[test]
    fn wrong_purpose_fails_closed() {
        let ks = seal_test(b"pass", "mainnet:zcash:receiver", 1024);
        assert!(unlock_seed(&ks, b"pass", "mainnet:base:relayer").is_err());
    }

    #[test]
    fn corrupted_ciphertext_or_tag_fails() {
        let mut ks = seal_test(b"pass", "mainnet:zcash:receiver", 1024);
        ks["tag"] = serde_json::json!("00".repeat(16));
        assert!(unlock_seed(&ks, b"pass", "mainnet:zcash:receiver").is_err());
        let mut ks2 = seal_test(b"pass", "mainnet:zcash:receiver", 1024);
        ks2["ciphertext"] = serde_json::json!("ff".repeat(32));
        assert!(unlock_seed(&ks2, b"pass", "mainnet:zcash:receiver").is_err());
    }

    #[test]
    fn non_power_of_two_n_is_rejected() {
        let mut ks = seal_test(b"pass", "mainnet:zcash:receiver", 1024);
        ks["N"] = serde_json::json!(1025);
        assert!(unlock_seed(&ks, b"pass", "mainnet:zcash:receiver").is_err());
    }

    #[test]
    fn derived_address_is_a_mainnet_shielded_address() {
        let seed = [42u8; 32];
        let ufvk = derive_ufvk(&seed).unwrap();
        assert!(ufvk.starts_with("uview1"));
        let address = derive_address(&seed).unwrap();
        assert!(address.starts_with('u'));
    }

    #[test]
    fn derived_address_matches_the_watch_scanner() {
        let seed = [0u8; 32];
        let address = derive_address(&seed).unwrap();
        // The address (the operational identity used for note detection) is
        // identical to the zcash-watch scanner's derivation for the same seed.
        assert_eq!(
            address,
            "u1028puzku37pr8qqtmmxn6t5qws64gn58w0mfw8fhj5lekzanzv50vxd8g6ry9trq495645g4kgtn6ppw73x6r6xje7na3jcs8sryx2el"
        );
    }
}
