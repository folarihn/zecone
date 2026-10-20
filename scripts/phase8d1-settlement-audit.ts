// Read-only originals; all reconciliation writes use disposable SQLite backups.
import assert from "node:assert/strict";
import { DatabaseSync, backup } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { Store } from "../services/execution/store.ts";
import {
  SolanaSettlement,
  SolanaSettlementNetwork,
} from "../services/solana/settlement.ts";
import { CpmmPolicy } from "../services/solana/cpmm.ts";
import { json } from "../services/solana/network.ts";
const report: any = {
  at: new Date().toISOString(),
  method:
    "consistent SQLite backups; original journals read-only; no signer or broadcast access",
  phases: [],
};
for (const phase of ["phase7b", "phase7c"]) {
  const p = JSON.parse(readFileSync(`.state/${phase}/profile.json`, "utf8"));
  const source = new DatabaseSync(`.state/${phase}/${p.id}/settlement.sqlite`, {
    readOnly: true,
  });
  const copy = `.state/phase8d1/${phase}-audit-${Date.now()}.sqlite`;
  await backup(source, copy);
  source.close();
  const store = new Store(copy),
    network = new SolanaSettlementNetwork();
  let sends = 0,
    signerReads = 0;
  network.send = async () => {
    sends++;
    throw Error("AUDIT_SEND_FORBIDDEN");
  };
  const policy = phase === "phase7c" ? new CpmmPolicy(network.net) : undefined;
  const service = new SolanaSettlement(store, network, undefined, policy);
  const row: any = store.db.prepare("SELECT * FROM solana_settlement").get(),
    id = row.order_id;
  const signer: any = new Proxy(
    {},
    {
      get() {
        signerReads++;
        throw Error("AUDIT_SIGNER_FORBIDDEN");
      },
    },
  );
  const gate = (e: any) =>
    [
      "PAYMENT_NOT_ELIGIBLE_OR_RECOVERY",
      "PAID_PREPARATION_NOT_AUTHORIZED",
    ].includes(e?.code);
  assert.equal(row.state, "COMPLETED");
  assert.throws(() => service.eligible(id), gate);
  await assert.rejects(service.prepare(id), gate);
  await assert.rejects(
    service.execute(
      id,
      { orderId: id, digest: JSON.parse(row.prepared).digest, approved: true },
      signer,
    ),
    gate,
  );
  assert.throws(
    () => service.recover(id, "PHASE8_AUDIT"),
    (e: any) => e.code === "COMPLETED_DELIVERY_REFUND_VETO",
  );
  const claims: any[] = store.db
    .prepare(
      "SELECT event,COUNT(*) AS count FROM audit WHERE event IN ('solana_signing_claimed','solana_broadcast_claimed') GROUP BY event",
    )
    .all();
  assert.equal(claims.length, 2);
  assert.ok(claims.every((x) => x.count === 1));
  let chain: any = { verified: false };
  try {
    const fresh = await network.receipt(row.signature);
    assert.ok(fresh);
    assert.deepEqual(JSON.parse(json(fresh)), JSON.parse(row.receipt));
    const reconciled = await service.reconcile(id);
    assert.equal(reconciled.state, "COMPLETED");
    const effects = policy
      ? await policy.verifyEffects(service.intent(id), fresh)
      : null;
    chain = {
      verified: true,
      commitment: "finalized",
      persistedReceiptMatches: true,
      effects: effects
        ? {
            outputUnits: effects.recipientDelta,
            relayerDebitLamports: effects.relayerDelta,
            rentLamports: effects.rent,
          }
        : null,
    };
  } catch (e: any) {
    chain = {
      verified: false,
      errorCode:
        typeof e.code === "string" ? e.code : "READ_ONLY_VERIFICATION_FAILED",
    };
  }
  assert.equal(sends, 0);
  assert.equal(signerReads, 0);
  report.phases.push({
    phase,
    completed: true,
    replayRejectedBeforeSignerAccess: true,
    refundVeto: true,
    signingClaims: 1,
    broadcastClaims: 1,
    auditBroadcastCalls: sends,
    auditSignerAccesses: signerReads,
    chain,
  });
  store.close();
}
const inventories = JSON.parse(
  readFileSync(".state/phase8/protected-inventory.private.json", "utf8"),
) as { source: string; files: Record<string, string> }[];
let inventoryEntries = 0,
  changedInventories = 0;
for (const inventory of inventories) {
  const current = JSON.parse(readFileSync(inventory.source, "utf8"));
  inventoryEntries += Object.keys(inventory.files).length;
  if (JSON.stringify(current) !== JSON.stringify(inventory.files))
    changedInventories++;
}
assert.equal(inventoryEntries, 628);
assert.equal(changedInventories, 0);
report.inventory = { entries: inventoryEntries, changedInventories };
writeFileSync(
  "docs/phase8d1-evidence/completed-order-audit.json",
  json(report),
);
console.log(json(report));
