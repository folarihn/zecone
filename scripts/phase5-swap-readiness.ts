// Public contract/RPC reads and eth_call only. No wallet keys or broadcasts.
import { writeFileSync } from "node:fs";
import { readJson } from "../services/execution/io.ts";
import { inspect, quoted } from "../services/swaps/adapter.ts";
import type { SwapConfig } from "../services/swaps/intent.ts";
const config = readJson<SwapConfig>(".state/swap-84532-confirmed.json");
const result: Record<string, unknown> = {
  at: new Date().toISOString(),
  kind: "real-public-read-and-simulation",
  broadcasts: 0,
};
let stage = "inspect";
try {
  const state = await inspect(config);
  result.contractsVerified = true;
  result.block = state.block.number.toString();
  stage = "quote";
  const quote = await quoted(config, 100000000000000n);
  result.quote = {
    inputWei: "100000000000000",
    expectedOut: quote.expectedOut.toString(),
    estimatedFeeWei: quote.estimatedFee.toString(),
  };
} catch (e) {
  const code = e instanceof Error ? e.message : "";
  result.failedStage = stage;
  result.reason = [
    "gas_budget_exceeded",
    "stale_pool_state",
    "contract_code_mismatch",
    "wrong_chain",
    "insufficient_pool_liquidity",
  ].includes(code)
    ? code
    : "rpc_or_simulation_unavailable";
}
writeFileSync(
  "docs/phase5-evidence/swap-readiness-final.json",
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result, null, 2));
