//! Secure mainnet seed unlock. Reproduces the Node provisioning keystore format
//! (scrypt + AES-256-GCM with a byte-exact AAD). The passphrase is supplied by
//! the caller (interactive stdin); it is never logged, written to disk, or read
//! from a plaintext file by this module.
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use anyhow::{Context, Result, ensure};
use secrecy::SecretVec;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use zcash_keys::address::UnifiedAddress;
use zcash_keys::keys::{UnifiedAddressRequest, UnifiedSpendingKey};
use zcash_protocol::consensus::Network;

const HEADER_FORMAT: &str = "zecone-mainnet-provisioning-keystore";

fn keystore_aad(n: u64, r: u64, p: u64, purpose: &str) -> String {
    format!(
        "{{\"version\":1,\"format\":\"{HEADER_FORMAT}\",\"kdf\":\"scrypt\",\"N\":{n},\"r\":{r},\"p\":{p},\"cipher\":\"aes-256-gcm\",\"purpose\":\"{purpose}\"}}"
    )
}

pub fn unlock_seed(
    keystore: &Value,
    passphrase: &[u8],
    expected_purpose: &str,
) -> Result<SecretVec<u8>> {
    let version = keystore
        .get("version")
        .and_then(Value::as_u64)
        .context("keystore version missing")?;
    let format = keystore
        .get("format")
        .and_then(Value::as_str)
        .context("keystore format missing")?;
    let kdf = keystore
        .get("kdf")
        .and_then(Value::as_str)
        .context("kdf missing")?;
    let cipher = keystore
        .get("cipher")
        .and_then(Value::as_str)
        .context("cipher missing")?;
    let n = keystore
        .get("N")
        .and_then(Value::as_u64)
        .context("N missing")?;
    let r = keystore
        .get("r")
        .and_then(Value::as_u64)
        .context("r missing")?;
    let p = keystore
        .get("p")
        .and_then(Value::as_u64)
        .context("p missing")?;
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
        keystore
            .get("tag")
            .and_then(Value::as_str)
            .context("tag missing")?,
    )
    .context("tag is not hex")?;
    ensure!(salt.len() == 32, "salt length");
    ensure!(nonce.len() == 12, "nonce length");
    ensure!(tag.len() == 16, "tag length");
    ensure!(ciphertext.len() == 32, "ciphertext length");

    let log_n = u8::try_from(n.trailing_zeros()).context("N is not a power of two")?;
    let params = scrypt::Params::new(
        log_n,
        u32::try_from(r).context("r out of range")?,
        u32::try_from(p).context("p out of range")?,
        32,
    )
    .context("invalid scrypt params")?;
    let mut key = [0u8; 32];
    scrypt::scrypt(passphrase, &salt, &params, &mut key)
        .map_err(|_| anyhow::anyhow!("scrypt failed (wrong passphrase?)"))?;

    let aad = keystore_aad(n, r, p, purpose);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| anyhow::anyhow!("AES key length"))?;
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

/// Derive the unified spending key, then report identity metadata without ever
/// exposing the seed, spending key, or viewing key.
pub struct Identity {
    pub account: String,
    pub address: String,
    pub all_receivers_address: String,
    pub orchard_address: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressInspection {
    pub network: &'static str,
    pub unified: bool,
    pub orchard: bool,
    pub sapling: bool,
    pub transparent: bool,
    pub unknown_receiver_typecodes: Vec<u32>,
    pub expiry_height: Option<u32>,
    pub expiry_time: Option<u64>,
    pub differs_from_existing_address: bool,
    pub belongs_to_existing_account: bool,
}

pub fn inspect_address(
    seed: &[u8],
    address: &str,
    existing_address: &str,
) -> Result<AddressInspection> {
    let target = UnifiedAddress::decode(&Network::MainNetwork, address)
        .map_err(|_| anyhow::anyhow!("invalid mainnet unified address"))?;
    Ok(AddressInspection {
        network: "zcash-mainnet",
        unified: true,
        orchard: target.has_orchard(),
        sapling: target.has_sapling(),
        transparent: target.has_transparent(),
        unknown_receiver_typecodes: target
            .unknown()
            .iter()
            .map(|(typecode, _)| *typecode)
            .collect(),
        expiry_height: target.expiry_height().map(u32::from),
        expiry_time: target.expiry_time(),
        differs_from_existing_address: address != existing_address,
        belongs_to_existing_account: address_belongs_to_seed(seed, address)?,
    })
}

pub fn identity(seed: &[u8]) -> Result<Identity> {
    ensure!(seed.len() == 32, "seed length");
    let usk = UnifiedSpendingKey::from_seed(&Network::MainNetwork, seed, 0u32.try_into().unwrap())
        .map_err(|_| anyhow::anyhow!("mainnet spending key derivation failed"))?;
    let ufvk = usk.to_unified_full_viewing_key();
    let encoded = ufvk.encode(&Network::MainNetwork)?;
    let (address, _) = ufvk.default_address(UnifiedAddressRequest::SHIELDED)?;
    let (all_receivers_address, _) =
        ufvk.default_address(UnifiedAddressRequest::AllAvailableKeys)?;
    let (orchard_address, _) = ufvk.default_address(UnifiedAddressRequest::ORCHARD)?;
    Ok(Identity {
        account: hex::encode(Sha256::digest(encoded.as_bytes())),
        address: address.encode(&Network::MainNetwork),
        all_receivers_address: all_receivers_address.encode(&Network::MainNetwork),
        orchard_address: orchard_address.encode(&Network::MainNetwork),
    })
}

/// Verify ownership of an exact mainnet unified address by decrypting its
/// diversifier with the incoming viewing key derived from the seed. This is
/// stricter than comparing display forms and supports non-default diversified
/// addresses already authenticated by the watcher.
pub fn address_belongs_to_seed(seed: &[u8], address: &str) -> Result<bool> {
    ensure!(seed.len() == 32, "seed length");
    let target = UnifiedAddress::decode(&Network::MainNetwork, address)
        .map_err(|_| anyhow::anyhow!("invalid mainnet unified address"))?;
    ensure!(
        target.orchard().is_some() || target.sapling().is_some(),
        "shielded receiver required"
    );
    let usk = UnifiedSpendingKey::from_seed(&Network::MainNetwork, seed, 0u32.try_into().unwrap())
        .map_err(|_| anyhow::anyhow!("mainnet spending key derivation failed"))?;
    Ok(!usk
        .to_unified_full_viewing_key()
        .to_unified_incoming_viewing_key()
        .decrypt_diversifiers(&target)
        .is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::aead::{AeadCore, OsRng};
    use secrecy::ExposeSecret;

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
            "version": 1, "format": HEADER_FORMAT, "kdf": "scrypt", "N": n, "r": 8, "p": 1,
            "cipher": "aes-256-gcm", "purpose": purpose,
            "salt": hex::encode(salt), "nonce": hex::encode(nonce),
            "ciphertext": hex::encode(ciphertext), "tag": hex::encode(tag),
        })
    }

    #[test]
    fn unlock_round_trips() {
        let ks = seal_test(b"correct horse", "mainnet:zcash:receiver", 1024);
        let seed = unlock_seed(&ks, b"correct horse", "mainnet:zcash:receiver").unwrap();
        assert_eq!(seed.expose_secret(), &[9u8; 32]);
    }

    #[test]
    fn wrong_passphrase_fails() {
        let ks = seal_test(b"right", "mainnet:zcash:receiver", 1024);
        assert!(unlock_seed(&ks, b"wrong", "mainnet:zcash:receiver").is_err());
    }

    #[test]
    fn wrong_purpose_fails() {
        let ks = seal_test(b"pass", "mainnet:zcash:receiver", 1024);
        assert!(unlock_seed(&ks, b"pass", "mainnet:base:relayer").is_err());
    }

    #[test]
    fn corrupted_keystore_fails_authentication() {
        let mut ks = seal_test(b"pass", "mainnet:zcash:receiver", 1024);
        ks["tag"] = serde_json::json!("00".repeat(16));
        assert!(unlock_seed(&ks, b"pass", "mainnet:zcash:receiver").is_err());
    }

    #[test]
    fn identity_account_matches_watch_scanner() {
        // Zero-seed fingerprint must equal the zcash-watch scanner's derivation;
        // this pins the feature set that produces an identical unified UFVK.
        let id = identity(&[0u8; 32]).unwrap();
        assert_eq!(
            id.account,
            "f1d67cd1e98af1a130dd0c4481c39ce4ec9def1a7e8d625b2fd6fd25fbc7a0f9"
        );
        assert_eq!(
            id.address,
            "u1028puzku37pr8qqtmmxn6t5qws64gn58w0mfw8fhj5lekzanzv50vxd8g6ry9trq495645g4kgtn6ppw73x6r6xje7na3jcs8sryx2el"
        );
        assert!(address_belongs_to_seed(&[0u8; 32], &id.orchard_address).unwrap());
        let inspected =
            inspect_address(&[0u8; 32], &id.all_receivers_address, &id.orchard_address).unwrap();
        assert!(inspected.unified && inspected.orchard && inspected.sapling);
        assert!(inspected.belongs_to_existing_account);
        assert!(inspected.differs_from_existing_address);
    }
}
