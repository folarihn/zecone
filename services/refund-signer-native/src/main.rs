use anyhow::{Result, ensure};
use serde::Deserialize;
use serde_json::json;
use std::{
    fs::OpenOptions,
    io::{Read, Write},
    time::{SystemTime, UNIX_EPOCH},
};
use zecone_refund_signer::{MAX_PCZT, Policy};
use zeroize::{Zeroize, Zeroizing};
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Request {
    operation: String,
    pczt_hex: String,
    policy: Policy,
    reviewed_digest: Option<String>,
    secret_key_hex: Option<String>,
    original_pczt_hex: Option<String>,
}
impl Drop for Request {
    fn drop(&mut self) {
        if let Some(key) = self.secret_key_hex.as_mut() {
            key.zeroize();
        }
    }
}
fn run() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    if args.len() == 2 && args[0] == "create-synthetic-fixture" {
        let dir = std::path::Path::new(&args[1]);
        // Exclusive directory creation; never overwrite any existing wallet/path.
        std::fs::create_dir(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        }
        let f = zecone_refund_signer::fixture::generate(now, false)?;
        for (name, data) in [
            ("isolated-key.bin", f.key.as_slice()),
            ("unsigned.pczt", f.pczt.as_slice()),
            ("policy.json", serde_json::to_vec(&f.policy)?.as_slice()),
        ] {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut out = options.open(dir.join(name))?;
            out.write_all(data)?;
            out.sync_all()?;
        }
        println!("{{\"synthetic\":true,\"liveEnabled\":false}}");
        return Ok(());
    }
    ensure!(args == ["isolated-development"], "isolated_mode_required");
    let mut data = Zeroizing::new(Vec::new());
    std::io::stdin()
        .take((MAX_PCZT * 4 + 65537) as u64)
        .read_to_end(&mut data)?;
    ensure!(data.len() <= MAX_PCZT * 4 + 65536, "input_limit");
    let mut request: Request = serde_json::from_slice(&data)?;
    ensure!(request.pczt_hex.len() <= MAX_PCZT * 2, "pczt_limit");
    let pczt = hex::decode(&request.pczt_hex)?;
    let response = match request.operation.as_str() {
        "finalize-isolated" => {
            ensure!(
                request.secret_key_hex.is_none(),
                "finalizer_must_not_receive_key"
            );
            let original = request
                .original_pczt_hex
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("original_required"))?;
            ensure!(original.len() <= MAX_PCZT * 2, "original_size");
            let (raw, txid) = zecone_refund_signer::finalize_isolated(
                &hex::decode(original)?,
                &pczt,
                &request.policy,
                now,
                request.reviewed_digest.as_deref().unwrap_or(""),
            )?;
            json!({"rawTransactionHex":hex::encode(raw),"txid":txid,"broadcast":false,"liveEnabled":false})
        }
        "review" => {
            ensure!(
                request.secret_key_hex.is_none(),
                "review_must_not_receive_key"
            );
            json!({"review":zecone_refund_signer::review(&pczt,&request.policy,now)?,"transactionSigned":false,"liveEnabled":false})
        }
        "sign" => {
            let mut encoded = Zeroizing::new(
                request
                    .secret_key_hex
                    .take()
                    .ok_or_else(|| anyhow::anyhow!("missing_isolated_key"))?,
            );
            ensure!(encoded.len() == 64, "key_size");
            let mut key = Zeroizing::new([0u8; 32]);
            hex::decode_to_slice(encoded.as_bytes(), &mut *key)?;
            encoded.zeroize();
            let (signed, review) = zecone_refund_signer::sign_isolated(
                &pczt,
                &request.policy,
                now,
                request.reviewed_digest.as_deref().unwrap_or(""),
                &key,
            )?;
            json!({"signedPcztHex":hex::encode(signed),"review":review,"transactionSigned":true,"broadcast":false,"liveEnabled":false})
        }
        _ => anyhow::bail!("unsupported_operation"),
    };
    println!("{}", response);
    Ok(())
}
fn main() {
    // Never render parser errors, input JSON, PCZTs or key material in errors.
    std::panic::set_hook(Box::new(|_| eprintln!("native_refund_signer_panicked")));
    if run().is_err() {
        eprintln!("native_refund_request_rejected");
        std::process::exit(1);
    }
}
