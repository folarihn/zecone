import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

type Provider = { endpoint: string; operator: string };
const config = JSON.parse(
  readFileSync("deploy/config/mainnet-public-probes.json", "utf8"),
) as {
  zcash: {
    lightwalletd: Provider[];
    headerRpc: Provider;
    rawBlock: Provider;
  };
  base: Provider[];
  solana: Provider[];
};

function assertIndependent(label: string, providers: Provider[]) {
  assert.equal(providers.length, 2, label);
  const hosts = new Set<string>();
  const operators = new Set<string>();
  for (const provider of providers) {
    const url = new URL(provider.endpoint);
    assert.equal(url.protocol, "https:", label);
    assert.equal(url.username, "", label);
    assert.equal(url.password, "", label);
    assert.doesNotMatch(url.hostname, /example|localhost|127\.0\.0\.1|\.invalid/i);
    hosts.add(url.host);
    operators.add(provider.operator);
  }
  assert.equal(hosts.size, 2, label);
  assert.equal(operators.size, 2, label);
}

test("mainnet public probes require independent credential-free HTTPS providers", () => {
  assertIndependent("zcash-lightwalletd", config.zcash.lightwalletd);
  assertIndependent("base", config.base);
  assertIndependent("solana", config.solana);
  for (const provider of [config.zcash.headerRpc, config.zcash.rawBlock]) {
    const url = new URL(provider.endpoint);
    assert.equal(url.protocol, "https:");
    assert.equal(url.username, "");
    assert.equal(url.password, "");
  }
});

test("mainnet connectivity verifies raw Zcash evidence and stays read-only", () => {
  const source = readFileSync("scripts/mainnet-connectivity.ts", "utf8");
  assert.match(source, /verify-block/);
  assert.match(source, /proofOfWork/);
  assert.match(source, /transactionMerkleRootMatchesHeader/);
  assert.match(source, /executionAllowed: false/);
  assert.match(source, /productionReady: false/);
  assert.doesNotMatch(source, /eth_sendRawTransaction|sendTransaction|sendRawTransaction/);
});
