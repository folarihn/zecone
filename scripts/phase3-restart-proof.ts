// Before/after evidence of process restart and repeated reconciliation. No signing.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { readJson, exclusiveJson } from "../services/execution/io.ts";
import {
  PurchaseBase,
  type MarketConfig,
} from "../services/marketplace/purchase.ts";
const mode = process.argv[2];
if (!["before", "after"].includes(mode)) throw Error("Use before or after");
const db = new DatabaseSync(".state/purchases.sqlite", { readOnly: true }),
  marker = readJson<{ purchaseId: string }>(".state/phase3-live-started.json"),
  c = readJson<MarketConfig>(".state/marketplace-confirmed.json"),
  b = new PurchaseBase(c);
try {
  const r = db
    .prepare(
      "SELECT stage,order_id,payment_tx FROM purchase_requests WHERE id=?",
    )
    .get(marker.purchaseId) as any;
  const o = db
    .prepare("SELECT state,tx_hash FROM orders WHERE id=?")
    .get(r.order_id) as any;
  assert.equal(r.stage, "sent");
  assert.equal(o.state, "settled");
  const counts = db
    .prepare(
      "SELECT sum(event='broadcast_attempt') broadcasts,sum(event='scan_verified') scans,max(seq) auditSequence FROM audit WHERE order_id=?",
    )
    .get(r.order_id) as any;
  const current = {
    at: new Date().toISOString(),
    purchaseId: marker.purchaseId,
    orderId: r.order_id,
    paymentTx: r.payment_tx,
    state: o.state,
    baseTx: o.tx_hash,
    ...counts,
    providerNonce: await b.public.getTransactionCount({
      address: b.account.address,
    }),
    providerWei: (
      await b.public.getBalance({ address: b.account.address })
    ).toString(),
  };
  assert.equal(current.broadcasts, 1);
  if (mode === "before")
    exclusiveJson(".state/phase3-restart-before.json", current);
  else {
    const before = readJson<any>(".state/phase3-restart-before.json");
    for (const k of [
      "purchaseId",
      "orderId",
      "paymentTx",
      "state",
      "baseTx",
      "broadcasts",
      "providerNonce",
      "providerWei",
    ])
      assert.equal((current as any)[k], before[k]);
    assert.ok(current.scans > before.scans);
    writeFileSync(
      "docs/phase3-evidence/restart-verification.json",
      JSON.stringify(
        {
          verified: true,
          before,
          after: current,
          conclusion:
            "Restart and repeated scans retained one settlement hash, one broadcast and unchanged provider nonce/balance.",
        },
        null,
        2,
      ),
    );
  }
  console.log(JSON.stringify({ checkpoint: mode, ...current }));
} finally {
  db.close();
}
