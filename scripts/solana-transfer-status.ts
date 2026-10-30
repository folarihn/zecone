// Unsigned preparation / finalized reconciliation only. Never loads a signer.
import { DatabaseSync } from "node:sqlite";
import { resolve, join } from "node:path";
import { getAddress } from "viem";
import { Store } from "../services/execution/store.ts";
import {
  SolanaSettlement,
  SolanaSettlementNetwork,
} from "../services/solana/settlement.ts";
import { SettlementReview } from "../services/wallet/settlement-review.ts";
import { settlementReads } from "../services/wallet/settlement-reads.ts";
import { SolanaTransferFlow } from "../services/settlement/solana-transfer-flow.ts";
import {
  SourceBindings,
  historicalSourceAccounts,
} from "../services/settlement/source-bindings.ts";
async function main() {
  const [root, mode] = process.argv.slice(2);
  if (
    !root ||
    process.argv.length > 4 ||
    (mode && !["--prepare", "--reconcile"].includes(mode))
  )
    throw Error(
      "Usage: solana-transfer-status <isolated-state> [--prepare|--reconcile]",
    );
  const path = join(resolve(root), "review.sqlite"),
    inspect = new DatabaseSync(path, { readOnly: true });
  let id: string, authorizer: string;
  try {
    const rows = inspect
      .prepare(
        "SELECT order_id,authorizer FROM solana_wallet_grants WHERE order_id IS NOT NULL",
      )
      .all();
    if (rows.length !== 1) throw Error("ONE_AUTHORIZED_ORDER_REQUIRED");
    id = String(rows[0].order_id);
    authorizer = String(rows[0].authorizer);
  } finally {
    inspect.close();
  }
  const store = new Store(path),
    bindingDb = new DatabaseSync(".state/functional/source-bindings.sqlite");
  try {
    const network = new SolanaSettlementNetwork(),
      service = new SolanaSettlement(store, network),
      review = new SettlementReview(
        service,
        settlementReads(network.net),
        undefined,
        new SourceBindings(bindingDb, resolve(root), historicalSourceAccounts),
      ),
      flow = new SolanaTransferFlow(review, service, getAddress(authorizer));
    const result =
      mode === "--prepare"
        ? await flow.prepare(id)
        : mode === "--reconcile"
          ? await flow.reconcile(id)
          : flow.state(id);
    console.log(
      JSON.stringify(
        { result, signing: false, broadcast: false, liveRefundsEnabled: false },
        (_, v) => (typeof v === "bigint" ? v.toString() : v),
      ),
    );
  } finally {
    store.close();
    bindingDb.close();
  }
}
void main().catch(() => {
  console.error(
    "SOL checkout status/preparation unavailable. Inspect restricted local journal; no signing attempted.",
  );
  process.exitCode = 1;
});
