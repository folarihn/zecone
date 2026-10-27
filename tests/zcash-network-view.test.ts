import { test } from "node:test";
import assert from "node:assert/strict";
import { ZcashNetworkViews } from "../services/wallet/zcash-networks.ts";
import type { Dashboard } from "../services/wallet/view.ts";

const account = "ab".repeat(32);
const address = `u1${"q".repeat(120)}`;
const config = {
  version: 1 as const,
  mode: "READ_ONLY" as const,
  binary: "fixture.exe",
  wallet: "fixture-wallet",
  expectedAccount: account,
  expectedAddress: address,
};
const summary = {
  totalZatoshis: "645937",
  spendableZatoshis: "645937",
  tip: 3529985,
  scanned: 3529985,
  observedAt: 1,
  history: [],
};
const mainnet = {
  network: "zcash-mainnet",
  label: "Zcash Mainnet",
  mode: "READ_ONLY",
  receivingAddress: address,
  accountFingerprint: account,
  addressStandard: "ZIP-316",
  receivers: {
    orchard: true,
    sapling: true,
    transparent: false,
    unknownTypecodes: [],
  },
  summary,
  sync: {
    tip: summary.tip,
    scanned: summary.scanned,
    complete: true,
    source: "verified-mainnet-wallet-database",
  },
  capabilities: {
    receive: true,
    balance: true,
    history: true,
    sign: false,
    broadcast: false,
  },
  sendUnavailableReason: "disabled",
  secretMaterialLoaded: false,
  broadcast: false,
};

test("mainnet browser view invokes only the seed-free read command and preserves isolation", async () => {
  let invocation: { binary: string; args: string[] } | undefined;
  const views = ZcashNetworkViews.fixture(config, async (binary, args) => {
    invocation = { binary, args };
    return { stdout: JSON.stringify(mainnet) };
  });
  assert.deepEqual(await views.mainnet(), mainnet);
  assert.deepEqual(invocation, {
    binary: "fixture.exe",
    args: [
      "browser-view",
      "--wallet",
      "fixture-wallet",
      "--expected-account",
      account,
      "--expected-address",
      address,
    ],
  });
  assert.ok(
    !invocation!.args.some((v) => /seed|key|pass|sign|broadcast/i.test(v)),
  );
});

test("mainnet response identity, mode and signing restrictions fail closed", async () => {
  for (const changed of [
    { receivingAddress: `u1${"x".repeat(120)}` },
    { accountFingerprint: "00".repeat(32) },
    { mode: "TESTNET" },
    { secretMaterialLoaded: true },
    { broadcast: true },
    { capabilities: { ...mainnet.capabilities, sign: true } },
  ]) {
    const views = ZcashNetworkViews.fixture(config, async () => ({
      stdout: JSON.stringify({ ...mainnet, ...changed }),
    }));
    await assert.rejects(views.mainnet(), /mismatch/);
  }
});

test("testnet and mainnet views cannot mix balances, identities or capabilities", () => {
  const views = ZcashNetworkViews.fixture(config, async () => ({
    stdout: "{}",
  }));
  const dashboard = {
    zcash: { ...summary, totalZatoshis: "7" },
  } as unknown as Dashboard;
  const testnet = views.testnet(dashboard);
  assert.equal(testnet.network, "zcash-testnet");
  assert.equal(testnet.summary?.totalZatoshis, "7");
  assert.equal(testnet.receivingAddress, null);
  assert.equal(testnet.capabilities.sign, false);
  assert.equal(views.list().find((n) => n.id === "mainnet")?.available, true);
});

test("missing private mainnet configuration preserves testnet and fails mainnet closed", async () => {
  const views = ZcashNetworkViews.load("");
  assert.equal(views.list().find((n) => n.id === "testnet")?.available, true);
  assert.equal(views.list().find((n) => n.id === "mainnet")?.available, false);
  await assert.rejects(views.mainnet(), /not configured/);
});
