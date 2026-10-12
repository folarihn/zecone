// Read-only public projection. Never emits signatures, receiving addresses, or raw tx.
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(".state/purchases.sqlite", { readOnly: true });
try {
  const rows = db
    .prepare(
      "SELECT id,stage,payment_tx,order_id,intent FROM purchase_requests ORDER BY created DESC",
    )
    .all() as any[];
  const result = rows.map((r) => {
    const o = db
      .prepare("SELECT state,tx_hash FROM orders WHERE id=?")
      .get(r.order_id) as any;
    const scan = db
      .prepare(
        "SELECT detail FROM audit WHERE order_id=? AND event='scan_verified' ORDER BY seq DESC LIMIT 1",
      )
      .get(r.order_id) as any;
    const detail = scan ? JSON.parse(scan.detail) : null;
    const p = db
      .prepare(
        "SELECT height,zatoshis,confirmed FROM payments WHERE order_id=? AND active=1",
      )
      .all(r.order_id) as any[];
    return {
      purchaseId: r.id,
      stage: r.stage,
      paymentTx: r.payment_tx,
      state: o?.state,
      baseTx: o?.tx_hash,
      listingId: JSON.parse(r.intent).listingId,
      confirmations:
        p.length && detail
          ? Math.min(...p.map((n) => detail.tip - n.height + 1))
          : 0,
      scanTip: detail?.tip,
      requiredConfirmations: 10,
      recoveries: db
        .prepare(
          "SELECT reason,status FROM recoveries WHERE order_id=? AND status='review_required'",
        )
        .all(r.order_id),
    };
  });
  console.log(
    JSON.stringify({ at: new Date().toISOString(), purchases: result }),
  );
} finally {
  db.close();
}
