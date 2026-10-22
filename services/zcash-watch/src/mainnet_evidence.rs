use anyhow::{Context, Result, ensure};
use num_bigint::BigUint;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use zcash_primitives::block::{Block, BlockHeader};
use zcash_protocol::consensus::Network;

const MAIN_NETWORK: Network = Network::MainNetwork;

fn display_hash(bytes: [u8; 32]) -> String {
    let mut value = bytes;
    value.reverse();
    hex::encode(value)
}

fn target_from_bits(bits: u32) -> Option<[u8; 32]> {
    let exponent = (bits >> 24) as usize;
    let mantissa = bits & 0x007f_ffff;
    if bits & 0x0080_0000 != 0 || mantissa == 0 || exponent == 0 {
        return None;
    }
    let mut target = [0u8; 32];
    if exponent <= 3 {
        let value = u64::from(mantissa) >> (8 * (3 - exponent));
        target[28..].copy_from_slice(&(value as u32).to_be_bytes());
    } else {
        let shift = exponent - 3;
        let end = 32usize.checked_sub(shift)?;
        let start = end.checked_sub(3)?;
        target[start..end].copy_from_slice(&[
            (mantissa >> 16) as u8,
            (mantissa >> 8) as u8,
            mantissa as u8,
        ]);
    }
    Some(target)
}

fn verify_header_bytes_with_header(
    raw: &[u8],
    expected_hash: &str,
) -> Result<(Value, BlockHeader, [u8; 32])> {
    ensure!((108..=2048).contains(&raw.len()), "invalid_header_length");
    let header = BlockHeader::read(raw).context("invalid_header")?;
    let mut encoded = Vec::new();
    header.write(&mut encoded).context("header_encode")?;
    ensure!(encoded == raw, "trailing_header_bytes");
    let actual = header.hash().to_string();
    ensure!(
        actual.eq_ignore_ascii_case(expected_hash.trim_start_matches("0x")),
        "header_hash_disagreement"
    );
    let target = target_from_bits(header.bits).context("invalid_compact_target")?;
    equihash::is_valid_solution(200, 9, &raw[..108], &header.nonce, &header.solution)
        .context("invalid_equihash_solution")?;
    let mut hash_number = header.hash().0;
    hash_number.reverse();
    ensure!(hash_number <= target, "insufficient_proof_of_work");
    Ok((
        json!({
            "network":"zcash-mainnet",
            "hash":actual,
            "previousBlockHash":display_hash(header.prev_block.0),
            "merkleRoot":display_hash(header.merkle_root),
            "time":header.time,
            "bits":header.bits,
            "target":hex::encode(target),
            "solutionBytes":header.solution.len(),
            "equihash":"200,9",
            "proofOfWork":"PASS",
            "readOnly":true
        }),
        header,
        target,
    ))
}

fn verify_header_bytes(raw: &[u8], expected_hash: &str) -> Result<Value> {
    verify_header_bytes_with_header(raw, expected_hash).map(|(value, _, _)| value)
}

pub fn verify_header(raw: &[u8], expected_hash: &str) -> Result<Value> {
    verify_header_bytes(raw, expected_hash)
}

fn hash_matches(hash: &[u8], expected: &str) -> bool {
    let expected = expected.trim_start_matches("0x");
    if hash.len() != 32 {
        return false;
    }
    if hex::encode(hash).eq_ignore_ascii_case(expected) {
        return true;
    }
    let mut reversed = hash.to_vec();
    reversed.reverse();
    hex::encode(reversed).eq_ignore_ascii_case(expected)
}

pub struct CompactHeader<'a> {
    pub height: u32,
    pub hash: &'a [u8],
    pub previous_hash: &'a [u8],
    pub header: &'a [u8],
}

#[derive(Debug)]
pub struct ChainSegmentEvidence {
    pub start_height: u32,
    pub end_height: u32,
    pub start_hash: String,
    pub end_hash: String,
    pub block_count: usize,
    pub accumulated_work: String,
}

impl ChainSegmentEvidence {
    pub fn to_json(&self) -> Value {
        json!({
            "scheme":"zcash-pow-chain-segment-v1",
            "startHeight":self.start_height,
            "endHeight":self.end_height,
            "startHash":self.start_hash,
            "endHash":self.end_hash,
            "blockCount":self.block_count,
            "accumulatedWork":self.accumulated_work,
            "proofOfWork":"PASS",
            "continuity":"PASS",
            "readOnly":true
        })
    }
}

/// Verifies the proof of work and hash linkage for the bounded confirmation
/// segment supplied by the two independently configured lightwalletd peers.
/// This deliberately does not claim full-node consensus validation: the
/// agreed current tip and the providers remain part of the trust model.
pub fn verify_chain_segment(
    headers: &[CompactHeader<'_>],
    expected_start: u32,
    expected_end: u32,
) -> Result<ChainSegmentEvidence> {
    ensure!(!headers.is_empty(), "empty_confirmation_chain");
    ensure!(headers.len() <= 100, "confirmation_chain_too_long");
    ensure!(expected_start <= expected_end, "invalid_confirmation_range");
    ensure!(
        headers.len() == usize::try_from(expected_end - expected_start + 1)?,
        "confirmation_chain_length_disagreement"
    );

    let mut accumulated_work = BigUint::from(0u8);
    let mut previous_hash: Option<String> = None;
    let mut start_hash = String::new();
    let mut end_hash = String::new();
    for (offset, record) in headers.iter().enumerate() {
        let expected_height = expected_start + u32::try_from(offset)?;
        ensure!(
            record.height == expected_height,
            "confirmation_height_disagreement"
        );
        ensure!(record.hash.len() == 32, "confirmation_hash_missing");
        ensure!(
            record.previous_hash.len() == 32,
            "confirmation_previous_hash_missing"
        );
        ensure!(!record.header.is_empty(), "confirmation_header_missing");

        let parsed = BlockHeader::read(record.header).context("invalid_confirmation_header")?;
        let actual_hash = parsed.hash().to_string();
        let (value, parsed, target) = verify_header_bytes_with_header(record.header, &actual_hash)?;
        ensure!(
            hash_matches(record.hash, &actual_hash),
            "confirmation_hash_disagreement"
        );
        let actual_previous = display_hash(parsed.prev_block.0);
        ensure!(
            hash_matches(record.previous_hash, &actual_previous),
            "confirmation_previous_hash_disagreement"
        );
        if let Some(previous_hash) = previous_hash.as_deref() {
            ensure!(
                actual_previous.eq_ignore_ascii_case(previous_hash),
                "confirmation_chain_discontinuity"
            );
        }

        let denominator = BigUint::from_bytes_be(&target) + BigUint::from(1u8);
        let work = (BigUint::from(1u8) << 256usize) / denominator;
        ensure!(work > BigUint::from(0u8), "invalid_confirmation_work");
        accumulated_work += work;
        let verified_hash = value["hash"]
            .as_str()
            .context("missing_verified_confirmation_hash")?
            .to_owned();
        if offset == 0 {
            start_hash = verified_hash.clone();
        }
        end_hash = verified_hash.clone();
        previous_hash = Some(verified_hash);
    }

    Ok(ChainSegmentEvidence {
        start_height: expected_start,
        end_height: expected_end,
        start_hash,
        end_hash,
        block_count: headers.len(),
        accumulated_work: accumulated_work.to_str_radix(16),
    })
}

fn merkle_root<T: AsRef<[u8]>>(txids: &[T]) -> Result<[u8; 32]> {
    ensure!(!txids.is_empty(), "empty_transaction_tree");
    let mut level = txids
        .iter()
        .map(|txid| {
            let bytes = txid.as_ref();
            ensure!(bytes.len() == 32, "invalid_compact_transaction_id");
            let mut value = [0u8; 32];
            value.copy_from_slice(bytes);
            Ok(value)
        })
        .collect::<Result<Vec<_>>>()?;
    while level.len() > 1 {
        if level.len() % 2 == 1 {
            level.push(*level.last().context("missing_merkle_leaf")?);
        }
        let mut next = Vec::with_capacity(level.len() / 2);
        for pair in level.chunks_exact(2) {
            let first = Sha256::digest([pair[0].as_slice(), pair[1].as_slice()].concat());
            let root = Sha256::digest(first);
            let mut value = [0u8; 32];
            value.copy_from_slice(&root);
            next.push(value);
        }
        level = next;
    }
    Ok(level[0])
}

pub fn verify_full_block(
    raw: &[u8],
    expected_hash: &str,
    expected_height: u32,
    expected_txid: Option<&str>,
) -> Result<(Value, Vec<u8>)> {
    ensure!(
        (109..=16 * 1024 * 1024).contains(&raw.len()),
        "invalid_block_length"
    );
    let block = Block::read(raw, &MAIN_NETWORK).context("invalid_block")?;
    ensure!(
        u32::from(block.claimed_height()) == expected_height,
        "block_height_disagreement"
    );
    let header = block.header();
    let mut header_bytes = Vec::new();
    header.write(&mut header_bytes).context("header_encode")?;
    let header_proof = verify_header_bytes(&header_bytes, expected_hash)?;
    let txids = block
        .vtx()
        .iter()
        .map(|tx| {
            let mut value = [0u8; 32];
            value.copy_from_slice(tx.txid().as_ref());
            value
        })
        .collect::<Vec<_>>();
    let computed = merkle_root(&txids)?;
    ensure!(computed == header.merkle_root, "merkle_root_disagreement");
    let transaction_index = if let Some(expected) = expected_txid {
        let expected = expected.trim_start_matches("0x").to_ascii_lowercase();
        let matches = txids
            .iter()
            .enumerate()
            .filter(|(_, txid)| display_hash(**txid) == expected)
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        ensure!(matches.len() == 1, "transaction_not_in_block");
        Some(matches[0])
    } else {
        None
    };
    Ok((
        json!({
            "scheme":"zcash-header-pow-merkle-v1",
            "network":"zcash-mainnet",
            "height":expected_height,
            "transactionCount":txids.len(),
            "transactionIndex":transaction_index,
            "transactionMerkleRoot":display_hash(computed),
            "merkleRoot":display_hash(computed),
            "transactionMerkleRootMatchesHeader":true,
            "transactionIdMatched":transaction_index.is_some(),
            "headerHash":header_proof["hash"],
            "proofOfWork":"PASS",
            "header":header_proof,
            "readOnly":true
        }),
        header_bytes,
    ))
}

pub fn verify_block(
    raw: &[u8],
    expected_hash: &str,
    expected_height: u32,
    expected_txid: Option<&str>,
) -> Result<Value> {
    verify_full_block(raw, expected_hash, expected_height, expected_txid).map(|(value, _)| value)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADER_3526366: &str = "040000000baadfb40f0c35cf66cae773012a03dfdd5e0794b6628afbb8795600000000008d64ef3cc47a445cbe73b82c617484db8ae2a731a9a664dce3089b316a61bf38b5a40826668d5d61230d3b01ca1013bf76f5534da45c1d01574c17685f136f1dc0a7d96a4798001c0d2ff1360000000000000000000000000000080000000000000000007e01e972fd400500490b23c8d392a2a4dca0528fb22f10b5de67ab9b1e0125d5c125ee6337d8c25d7f73d4c4b904fe014809f21354d4622ae372261112d6fcc518e4a2142f025efae6c628a07db9bad1f79cfce01089f5c6bcce19004f4d544e09b0ece7a86182fc5df8995a1398d600007b5d3af6ee9fd1f1810ae1d760dcbb06b4390744138eb662950ef3ad28a3939fcf35cd123527d476ff2871cd867f54c0aaf14bc6068242942acf54bd9810019280599f143a97d3c87562c64fc8b5c5a8ffa8f632479d94aaa81151fc70672b2b72d08e2c655e5c4502cb6c445ce6d89f7bdba0768bffc66efdeadf1cd93483f2714d1343a33cb644967bd15d7d32ed11aef80a798d011bc6cb124dcb529da6601dc5d3913d61fe22c9e65e6194f085a4a9565912e79043aa1b9e020a1ac3cb9715df8f0d8180f7c4a978cafa09ee91637245fb3df3b06705d9ad6e380908f86f7ef3a7baf6cd009c54e381095e828c5b204c028ac2b5b11eaea6ac1465c990db2a6dad930595e06ec68cc646fa32ebe600ea3ce02f6e1c0bb5a7302ab9c1eefc7a2190edfc0faaf52e508406a6c924352e0f74e62df628b77fce0f0a5f2bb887e2f7216242716ab272a667831372ea23ca528163a66dc3740c4307101bc1171cb6196a8924561aab780a473a834292593850ac6f49115b0c73360757507e0fcb14896b95a54ec0446a84f4b70cd104ad004016420e6cfc8d17f2c7731b366c577b23d7252f15d77d5e125f3737d55699ee3f6df732fa580d050a1898fdc3f7b7c5fc7a4509722dd76aa65e4c3814557cc3288dd7fe9ca0d2512d1ffc0d38cc0b146d08a34a528b9935273f3af1bfaa39ecdc92c586f21d14416ef07c980fa5b94184504ab5870a7748562cae26daf36852a76e31bc4482dd0d7a78e0d9b8fbf2ac27fb93b451916dac9b89e6711137c3db10b1bcc009004be29b9b1fd80fdcc0b4d15e40c32e712bfb4d040eba14a00fd53e4cf757c2bf95a29439b1e793254c04797c716c2e305bc883b0c3c8ef8f4d7cd31e79b6077e842f51d1d941408260b6bbbee522219ef9b3d60697111b708a1fce9a20e1ee4013f0ece82b15b3f447a3bd1caea3b887b439f744e0c6dd520c4cfe168d2024bdfc3f8bcce6cb0285f7d1cbd6a794e79e57eaa782ae3f80b09f97886a4cb1fd7a0c07489d5d660e02888488771b4834e0e9274822657ee21ebebf5b8804c0a573669aa3eb4da8669d6ce3bb422e12783bb91bcbf21df8a3dffb73bda2e2fe591bb9ba3c34746b335ecae11ad658eba8943599305fdccb6c423f5b7e07107d319f68a0d56be87092db6c3ad8b217a69ceb24fc2d2f8f5b985334e3f42d294db3057d774e84be07e37fda53466c0c34aa51b10f44d7cdb870110f420f0965b2ab04e1873777b3281fe03cd519c25c9c2a0091595a9688d42060d604d07479ad0f43817dbe9708a5730190da86592eb31294e3ee115b5257db9f09137e990c2ef2f305ee8f716638ad5c4464220646d8151264e6deeb4483ab95d403c8770512af7b7de36e0640ee37660dd0bda91a013cc6359b1e3c9e751edd0db38070d51ece0134f66148be55f0e9eb133464f414435cfeee9c4783fcf9e3b2d43b19f67687bcd114454a83a30b21dc87b221c6db1267e482643e3aa42002b9dfb868e51b95e10a516f63f19580aae269600404f6b90e06df8595cceb55ce02bb69e18df7fd9b9a038b22ca7e8d70fed64330f0df8f698e2addfb7aac0c72fe11d1cd354f2b98143cf7ffc08720253f781403b6bcd85d592f71d761a7b67fe12cb31e6f9b237205bc24aa555e6af3477d26f4faeee59e0da6b0c6de141979b68bcc2b1f35f072b722b340f4ca0b53c6aa17fffc608a880ee712d8d225ae9b0021a8ef73eeb1";

    const BLOCK_3526379: &[u8] = include_bytes!("../tests/fixtures/mainnet-block-3526379.bin");
    const HASH_3526379: &str = "0000000000262d7bf2e92055df778b830f37cc92bdab7aac722b09001a0aeb48";

    fn compact_fixture() -> (Vec<u8>, Vec<Vec<u8>>, Vec<u8>) {
        let block = Block::read(BLOCK_3526379, &MAIN_NETWORK).unwrap();
        let mut header = Vec::new();
        block.header().write(&mut header).unwrap();
        let txids = block
            .vtx()
            .iter()
            .map(|tx| tx.txid().as_ref().to_vec())
            .collect();
        let prev = hex::decode(display_hash(block.header().prev_block.0)).unwrap();
        (header, txids, prev)
    }

    #[test]
    fn verifies_mainnet_header_proof_of_work() {
        let raw = hex::decode(HEADER_3526366).unwrap();
        let value = verify_header(
            &raw,
            "00000000001ce2e98c56105db57895512765a9e6952982e8256a8056260fabee",
        )
        .unwrap();
        assert_eq!(value["proofOfWork"], "PASS");
        assert_eq!(value["equihash"], "200,9");
        assert_eq!(value["time"], 1792649152u64);
    }

    #[test]
    fn rejects_tampered_solution_or_hash() {
        let mut raw = hex::decode(HEADER_3526366).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 1;
        assert!(
            verify_header(
                &raw,
                "00000000001ce2e98c56105db57895512765a9e6952982e8256a8056260fabee"
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_negative_and_zero_targets() {
        assert!(target_from_bits(0x1d80_0000).is_none());
        assert!(target_from_bits(0x1d00_0000).is_none());
        assert!(target_from_bits(0x1d00_9847).is_some());
    }

    #[test]
    fn full_block_binds_pow_merkle_root_and_transaction_index() {
        let (_, txids, _) = compact_fixture();
        let full = verify_block(
            BLOCK_3526379,
            HASH_3526379,
            3526379,
            Some(&display_hash({
                let mut value = [0u8; 32];
                value.copy_from_slice(&txids[0]);
                value
            })),
        )
        .unwrap();
        assert_eq!(full["transactionIdMatched"], true);
        assert_eq!(full["transactionIndex"], 0);
        assert_eq!(full["proofOfWork"], "PASS");
        assert_eq!(full["transactionMerkleRootMatchesHeader"], true);
        assert!(
            verify_block(BLOCK_3526379, HASH_3526379, 3526379, Some(&"0".repeat(64)),).is_err()
        );
    }

    #[test]
    fn confirmation_segment_accumulates_work_and_rejects_discontinuity() {
        let (header, _, prev) = compact_fixture();
        let hash = hex::decode(HASH_3526379).unwrap();
        let record = CompactHeader {
            height: 3526379,
            hash: &hash,
            previous_hash: &prev,
            header: &header,
        };
        let evidence = verify_chain_segment(&[record], 3526379, 3526379).unwrap();
        assert_eq!(evidence.block_count, 1);
        assert_eq!(evidence.start_hash, HASH_3526379);
        assert_ne!(evidence.accumulated_work, "0");

        let broken = [
            CompactHeader {
                height: 3526379,
                hash: &hash,
                previous_hash: &prev,
                header: &header,
            },
            CompactHeader {
                height: 3526380,
                hash: &hash,
                previous_hash: &prev,
                header: &header,
            },
        ];
        assert!(verify_chain_segment(&broken, 3526379, 3526380).is_err());
    }
}
