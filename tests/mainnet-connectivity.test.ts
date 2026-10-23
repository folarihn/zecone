import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

type Provider = { endpoint: string; operator: string };
type RawBlockProvider = Provider & {
  protocol: "zcash-json-rpc" | "blockchair-rest";
  endpointEnv?: string;
};
const config = JSON.parse(
  readFileSync("deploy/config/mainnet-public-probes.json", "utf8"),
) as {
  zcash: {
    lightwalletd: Provider[];
    headerRpc: Provider;
    rawBlocks: RawBlockProvider[];
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
    assert.doesNotMatch(
      url.hostname,
      /example|localhost|127\.0\.0\.1|\.invalid/i,
    );
    hosts.add(url.host);
    operators.add(provider.operator);
  }
  assert.equal(hosts.size, 2, label);
  assert.equal(operators.size, 2, label);
}

test("mainnet public probes require independent HTTPS providers and env-only credentials", () => {
  assertIndependent("zcash-lightwalletd", config.zcash.lightwalletd);
  assertIndependent("base", config.base);
  assertIndependent("solana", config.solana);
  assertIndependent("zcash-raw-blocks", config.zcash.rawBlocks);
  for (const provider of [config.zcash.headerRpc, ...config.zcash.rawBlocks]) {
    const url = new URL(provider.endpoint);
    assert.equal(url.protocol, "https:");
    assert.equal(url.username, "");
    assert.equal(url.password, "");
  }
  assert.equal(
    config.zcash.rawBlocks.some(
      (provider) =>
        provider.operator === "getblock" &&
        provider.endpointEnv === "ZECONE_GETBLOCK_URL",
    ),
    true,
  );
  assert.equal(
    config.zcash.rawBlocks.some(
      (provider) => provider.operator === "blockchair",
    ),
    false,
  );
});

test("mainnet connectivity verifies raw Zcash evidence and stays read-only", () => {
  const source = readFileSync("scripts/mainnet-connectivity.ts", "utf8");
  assert.match(source, /verify-block/);
  assert.match(source, /proofOfWork/);
  assert.match(source, /transactionMerkleRootMatchesHeader/);
  assert.match(source, /fetchCorroboratedRawBlock/);
  assert.match(source, /NOT_LOCALLY_RECOMPUTED/);
  assert.match(source, /executionAllowed: false/);
  assert.match(source, /productionReady: false/);
  assert.doesNotMatch(
    source,
    /eth_sendRawTransaction|sendTransaction|sendRawTransaction/,
  );
});

test("authenticated block export is dual-source, external and non-executing", () => {
  const source = readFileSync("scripts/mainnet-block-export.ts", "utf8");
  assert.match(source, /fetchCorroboratedRawBlock/);
  assert.match(source, /assertExternalPath/);
  assert.match(source, /authenticated_block_directory_must_be_new/);
  assert.match(source, /verify-block/);
  assert.match(source, /zcash_exported_chain_discontinuity/);
  assert.match(source, /zcash_export_block_insufficient_confirmations/);
  assert.match(source, /if \(created\) rmSync/);
  assert.match(source, /accumulatedWork/);
  assert.match(source, /NOT_LOCALLY_RECOMPUTED/);
  assert.match(source, /executionAllowed: false/);
  assert.doesNotMatch(source, /sendTransaction|sendRawTransaction|broadcast/);
});
