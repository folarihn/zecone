// Operator-only bridge between a monitor-mode checkout order and the existing
// payout session. Neither command signs, broadcasts or opens a key.
//
//   bind   --payments-db <db> --payment <id> --base-config <reviewed-session.json> --nonce <n> --out <new.json>
//          Writes a session config for this order: the reviewed config with only the
//          order-specific source fields replaced. Run `mainnet:pilot-session --check`
//          and `--dry-run` on it before any `--run`.
//   record --payments-db <db> --payment <id> --journal <submissions.sqlite> --plan <session/plan.json>
//          Copies the journal outcome (broadcast / finalized) onto the checkout order.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { exclusiveJson } from "../services/execution/io.ts";
import { PaymentStore } from "../services/payments/store.ts";
import {
  checkoutSettlementBinding,
  recordCheckoutPayout,
} from "../services/payments/checkout-settlement.ts";

const now = () => Math.floor(Date.now() / 1000);
const json = <T>(path: string): T =>
  JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) as T;

function args(argv: string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith("--") || argv[i + 1] === undefined)
      throw Error("INVALID_ARGUMENTS");
    values.set(argv[i].slice(2), argv[i + 1]);
  }
  return (name: string) => values.get(name) ?? (() => { throw Error(`MISSING_${name.toUpperCase().replace(/-/g, "_")}`); })();
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const arg = args(rest);
  const store = new PaymentStore(resolve(arg("payments-db")));
  try {
    if (command === "bind") {
      const base = json<Record<string, unknown> & { watchBinding: { account: string }; recipient: string }>(arg("base-config"));
      const nonce = Number(arg("nonce"));
      if (!Number.isSafeInteger(nonce) || nonce < 0) throw Error("EXPECTED_NONCE_INVALID");
      const binding = checkoutSettlementBinding(store, arg("payment"), {
        account: base.watchBinding.account,
        allowedRecipient: base.recipient,
        windowSeconds: 3600,
        now: now(),
      });
      exclusiveJson(resolve(arg("out")), { ...base, ...binding, expectedNonce: nonce });
      console.log(JSON.stringify({ status: "BOUND", ...binding, expectedNonce: nonce, signing: false, broadcast: false }));
      return;
    }
    if (command === "record") {
      const plan = json<{ terms: Parameters<typeof recordCheckoutPayout>[3] }>(arg("plan"));
      const result = recordCheckoutPayout(store, arg("payment"), resolve(arg("journal")), plan.terms, now());
      console.log(JSON.stringify(result));
      return;
    }
    throw Error("USE_BIND_OR_RECORD");
  } finally {
    store.close();
  }
}

try {
  main();
} catch (e) {
  console.error(JSON.stringify({ error: e instanceof Error && /^[A-Z0-9_]+$/.test(e.message) ? e.message : "CHECKOUT_SETTLEMENT_FAILED" }));
  process.exitCode = 1;
}
