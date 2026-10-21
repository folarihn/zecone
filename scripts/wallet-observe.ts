// Native watch-only scanning only. JSON files are not payment evidence.
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../services/execution/store.ts";
import { WatchOnlyZcash } from "../services/signer/watch-evidence.ts";
import { SolanaTransferFlow } from "../services/settlement/solana-transfer-flow.ts";
import { SettlementReview } from "../services/wallet/settlement-review.ts";
import { settlementReads } from "../services/wallet/settlement-reads.ts";
import { SolanaSettlement } from "../services/solana/settlement.ts";
import { EvmTransferSettlement } from "../services/settlement/evm-transfer.ts";
import { NativeTransferFlow } from "../services/settlement/native-transfer-flow.ts";
import { adapterFor } from "../services/evm/adapter.ts";
import { getAddress } from "viem";
const [state, flag, watchPath, orderFlag, id] = process.argv.slice(2);
if (
  process.argv.length !== 7 ||
  !state ||
  flag !== "--watch-wallet" ||
  !watchPath ||
  orderFlag !== "--order" ||
  !/^0x[0-9a-f]{64}$/.test(id ?? "")
)
  throw Error(
    "Usage: wallet-observe <state-dir> --watch-wallet <native-watch-dir> --order <order-id>. Snapshot-file imports are disabled.",
  );
const dbPath = resolve(state, "review.sqlite");
if (!existsSync(dbPath)) throw Error("Fresh isolated wallet state required.");
const inspect = new DatabaseSync(dbPath, { readOnly: true });
let intent: any;
let authorizer: string | undefined;
try {
  const orders = inspect
    .prepare("SELECT id,account,address,intent,state FROM orders")
    .all();
  if (
    orders.length !== 1 ||
    orders[0].id !== id ||
    ["settled", "recovery", "failed", "expired"].includes(
      String(orders[0].state),
    )
  )
    throw Error("ONE_OPEN_AUTHORIZED_CHECKOUT_REQUIRED");
  intent = JSON.parse(String(orders[0].intent));
  const table =
    intent.family === "evm"
      ? "native_transfer_reviews"
      : "wallet_settlement_reviews";
  const authorized = inspect
    .prepare(
      `SELECT order_id FROM ${table} WHERE order_id=? AND state='CREATED'`,
    )
    .get(id);
  if (!authorized) throw Error("FINANCIAL_REVIEW_REQUIRED");
  if (intent.family === "evm")
    authorizer = String(
      inspect
        .prepare(
          "SELECT authorizer FROM native_transfer_authority WHERE order_id=?",
        )
        .get(id)?.authorizer ?? "",
    );
  const manifest = JSON.parse(
    readFileSync(join(resolve(watchPath), "watch-only.json"), "utf8"),
  );
  if (
    manifest.network !== "zcash-testnet" ||
    manifest.keyId !== orders[0].account ||
    manifest.address !== orders[0].address
  )
    throw Error("WATCH_PROFILE_MISMATCH");
} finally {
  inspect.close();
}
const store = new Store(dbPath),
  scanner = new WatchOnlyZcash(resolve(watchPath));
try {
  let result: unknown;
  if (intent.family === "evm") {
    const flow = new NativeTransferFlow(
      new EvmTransferSettlement(store, adapterFor(intent.chainId)),
      getAddress(authorizer!),
    );
    result = await flow.observe(id, scanner);
  } else if (
    intent.family === "solana" &&
    intent.action === "SOLANA_DEVNET_SOL_DELIVERY"
  ) {
    const forbidden = new Proxy(
      {},
      {
        get() {
          throw Error("EXECUTION_DISABLED");
        },
      },
    );
    const service = new SolanaSettlement(store, forbidden as any);
    const grant = store.db
      .prepare("SELECT authorizer FROM solana_wallet_grants WHERE order_id=?")
      .get(id);
    if (!grant) throw Error("SIGNED_WALLET_GRANT_REQUIRED");
    const flow = new SolanaTransferFlow(
      new SettlementReview(service, settlementReads()),
      service,
      getAddress(String(grant.authorizer)),
    );
    const view = await flow.observe(id, scanner);
    result = {
      state: view.state,
      receivedZatoshis: view.receivedZatoshis,
      confirmations: view.confirmations,
      requiredConfirmations: 10,
    };
  } else throw Error("UNSUPPORTED_OBSERVER_ACTION");
  console.log(
    JSON.stringify({
      result,
      signing: false,
      broadcast: false,
      liveRefundsEnabled: false,
    }),
  );
} finally {
  store.close();
}
