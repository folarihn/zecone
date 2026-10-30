import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProductionReservations,
  productionPrice,
  validateProductionProfile,
  assertMainnetExecutionAvailable,
  type ProductionProfile,
  type PriceStatement,
} from "../services/settlement/production-safety.ts";
import {
  probeMainnet,
  readProductionRpc,
} from "../services/settlement/mainnet-probe.ts";
import { mainnetApprovalPackage } from "../services/settlement/mainnet-approval-package.ts";
const keys = generateKeyPairSync("ed25519"),
  pem = String(keys.publicKey.export({ format: "pem", type: "spki" }));
const profile = (): ProductionProfile => ({
  network: "solana",
  enabled: true,
  providers: [
    { endpoint: "https://first.invalid", operator: "first" },
    { endpoint: "https://second.invalid", operator: "second" },
  ],
  independenceAcknowledged: true,
  relayer: "11111111111111111111111111111112",
  recipients: ["11111111111111111111111111111113"],
  perTransaction: "1010000",
  daily: "2020000",
  feeCap: "10000",
  confirmations: 1,
  signer: {
    identity: "disposable-test-attestation-only",
    publicKey: pem,
    transport: "offline-bundle",
    separateDeviceValidated: true,
    attestationReference: "synthetic",
  },
});
const order = (id = "one", source = "a".repeat(64)) => ({
  id,
  terms: "b".repeat(64),
  sourceCommitment: source,
  recipient: profile().recipients[0],
  debit: "1010000",
});
test("production configuration rejects missing corroboration, fake isolation and disabled execution", () => {
  const p = profile();
  validateProductionProfile(p);
  assert.throws(() =>
    validateProductionProfile({ ...p, providers: [p.providers[0]] }),
  );
  assert.throws(() =>
    validateProductionProfile({
      ...p,
      signer: { ...p.signer!, separateDeviceValidated: false },
    }),
  );
  assert.throws(() => validateProductionProfile({ ...p, daily: "1" }));
  assert.throws(assertMainnetExecutionAvailable, /MAINNET_DISABLED/);
});
test("single-device pilot is gated, expiring and honest about non-separation", () => {
  const now = Math.floor(Date.now() / 1000),
    pilot = {
      enabled: true as const,
      isolation: "single-device-process-isolation" as const,
      operator: "pilot-operator",
      expires: now + 3600,
      riskAccepted: "docs/MAINNET-SINGLE-DEVICE-PILOT.md",
    },
    pilotProfile = {
      ...profile(),
      pilot,
      signer: { ...profile().signer!, separateDeviceValidated: false },
    };
  validateProductionProfile(pilotProfile, now);
  assert.throws(
    () =>
      validateProductionProfile(
        { ...pilotProfile, pilot: { ...pilot, expires: now - 1 } },
        now,
      ),
    /SINGLE_DEVICE_PILOT_INVALID_OR_EXPIRED/,
  );
  assert.throws(
    () =>
      validateProductionProfile(
        { ...pilotProfile, pilot: { ...pilot, expires: now + 31 * 86400 } },
        now,
      ),
    /SINGLE_DEVICE_PILOT_INVALID_OR_EXPIRED/,
  );
  assert.throws(
    () =>
      validateProductionProfile(
        {
          ...pilotProfile,
          signer: { ...pilotProfile.signer!, separateDeviceValidated: true },
        },
        now,
      ),
    /SEPARATE_DEVICE_SIGNER_REQUIRED/,
  );
  // Production (no pilot marker) still requires a separate device.
  assert.throws(
    () =>
      validateProductionProfile(
        {
          ...profile(),
          signer: { ...profile().signer!, separateDeviceValidated: false },
        },
        now,
      ),
    /SEPARATE_DEVICE_SIGNER_REQUIRED/,
  );
});

test("production single writer fails closed across connections and restart", () => {
  const path = join(
      mkdtempSync(join(tmpdir(), "zecone-reserve-")),
      "control.sqlite",
    ),
    aDb = new DatabaseSync(path),
    bDb = new DatabaseSync(path),
    a = new ProductionReservations(aDb),
    b = new ProductionReservations(bDb);
  a.acquire();
  assert.throws(() => b.acquire(), /WRITER_ALREADY/);
  aDb.close();
  const cDb = new DatabaseSync(path),
    c = new ProductionReservations(cDb);
  assert.throws(() => c.acquire(), /WRITER_ALREADY/);
  bDb.close();
  cDb.close();
});
test("production reservations enforce pause, per day and inventory without aging uncertain spend", () => {
  let now = 100000;
  const db = new DatabaseSync(":memory:"),
    r = new ProductionReservations(db, () => now);
  try {
    r.acquire();
    assert.throws(() => r.reserve(profile(), order(), 10000000n), /PAUSED/);
    r.unpause(true);
    r.reserve(profile(), order(), 10000000n);
    assert.throws(
      () => r.reserve(profile(), order("two", "c".repeat(64)), 1500000n),
      /LIQUIDITY/,
    );
    r.claim("one", order().terms);
    r.uncertain("one");
    now += 86400;
    r.reserve(profile(), order("two", "c".repeat(64)), 10000000n);
    assert.throws(
      () => r.reserve(profile(), order("three", "d".repeat(64)), 10000000n),
      /LIMIT/,
    );
    assert.throws(() => r.releaseWriter(), /OUTSTANDING/);
    r.pause();
    assert.throws(() => r.claim("two", order().terms), /PAUSED/);
  } finally {
    db.close();
  }
});
test("production payment commitment cannot move to another order or be executed twice", () => {
  const db = new DatabaseSync(":memory:"),
    r = new ProductionReservations(db);
  try {
    r.acquire();
    r.unpause(true);
    r.reserve(profile(), order(), 10000000n);
    r.reserve(profile(), order(), 10000000n);
    assert.throws(
      () => r.reserve(profile(), order("other"), 10000000n),
      /REPLAY/,
    );
    r.claim("one", order().terms);
    assert.throws(() => r.claim("one", order().terms), /DUPLICATE/);
    assert.throws(() => r.reserve(profile(), order(), 10000000n), /REPLAY/);
  } finally {
    db.close();
  }
});
test("production policy changes and unallowlisted destinations cannot reserve", () => {
  const db = new DatabaseSync(":memory:"),
    r = new ProductionReservations(db);
  try {
    r.acquire();
    r.unpause(true);
    r.reserve(profile(), order(), 10000000n);
    assert.throws(
      () =>
        r.reserve(
          { ...profile(), daily: "3030000" },
          order("two", "c".repeat(64)),
          10000000n,
        ),
      /POLICY_CHANGE/,
    );
    assert.throws(
      () => r.reserve(profile(), { ...order(), recipient: "other" }, 10000000n),
      /AUTHORIZATION/,
    );
  } finally {
    db.close();
  }
});
function feed(operator: string, numerator = "2", at = 100000) {
  const k = generateKeyPairSync("ed25519"),
    statement: PriceStatement = {
      version: 1,
      operator,
      pair: "SOL/ZEC",
      numerator,
      denominator: "1",
      at,
      expires: at + 60,
    };
  return {
    price: {
      statement,
      signature: sign(
        null,
        Buffer.from(JSON.stringify(statement)),
        k.privateKey,
      ).toString("base64"),
    },
    publicKey: String(k.publicKey.export({ format: "pem", type: "spki" })),
  };
}
test("production price uses signed rational feeds and rounds upward without floating point", () => {
  const a = feed("a"),
    b = feed("b");
  assert.equal(
    productionPrice([a, b], "SOL/ZEC", 1000001n, 9, 100000).zatoshis,
    "200001",
  );
  assert.throws(
    () => productionPrice([a, b], "SOL/ZEC", 1n, 9, 100061),
    /STALE/,
  );
  assert.throws(
    () => productionPrice([a, feed("b", "3")], "SOL/ZEC", 1n, 9, 100000),
    /DISAGREEMENT/,
  );
  assert.throws(
    () => productionPrice([a, a], "SOL/ZEC", 1n, 9, 100000),
    /INDEPENDENT/,
  );
  a.price.statement.numerator = "9";
  assert.throws(
    () => productionPrice([a, b], "SOL/ZEC", 1n, 9, 100000),
    /INVALID/,
  );
});
test("production RPC surface cannot sign, broadcast, unlock or send Zcash", async () => {
  for (const method of [
    "eth_sendRawTransaction",
    "sendTransaction",
    "z_sendmany",
    "walletpassphrase",
    "eth_signTransaction",
  ]) {
    await assert.rejects(
      readProductionRpc(profile().providers[0], method, [], async () => {
        throw Error("NETWORK_TOUCHED");
      }),
      /FORBIDDEN/,
    );
  }
});
test("readiness never upgrades single-provider or fixture evidence to production readiness", async () => {
  const p = {
    ...profile(),
    providers: [profile().providers[0]],
    independenceAcknowledged: false,
    relayer: undefined,
    recipients: [],
  };
  const rpc: typeof fetch = async (_u, init) => {
    const m = JSON.parse(String(init?.body)).method;
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result:
          m === "getGenesisHash"
            ? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
            : m === "getSlot"
              ? 100
              : { blockhash: "test-anchor", blockTime: 100000 },
      }),
    );
  };
  const r = await probeMainnet(p, rpc, 100000);
  assert.equal(r.confidence, "PRIMARY_ONLY");
  assert.equal(r.productionReady, false);
  assert.equal(r.spendingEnabled, false);
  assert.equal(r.checks.independentAgreement.status, "BLOCKED");
});
test("zcash lightwalletd is never probed with JSON-RPC", async () => {
  let calls = 0;
  const r = await probeMainnet({ ...profile(), network: "zcash" }, async () => {
    calls++;
    throw Error("NETWORK_FORBIDDEN");
  });
  assert.equal(calls, 0);
  assert.equal(r.confidence, "UNAVAILABLE");
  assert.equal(r.spendingEnabled, false);
  assert.equal(r.productionReady, false);
  assert.equal(
    r.checks.identity.reason,
    "ZCASH_LIGHTWALLETD_GRPC_PROBE_NOT_IMPLEMENTED",
  );
  assert.equal(r.checks.independentAgreement.status, "BLOCKED");
});

test("provider disagreement and wrong genesis fail closed", async () => {
  for (const wrong of [true, false]) {
    const rpc: typeof fetch = async (u, init) => {
      const m = JSON.parse(String(init?.body)).method;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result:
            m === "getGenesisHash"
              ? wrong
                ? "wrong"
                : "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
              : m === "getSlot"
                ? 100
                : {
                    blockhash: String(u).includes("first") ? "one" : "two",
                    blockTime: 100000,
                  },
        }),
      );
    };
    const r = await probeMainnet(profile(), rpc, 100000);
    assert.equal(r.checks.rpcValidation.status, "FAIL");
    assert.equal(r.productionReady, false);
  }
});

test("unsigned mainnet SOL simulation is read-only and validates both provider fee results", async () => {
  let simulations = 0;
  const methods: string[] = [];
  const rpc: typeof fetch = async (_u, init) => {
    const request = JSON.parse(String(init?.body));
    methods.push(request.method);
    const m = request.method;
    const result =
      m === "getGenesisHash"
        ? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
        : m === "getSlot"
          ? 100
          : m === "getBlock"
            ? {
                blockhash: "11111111111111111111111111111111",
                blockTime: 100000,
              }
            : m === "getBalance"
              ? { context: { slot: 100 }, value: 10000000 }
              : m === "getAccountInfo"
                ? {
                    context: { slot: 100 },
                    value: {
                      owner: "11111111111111111111111111111111",
                      executable: false,
                    },
                  }
                : m === "getLatestBlockhash"
                  ? {
                      value: {
                        blockhash: "11111111111111111111111111111111",
                        lastValidBlockHeight: 200,
                      },
                    }
                  : m === "isBlockhashValid"
                    ? { value: true }
                    : m === "getFeeForMessage"
                      ? { value: 5000 }
                      : m === "simulateTransaction"
                        ? { value: { err: null, unitsConsumed: 150 } }
                        : null;
    if (m === "simulateTransaction") {
      simulations++;
      assert.equal(request.params[1].sigVerify, false);
      assert.equal(request.params[1].replaceRecentBlockhash, false);
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  };
  const r = await probeMainnet(profile(), rpc, 100000);
  assert.equal(r.checks.simulation.status, "PASS");
  assert.equal(r.confidence, "CORROBORATED_READ_SCOPE");
  assert.equal(r.productionReady, false);
  assert.equal(simulations, 2);
  assert.ok(
    methods.every(
      (m) => !["sendTransaction", "eth_sendRawTransaction"].includes(m),
    ),
  );
});
test("missing production configuration produces blocked packages without inventing recipients or costs", async () => {
  const p = {
    ...profile(),
    enabled: false,
    providers: [],
    recipients: [],
    relayer: undefined,
    signer: undefined,
  };
  const r = await probeMainnet(p, async () => {
    throw Error("NETWORK_FORBIDDEN");
  });
  assert.equal(r.checks.identity.status, "BLOCKED");
  assert.equal(r.confidence, "UNAVAILABLE");
  const pkg = mainnetApprovalPackage(p);
  assert.equal(pkg.status, "BLOCKED");
  assert.equal(pkg.terms.recipient, null);
  assert.equal(pkg.terms.relayer, null);
  assert.equal(pkg.terms.sourceZatoshis, null);
  assert.equal(pkg.authorizationGranted, false);
});
