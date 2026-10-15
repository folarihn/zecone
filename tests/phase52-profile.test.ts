import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reservePhase52Profile,
  validatePhase52Profile,
  phase52BackendConfiguration,
  verifySettlementWatchIdentity,
} from "../services/validation/phase52-profile.ts";
const root = () => mkdtempSync(join(tmpdir(), "zecone-phase52-"));
test("watch copies bind identity and birthday while allowing native address diversification", () => {
  const a = {
      network: "zcash-testnet",
      keyId: "a".repeat(64),
      birthday: 4500000,
      address: "different-diversifier-a",
    },
    b = { ...a, address: "different-diversifier-b" };
  assert.doesNotThrow(() => verifySettlementWatchIdentity(a, b));
  for (const changed of [
    { ...b, keyId: "b".repeat(64) },
    { ...b, birthday: a.birthday + 1 },
    { ...b, network: "mainnet" },
  ])
    assert.throws(() => verifySettlementWatchIdentity(a, changed));
});
test("fresh profile separates payer, backend watch, signer watch and recovery namespace", () => {
  const r = root(),
    p = reservePhase52Profile(r),
    q = reservePhase52Profile(root());
  assert.notEqual(p.id, q.id);
  assert.notEqual(p.paymentRequestId, q.paymentRequestId);
  assert.equal(
    new Set(
      p.roles
        .flatMap((x) => [x.keys, x.watch])
        .concat(p.independentSettlementWatch),
    ).size,
    7,
  );
  assert.ok(p.roles.every((x) => !x.keys.startsWith(x.watch)));
  assert.deepEqual(
    validatePhase52Profile(
      JSON.parse(readFileSync(join(r, ".state/phase52-profile.json"), "utf8")),
      r,
    ),
    p,
  );
});
test("reserved or interrupted profiles cannot be replaced and old wallet bytes are untouched", () => {
  const r = root();
  mkdirSync(join(r, ".secrets/user/zcash"), { recursive: true });
  const old = join(r, ".secrets/user/zcash/process.lock");
  writeFileSync(old, "quarantined");
  reservePhase52Profile(r);
  const path = join(r, ".state/phase52-profile.json"),
    before = readFileSync(path);
  assert.throws(() => reservePhase52Profile(r), /already_reserved/);
  assert.deepEqual(readFileSync(path), before);
  assert.equal(readFileSync(old, "utf8"), "quarantined");
});
test("old wallet paths, role substitution, traversal and extra secret fields are rejected", () => {
  const r = root(),
    p = reservePhase52Profile(r);
  for (const x of [
    { ...p, id: "../user" },
    { ...p, seed: "must-not-be-accepted" },
    {
      ...p,
      roles: p.roles.map((x, i) =>
        i === 1 ? { ...x, watch: join(r, ".secrets/user/zcash") } : x,
      ),
    },
    { ...p, independentSettlementWatch: p.roles[1].watch },
    { ...p, roles: [...p.roles].reverse() },
  ])
    assert.throws(() => validatePhase52Profile(x, r));
});
test("network, confirmation and live-signing gate tampering is rejected", () => {
  const r = root(),
    p = reservePhase52Profile(r);
  for (const x of [
    { ...p, network: "mainnet" },
    { ...p, confirmations: 9 },
    { ...p, liveRefundsEnabled: true },
    { ...p, simulatedIsolation: false },
    { ...p, refundRequestId: p.paymentRequestId },
    { ...p, transactionNamespace: "old-payment" },
  ])
    assert.throws(() => validatePhase52Profile(x, r));
});
test("backend configuration exposes only watch access and cannot activate execution or refunds", () => {
  const r = root(),
    p = reservePhase52Profile(r),
    backend = phase52BackendConfiguration(p, r),
    s = JSON.stringify(backend);
  assert.equal(backend.liveRefundsEnabled, false);
  assert.equal(backend.executionEnabled, false);
  for (const role of p.roles) assert.ok(!s.includes(role.keys));
  assert.ok(!s.includes(p.independentSettlementWatch));
  assert.deepEqual(
    Object.keys(backend).sort(),
    [
      "version",
      "phase",
      "profileId",
      "network",
      "transactionNamespace",
      "confirmations",
      "walletBWatch",
      "liveRefundsEnabled",
      "executionEnabled",
    ].sort(),
  );
});
