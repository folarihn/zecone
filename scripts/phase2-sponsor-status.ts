// Read-only sanitized view of the existing Phase 2 action checkout.
import { DatabaseSync } from "node:sqlite";
import { AppState } from "../services/wallet/state.ts";
import { Store } from "../services/execution/store.ts";
import { checkoutView } from "../services/wallet/view.ts";
const db = new DatabaseSync(".state/wallet-app.sqlite", { readOnly: true });
const m = db
  .prepare("select value from app_meta where key='merchant_tip'")
  .get() as { value: string } | undefined;
db.close();
const app = new AppState(".state/wallet-app.sqlite"),
  store = new Store(".state/orders.sqlite");
try {
  const c = app.all().find((x) => JSON.parse(x.intent).kind === "action");
  if (!c) {
    console.log(JSON.stringify({ found: false }));
    process.exitCode = 2;
  } else {
    const v = checkoutView(c, store, Number(m?.value ?? 0));
    console.log(
      JSON.stringify({
        found: true,
        kind: v.kind,
        status: v.status,
        stage: v.stage,
        confirmations: v.confirmations,
        requiredConfirmations: v.requiredConfirmations,
        paymentTx: v.paymentTx,
        baseTx: v.baseTx,
        recovery: v.recovery,
      }),
    );
  }
} finally {
  app.close();
  store.close();
}
