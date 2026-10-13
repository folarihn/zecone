import { test } from "node:test";
import assert from "node:assert/strict";
import {
  verifyProviderAgreement,
  type ChainCheckpoint,
} from "../services/signer/chain-agreement.ts";
const now = 1800000000,
  a: ChainCheckpoint = {
    network: "zcash-testnet",
    source: "https://testnet.zec.rocks:443",
    chainName: "test",
    tip: 109,
    branch: "77190ad9",
    height: 100,
    blockHash: "a".repeat(64),
    ironwoodAnchor: "b".repeat(64),
    observedAt: now,
  };
const b = { ...a, source: "https://lightwalletd.testnet.electriccoin.co:9067" };
test("independent corroboration uses common height and minimum confirmation count", () => {
  assert.equal(
    verifyProviderAgreement({ ...a, tip: 111 }, b, now).confirmations,
    10,
  );
  assert.equal(
    verifyProviderAgreement(a, b, now).fullConsensusValidation,
    false,
  );
  assert.throws(
    () => verifyProviderAgreement(a, { ...b, tip: 108 }, now),
    /confirmations/,
  );
});
test("same operator, fork, branch mismatch, lagging and stale checkpoints fail closed", () => {
  for (const s of [
    { ...b, source: a.source },
    { ...b, blockHash: "c".repeat(64) },
    { ...b, ironwoodAnchor: "c".repeat(64) },
    { ...b, branch: "00000000" },
    { ...b, observedAt: now - 121 },
    { ...b, height: 99 },
    { ...b, network: "mainnet" },
  ])
    assert.throws(() => verifyProviderAgreement(a, s, now));
});
