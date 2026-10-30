import { test } from "node:test";
import assert from "node:assert/strict";
import { mainnetIdentity } from "../services/wallet/mainnet-readiness.ts";
import { network } from "../services/evm/networks.ts";
const primary = { endpoint: "https://primary.invalid", operator: "operator-a" };
const secondary = {
  endpoint: "https://secondary.invalid",
  operator: "operator-b",
};
test("mainnet identity reads never grant execution and use no wallet data", async () => {
  const calls: any[] = [];
  const result = await mainnetIdentity("base", primary, undefined, (async (
    _url,
    init,
  ) => {
    calls.push(JSON.parse(String(init!.body)));
    return Response.json({ jsonrpc: "2.0", id: 1, result: "0x2105" });
  }) as typeof fetch);
  assert.equal(result.confidence, "PRIMARY_ONLY");
  assert.equal(result.spendingEnabled, false);
  assert.deepEqual(calls, [
    { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
  ]);
  assert.throws(() => network(8453), /unsupported_testnet/);
  assert.throws(() => network(1), /unsupported_testnet/);
});
test("provider disagreement and unavailable secondary cannot be corroborated", async () => {
  let count = 0;
  const disagree = await mainnetIdentity(
    "base",
    primary,
    secondary,
    (async () =>
      Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: ++count === 1 ? "0x2105" : "0x14a34",
      })) as typeof fetch,
  );
  assert.equal(disagree.confidence, "CONFLICTED");
  const sameOperator = await mainnetIdentity(
    "base",
    primary,
    { ...secondary, operator: "operator-a" },
    (async () =>
      Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: "0x2105",
      })) as typeof fetch,
  );
  assert.equal(sameOperator.confidence, "DEGRADED");
});
test("unsafe endpoints are rejected before fetch and errors redact provider secrets", async () => {
  const result = await mainnetIdentity(
    "ethereum",
    { endpoint: "https://secret:secret@rpc.invalid", operator: "a" },
    undefined,
    (async () => {
      throw Error("must not fetch");
    }) as typeof fetch,
  );
  assert.equal(result.confidence, "DEGRADED");
  assert.doesNotMatch(JSON.stringify(result), /secret|rpc.invalid/);
});
