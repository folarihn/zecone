import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { Store } from "../execution/store.ts";
import { SolanaSettlement, SolanaSettlementNetwork } from "./settlement.ts";
export function phase7bRuntime() {
  const p = JSON.parse(readFileSync(".state/phase7b/profile.json", "utf8"));
  if (
    p.status !== "READY" ||
    p.network !== "zcash-testnet" ||
    p.liveRefundsEnabled !== false ||
    !/^[a-f0-9-]{36}$/.test(p.id) ||
    !/^[a-f0-9-]{36}$/.test(p.orderId)
  )
    throw Error("Invalid isolated Phase 7B profile");
  const root = resolve(".state/phase7b", p.id),
    watch = join(root, "settlement-watch"),
    manifest = JSON.parse(readFileSync(join(watch, "watch-only.json"), "utf8"));
  if (
    manifest.network !== "zcash-testnet" ||
    manifest.address !== p.addresses.settlement
  )
    throw Error("Watch identity mismatch");
  const store = new Store(join(root, "settlement.sqlite")),
    service = new SolanaSettlement(store, new SolanaSettlementNetwork());
  return { p, root, watch, manifest, store, service };
}
