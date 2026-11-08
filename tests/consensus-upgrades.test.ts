// Network-upgrade early warning: compares upgrades compiled into the watch
// binary with those a node schedules. Synthetic data shaped like real
// `consensus-info` and `getblockchaininfo` output; no network or keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseKnownUpgrades,
  parseScheduledUpgrades,
  unsupportedUpgrades,
} from "../services/operations/consensus-upgrades.ts";

const NU7 = "77190ad9";

// Mainnet as a node reported it on 8 November 2026 (abbreviated).
const blockchainInfo = (tip: number, extra: Record<string, unknown> = {}) => ({
  chain: "main",
  blocks: tip,
  upgrades: {
    c8e71055: { name: "NU6", activationheight: 2726400, status: "active" },
    "37a5165b": { name: "NU6.3", activationheight: 3428143, status: "active" },
    [NU7]: { name: "NU7", activationheight: 3543405, status: "active" },
    ...extra,
  },
});

const binary = (nu7Height: number | null) => ({
  network: "zcash-mainnet",
  readOnly: true,
  upgrades: [
    { name: "Nu6", branchId: "c8e71055", activationHeight: 2726400 },
    { name: "Nu6.3", branchId: "37a5165b", activationHeight: 3428143 },
    { name: "Nu7", branchId: NU7, activationHeight: nu7Height },
  ],
});

test("consensus: an upgraded build follows every scheduled upgrade", () => {
  const { tip, upgrades } = parseScheduledUpgrades(blockchainInfo(3550672));
  assert.deepEqual(
    unsupportedUpgrades(parseKnownUpgrades(binary(3543405)), upgrades, tip),
    [],
  );
});

test("consensus: the pre-NU7 build would have been flagged before activation", () => {
  // zcash_protocol 0.11.0-pre.0 knew the NU7 branch but had no mainnet height.
  const { tip, upgrades } = parseScheduledUpgrades(blockchainInfo(3530000));
  assert.deepEqual(
    unsupportedUpgrades(parseKnownUpgrades(binary(null)), upgrades, tip),
    [
      {
        name: "NU7",
        branchId: NU7,
        activationHeight: 3543405,
        blocksUntilActivation: 13405,
        reason: "ACTIVATION_HEIGHT_MISMATCH",
        knownActivationHeight: null,
      },
    ],
  );
});

test("consensus: a future upgrade with an unknown branch ID is flagged", () => {
  const { tip, upgrades } = parseScheduledUpgrades(
    blockchainInfo(3550672, {
      DEADBEEF: { name: "NU8", activationheight: 3600000, status: "pending" },
    }),
  );
  const issues = unsupportedUpgrades(
    parseKnownUpgrades(binary(3543405)),
    upgrades,
    tip,
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0].branchId, "deadbeef");
  assert.equal(issues[0].reason, "UNKNOWN_BRANCH");
  assert.equal(issues[0].blocksUntilActivation, 3600000 - 3550672);
});

test("consensus: malformed or wrong-network input is rejected", () => {
  assert.throws(
    () => parseKnownUpgrades({ ...binary(1), network: "zcash-testnet" }),
    /CONSENSUS_INFO_INVALID/,
  );
  assert.throws(
    () =>
      parseKnownUpgrades({
        network: "zcash-mainnet",
        upgrades: [{ name: "x", branchId: "zz", activationHeight: 1 }],
      }),
    /CONSENSUS_INFO_INVALID/,
  );
  assert.throws(
    () => parseScheduledUpgrades({ ...blockchainInfo(1), chain: "test" }),
    /BLOCKCHAIN_INFO_INVALID/,
  );
  assert.throws(
    () =>
      parseScheduledUpgrades(
        blockchainInfo(1, { [NU7]: { name: "NU7", activationheight: "soon" } }),
      ),
    /BLOCKCHAIN_INFO_INVALID/,
  );
});
