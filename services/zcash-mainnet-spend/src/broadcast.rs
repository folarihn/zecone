//! Signed-artifact protection, validation, lightwalletd submission, and lookup.
//! Provider acceptance is deliberately not interpreted as confirmation.
use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use rand08::RngCore;
use sha2::{Digest, Sha256};
use std::io::Cursor;
use zcash_client_backend::proto::service::RawTransaction;
use zcash_primitives::transaction::Transaction;
use zcash_protocol::{
    TxId,
    consensus::{BranchId, Network},
};

use crate::{journal::SignedArtifact, wallet};

const NETWORK: Network = Network::MainNetwork;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Disabled,
    Mock,
    Live,
}

#[derive(Clone, Copy, Debug)]
pub struct BroadcastPolicy {
    pub mode: Mode,
    pub emergency_paused: bool,
    pub live_enabled: bool,
}

impl BroadcastPolicy {
    pub fn authorize(self) -> Result<()> {
        ensure!(!self.emergency_paused, "emergency pause is active");
        ensure!(
            self.mode != Mode::Disabled,
            "real broadcast is disabled by default"
        );
        if self.mode == Mode::Live {
            ensure!(
                self.live_enabled,
                "explicit live broadcast enablement required"
            );
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SubmitOutcome {
    Accepted { detail: String },
    Rejected { detail: String },
    Uncertain { detail: String },
}

#[async_trait]
pub trait Provider {
    async fn submit(&mut self, raw: &[u8]) -> SubmitOutcome;
}

pub struct LightwalletdProvider {
    endpoint: String,
}
impl LightwalletdProvider {
    pub fn new(endpoint: String) -> Self {
        Self { endpoint }
    }
}

#[async_trait]
impl Provider for LightwalletdProvider {
    async fn submit(&mut self, raw: &[u8]) -> SubmitOutcome {
        let mut client = match wallet::connect(&self.endpoint).await {
            Ok(c) => c,
            Err(e) => {
                return SubmitOutcome::Uncertain {
                    detail: format!("connection failed: {e:#}"),
                };
            }
        };
        match client
            .send_transaction(RawTransaction {
                data: raw.to_vec(),
                height: 0,
            })
            .await
        {
            Ok(response) => {
                let response = response.into_inner();
                if response.error_code == 0 {
                    SubmitOutcome::Accepted {
                        detail: "provider accepted transaction".into(),
                    }
                } else {
                    SubmitOutcome::Rejected {
                        detail: format!(
                            "provider rejection code {}: {}",
                            response.error_code, response.error_message
                        ),
                    }
                }
            }
            Err(status) => SubmitOutcome::Uncertain {
                detail: format!("submission RPC failed: {status}"),
            },
        }
    }
}

pub fn validate_signed(
    raw: &[u8],
    expected_txid: &str,
    expected_digest: &str,
    expiry_height: u32,
    current_height: u32,
) -> Result<TxId> {
    ensure!(
        current_height < expiry_height,
        "signed transaction is expired"
    );
    ensure!(
        hex::encode(Sha256::digest(raw)) == expected_digest,
        "signed transaction digest mismatch"
    );
    let branch = BranchId::for_height(&NETWORK, current_height.into());
    let mut cursor = Cursor::new(raw);
    let tx = Transaction::read(&mut cursor, branch)
        .context("invalid signed Zcash transaction encoding")?;
    ensure!(
        usize::try_from(cursor.position())? == raw.len(),
        "trailing signed transaction bytes"
    );
    ensure!(
        tx.txid().to_string() == expected_txid,
        "signed transaction id mismatch"
    );
    ensure!(
        u32::from(tx.expiry_height()) == expiry_height,
        "signed transaction expiry mismatch"
    );
    Ok(tx.txid())
}

fn artifact_key(seed: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"zecone-zcash-signed-artifact-v1\0");
    h.update(seed);
    h.finalize().into()
}

pub fn seal(
    raw: &[u8],
    seed: &[u8],
    session_id: &str,
    txid: &str,
    digest: &str,
) -> Result<SignedArtifact> {
    ensure!(!raw.is_empty(), "empty signed transaction");
    let key = artifact_key(seed);
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| anyhow::anyhow!("artifact cipher initialization failed"))?;
    let mut nonce = [0u8; 12];
    rand08::rngs::OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: raw,
                aad: session_id.as_bytes(),
            },
        )
        .map_err(|_| anyhow::anyhow!("signed artifact encryption failed"))?;
    Ok(SignedArtifact {
        txid: txid.into(),
        signed_digest: digest.into(),
        nonce: nonce.to_vec(),
        ciphertext,
    })
}

pub fn open(
    artifact: &SignedArtifact,
    seed: &[u8],
    session_id: &str,
) -> Result<zeroize::Zeroizing<Vec<u8>>> {
    ensure!(artifact.nonce.len() == 12, "invalid signed artifact nonce");
    let key = artifact_key(seed);
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| anyhow::anyhow!("artifact cipher initialization failed"))?;
    let raw = cipher
        .decrypt(
            Nonce::from_slice(&artifact.nonce),
            Payload {
                msg: &artifact.ciphertext,
                aad: session_id.as_bytes(),
            },
        )
        .map_err(|_| anyhow::anyhow!("signed artifact authentication failed"))?;
    Ok(zeroize::Zeroizing::new(raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MockProvider(SubmitOutcome);

    #[async_trait]
    impl Provider for MockProvider {
        async fn submit(&mut self, _raw: &[u8]) -> SubmitOutcome {
            self.0.clone()
        }
    }

    #[test]
    fn policy_defaults_fail_closed_and_pause_overrides_live() {
        assert!(
            BroadcastPolicy {
                mode: Mode::Disabled,
                emergency_paused: false,
                live_enabled: false
            }
            .authorize()
            .is_err()
        );
        assert!(
            BroadcastPolicy {
                mode: Mode::Live,
                emergency_paused: false,
                live_enabled: false
            }
            .authorize()
            .is_err()
        );
        assert!(
            BroadcastPolicy {
                mode: Mode::Live,
                emergency_paused: true,
                live_enabled: true
            }
            .authorize()
            .is_err()
        );
        BroadcastPolicy {
            mode: Mode::Mock,
            emergency_paused: false,
            live_enabled: false,
        }
        .authorize()
        .unwrap();
    }

    #[test]
    fn encrypted_artifact_binds_session_and_key() {
        let seed = [7u8; 32];
        let raw = b"signed fixture";
        let a = seal(raw, &seed, "session-a", &"a".repeat(64), &"b".repeat(64)).unwrap();
        assert_eq!(&*open(&a, &seed, "session-a").unwrap(), raw);
        assert!(open(&a, &seed, "session-b").is_err());
        assert!(open(&a, &[8u8; 32], "session-a").is_err());
    }

    #[tokio::test]
    async fn mock_provider_preserves_accept_reject_and_uncertain_outcomes() {
        for expected in [
            SubmitOutcome::Accepted {
                detail: "ok".into(),
            },
            SubmitOutcome::Rejected {
                detail: "bad".into(),
            },
            SubmitOutcome::Uncertain {
                detail: "timeout".into(),
            },
        ] {
            let mut provider = MockProvider(expected.clone());
            assert_eq!(provider.submit(b"same-exact-bytes").await, expected);
        }
    }

    #[test]
    fn signed_validation_rejects_expiry_corruption_and_invalid_encoding() {
        let raw = b"not-a-zcash-transaction";
        let digest = hex::encode(Sha256::digest(raw));
        assert!(validate_signed(raw, &"a".repeat(64), &digest, 100, 100).is_err());
        assert!(validate_signed(raw, &"a".repeat(64), &"b".repeat(64), 101, 100).is_err());
        assert!(validate_signed(raw, &"a".repeat(64), &digest, 101, 100).is_err());
    }
}
