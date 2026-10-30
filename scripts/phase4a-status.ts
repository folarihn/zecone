// Sanitized, read-only journal status. No signatures, keys or private addresses.
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(".state/purchases.sqlite", { readOnly: true });
try {
  const rows = db
    .prepare(
      "SELECT id,stage,payment_tx,order_id,intent FROM purchase_requests ORDER BY created DESC",
    )
    .all() as any[];
  const purchases = rows
    .filter((r) => [11155111, 46630].includes(JSON.parse(r.intent).chainId))
    .map((r) => {
      const i = JSON.parse(r.intent),
        o = db
          .prepare("SELECT state,tx_hash FROM orders WHERE id=?")
          .get(r.order_id) as any;
      const a = db
        .prepare(
          "SELECT detail FROM audit WHERE order_id=? AND event='scan_verified' ORDER BY seq DESC LIMIT 1",
        )
        .get(r.order_id) as any;
      const scan = a ? JSON.parse(a.detail) : null;
      const payments = db
        .prepare(
          "SELECT height,confirmed FROM payments WHERE order_id=? AND active=1",
        )
        .all(r.order_id) as any[];
      return {
        purchaseId: r.id,
        chainId: i.chainId,
        stage: r.stage,
        state: o?.state,
        paymentTx: r.payment_tx,
        destinationTx: o?.tx_hash,
        confirmations:
          payments.length && scan
            ? Math.min(...payments.map((p) => scan.tip - p.height + 1))
            : 0,
        scanTip: scan?.tip,
        recoveries: db
          .prepare(
            "SELECT reason,status FROM recoveries WHERE order_id=? AND status='review_required'",
          )
          .all(r.order_id),
      };
    });
  console.log(JSON.stringify({ at: new Date().toISOString(), purchases }));
} finally {
  db.close();
}
