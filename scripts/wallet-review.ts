// Operator-local review entry point; never starts legacy wallet workers.
import { readFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Store } from "../services/execution/store.ts";
import { SolanaSettlement } from "../services/solana/settlement.ts";
import {
  SettlementReview,
  type DeliveryRequest,
} from "../services/wallet/settlement-review.ts";
import { settlementReads } from "../services/wallet/settlement-reads.ts";
const [profilePath, action] = process.argv.slice(2);
if (
  process.argv.length !== 4 ||
  !profilePath ||
  !["transfer", "swap"].includes(action)
)
  throw Error(
    "Usage: npm run wallet:review -- <public-isolated-profile.json> <transfer|swap>",
  );
const input = JSON.parse(readFileSync(profilePath, "utf8"));
const keys = [
  "profileId",
  "requestId",
  "recipient",
  "relayer",
  "lamports",
  "account",
  "paymentAddress",
];
if (
  !input ||
  Object.keys(input).length !== keys.length ||
  keys.some((k) => typeof input[k] !== "string") ||
  Object.keys(input).some((k) => !keys.includes(k))
)
  throw Error(
    "Only public isolated profile fields are accepted; no keys or seeds.",
  );
const root = `.state/functional/review-${randomUUID()}`;
mkdirSync(root, { recursive: true, mode: 0o700 });
const store = new Store(`${root}/review.sqlite`);
// Execution network is poisoned, even if a future refactor accidentally accesses it.
const forbidden = new Proxy(
  {},
  {
    get() {
      throw Error("EXECUTION_DISABLED");
    },
  },
);
const service = new SolanaSettlement(store, forbidden as any);
try {
  const review = new SettlementReview(service, settlementReads());
  const result = await review.review(
    randomUUID(),
    input as DeliveryRequest,
    action as "transfer" | "swap",
  );
  console.log(
    JSON.stringify(
      {
        ...result,
        notice:
          "Economic review only. No payment request or execution authorization. Fixed testnet demo pricing.",
      },
      null,
      2,
    ),
  );
} finally {
  store.close();
}
