// Read-only destination reconciliation. No key loading or submission capability.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress } from "viem";
import { Store } from "../services/execution/store.ts";
import { EvmTransferSettlement } from "../services/settlement/evm-transfer.ts";
import { NativeTransferFlow } from "../services/settlement/native-transfer-flow.ts";
import { EvmTransferExecutor } from "../services/evm/transfers.ts";
import { adapterFor } from "../services/evm/adapter.ts";
const [state, flag] = process.argv.slice(2);
if (!state || process.argv.length > 4 || (flag && flag !== "--reconcile"))
  throw Error("Usage: wallet-transfer-status <state-dir> [--reconcile]");
const path = resolve(state, "review.sqlite");
if (!existsSync(path)) throw Error("Authorized native checkout required.");
const db = new DatabaseSync(path, { readOnly: true });
let record: any;
try {
  const rows = db
    .prepare(
      "SELECT r.id,r.session,r.order_id,a.authorizer,o.intent FROM native_transfer_reviews r JOIN native_transfer_authority a ON a.order_id=r.order_id JOIN orders o ON o.id=r.order_id WHERE r.state='CREATED'",
    )
    .all();
  if (rows.length !== 1)
    throw Error("One authorized native checkout required.");
  record = rows[0];
} finally {
  db.close();
}
const intent = JSON.parse(record.intent),
  store = new Store(path);
try {
  const adapter = adapterFor(intent.chainId),
    flow = new NativeTransferFlow(
      new EvmTransferSettlement(store, adapter),
      getAddress(record.authorizer),
    );
  if (flag) {
    const readOnlyAccount = {
      type: "json-rpc" as const,
      address: getAddress(intent.relayer),
    };
    await flow.reconcile(
      record.order_id,
      new EvmTransferExecutor(adapter, readOnlyAccount),
    );
  }
  console.log(
    JSON.stringify({
      ...flow.status(record.session, record.id),
      signing: false,
      broadcast: false,
    }),
  );
} finally {
  store.close();
}
