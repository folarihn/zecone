import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../services/execution/store.ts";
import { SolanaSettlement } from "../services/solana/settlement.ts";

const args = process.argv.slice(2),
  state = args[0],
  snapshotPath = args[1],
  authorize = args.includes("--solana-authorize"),
  unknown = args.filter(
    (a, i) => a.startsWith("--") && a !== "--solana-authorize",
  );
if (
  !state ||
  !snapshotPath ||
  args.length > 3 ||
  unknown.length ||
  (args.length === 3 && !authorize)
)
  throw Error(
    "Usage: wallet-observe <state-dir> <snapshot.json> [--solana-authorize]",
  );
const dir = resolve(state),
  dbPath = resolve(dir, "review.sqlite");
if (!existsSync(dbPath))
  throw Error("No review wallet database in that state directory.");
const snapshot = JSON.parse(readFileSync(resolve(snapshotPath), "utf8"));
if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== "object")
  throw Error("A single watch snapshot object is required.");
const store = new Store(dbPath),
  forbidden = new Proxy(
    {},
    {
      get() {
        throw Error("EXECUTION_DISABLED");
      },
    },
  ),
  service = new SolanaSettlement(store, forbidden as any);
try {
  const now = Math.floor(Date.now() / 1000);
  store.observe(snapshot, now);
  if (authorize)
    for (const o of store.all()) {
      const intent = JSON.parse(o.intent) as { family?: string };
      if (intent.family === "solana") service.authorize(o.id, snapshot);
    }
  console.log(
    JSON.stringify(
      {
        executionAuthorized: false,
        signing: false,
        broadcast: false,
        observedAt: snapshot.observedAt,
        orders: store.all().map((o) => {
          const intent = JSON.parse(o.intent) as {
            family?: string;
            zatoshis?: string;
          };
          const totals = store.totals(o.id);
          return {
            id: o.id,
            family: intent.family ?? "evm",
            state: o.state,
            requiredZatoshis: intent.zatoshis ?? null,
            receivedZatoshis: totals.received.toString(),
            confirmedZatoshis: totals.confirmed.toString(),
          };
        }),
      },
      null,
      2,
    ),
  );
} finally {
  store.close();
}
