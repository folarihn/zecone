// Synthetic providers only. No wallet credentials, network, signing or broadcast.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Devnet, GENESIS } from "../services/solana/network.ts";
import {
  rpcCategory,
  rpcEndpoint,
} from "../services/solana/rpc-reliability.ts";
const account = "11111111111111111111111111111111";
const call = (value: unknown) => ({ send: async () => value });
function provider(extra: any = {}) {
  return {
    getGenesisHash: () => call(GENESIS),
    getBalance: () => call({ value: 7n }),
    getMultipleAccounts: () =>
      call({
        context: { slot: 100n },
        value: [{ owner: account, data: ["AA==", "base64"] }],
      }),
    ...extra,
  } as any;
}
test("primary timeout is bounded and secondary read failover checks genesis", async () => {
  const net = new Devnet(
    provider({ getGenesisHash: () => ({ send: () => new Promise(() => {}) }) }),
    10,
    provider(),
    0,
  );
  assert.equal(await net.balance(account), 7n);
  assert.equal(net.providerIndex, 1);
  assert.equal(net.diagnostics.length, 3);
  assert.ok(net.diagnostics.every((d) => d.category === "TIMEOUT"));
});
test("wrong genesis vetoes fallback without querying wallet state", async () => {
  let queried = false;
  const net = new Devnet(
    provider({ getGenesisHash: () => call("wrong") }),
    100,
    provider({
      getBalance: () => {
        queried = true;
        return call({ value: 1n });
      },
    }),
    0,
  );
  await assert.rejects(net.balance(account), /WRONG_NETWORK/);
  assert.equal(queried, false);
});
test("pool snapshots corroborate complete data and reject conflicting providers", async () => {
  const net = new Devnet(provider(), 100, provider(), 0);
  assert.equal((await net.consistentAccounts([account])).context.slot, 100n);
  const bad = new Devnet(
    provider(),
    100,
    provider({
      getMultipleAccounts: () =>
        call({ context: { slot: 100n }, value: [null] }),
    }),
    0,
  );
  await assert.rejects(
    bad.consistentAccounts([account]),
    /RPC_PROVIDER_DISAGREEMENT/,
  );
});

test("pool failover explicitly records unavailable corroboration without inventing agreement", async () => {
  const primary = provider({
    getGenesisHash: () => ({
      send: async () => {
        throw Error("outage");
      },
    }),
    getMultipleAccounts: () => ({
      send: async () => {
        throw Error("outage");
      },
    }),
  });
  const net = new Devnet(primary, 100, provider(), 0);
  assert.equal((await net.consistentAccounts([account])).value.length, 1);
  assert.equal(net.providerIndex, 1);
  assert.ok(
    net.diagnostics.some((d) =>
      d.category.startsWith("CORROBORATION_UNAVAILABLE"),
    ),
  );
});
test("pool snapshot rejects stale context and wrong secondary cluster", async () => {
  let slot = 100n;
  const net = new Devnet(
    provider({
      getMultipleAccounts: () => call({ context: { slot }, value: [] }),
    }),
    100,
    undefined,
    0,
  );
  await net.consistentAccounts([account]);
  slot = 99n;
  await assert.rejects(net.consistentAccounts([account]), /CONTEXT_REGRESSION/);
  const wrong = new Devnet(
    provider(),
    100,
    provider({ getGenesisHash: () => call("mainnet") }),
    0,
  );
  await assert.rejects(wrong.consistentAccounts([account]), /WRONG_NETWORK/);
});
test("exact blockhash fee/simulation checks never silently fail over", async () => {
  let secondaryCalls = 0;
  const net = new Devnet(
    provider({
      simulateTransaction: () => ({
        send: async () => {
          throw Error("transient");
        },
      }),
    }),
    100,
    provider({
      simulateTransaction: () => {
        secondaryCalls++;
        return call({ value: { err: null } });
      },
    }),
    0,
  );
  await assert.rejects(net.simulate("unsigned fixture"), /RPC_UNAVAILABLE/);
  assert.equal(secondaryCalls, 0);
});
test("redacted diagnostics never preserve endpoint credentials, payload or error text", async () => {
  assert.equal(rpcCategory({ context: { statusCode: 429 } }), "RATE_LIMIT");
  assert.equal(rpcCategory({ context: { statusCode: 403 } }), "ACCESS_DENIED");
  assert.equal(rpcCategory({ context: { statusCode: 503 } }), "HTTP_SERVER");
  assert.throws(() => rpcEndpoint("http://unsafe.test"));
  assert.throws(
    () => rpcEndpoint("invalid secret endpoint"),
    (e) => e instanceof Error && e.message === "INVALID_RPC_CONFIGURATION",
  );
  assert.throws(() => rpcEndpoint("https://user:secret@provider.test"));
  const net = new Devnet(
    provider({
      getGenesisHash: () => ({
        send: async () => {
          throw Object.assign(Error("private payment and endpoint key"), {
            context: { statusCode: 403 },
          });
        },
      }),
    }),
    100,
    undefined,
    0,
  );
  await assert.rejects(net.balance(account), /RPC_ACCESS_DENIED/);
  assert.equal(JSON.stringify(net.diagnostics).includes("private"), false);
});
test("implementation-only rehearsal exposes no signer or broadcast command", () => {
  const source = readFileSync("scripts/phase7c1.ts", "utf8");
  assert.ok(source.includes("PHASE7C1_SIGNING_DISABLED"));
  assert.ok(source.includes("PHASE7C1_BROADCAST_DISABLED"));
  assert.ok(!/unlock|Accounts\(|signTransaction|broadcast-solana/.test(source));
});
