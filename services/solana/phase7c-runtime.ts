import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store } from "../execution/store.ts";
import { SolanaSettlement, SolanaSettlementNetwork } from "./settlement.ts";
import { CpmmPolicy } from "./cpmm.ts";
export function phase7cRuntime() {
  const p = JSON.parse(readFileSync(".state/phase7c/profile.json", "utf8"));
  if (
    p.status !== "READY" ||
    p.network !== "zcash-testnet" ||
    p.liveRefundsEnabled !== false ||
    !/^[a-f0-9-]{36}$/.test(p.id) ||
    !/^[a-f0-9-]{36}$/.test(p.orderId)
  )
    throw Error("Invalid isolated Phase 7C profile");
  const root = resolve(".state/phase7c", p.id),
    watch = join(root, "settlement-watch"),
    manifest = JSON.parse(readFileSync(join(watch, "watch-only.json"), "utf8"));
  if (
    manifest.network !== "zcash-testnet" ||
    manifest.address !== p.addresses.settlement
  )
    throw Error("Watch identity mismatch");
  const store = new Store(join(root, "settlement.sqlite")),
    network = new SolanaSettlementNetwork(),
    policy = new CpmmPolicy(network.net),
    service = new SolanaSettlement(store, network, undefined, policy);
  return { p, root, watch, manifest, store, service, policy };
}
