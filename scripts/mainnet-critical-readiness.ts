import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { probeMainnet } from "../services/settlement/mainnet-probe.ts";
import type { ProductionProfile } from "../services/settlement/production-safety.ts";
import { mainnetApprovalPackage } from "../services/settlement/mainnet-approval-package.ts";
async function main() {
  const file = process.argv[2] ?? "config/mainnet-profiles.example.json";
  const output = process.argv[3] ?? "docs/mainnet-critical-evidence";
  const profiles = JSON.parse(
    readFileSync(file, "utf8"),
  ) as ProductionProfile[];
  if (
    !Array.isArray(profiles) ||
    profiles.length !== 3 ||
    new Set(profiles.map((p) => p.network)).size !== 3 ||
    profiles.some((p) => !["zcash", "base", "solana"].includes(p.network))
  )
    throw Error("THREE_SEPARATE_PROFILES_REQUIRED");
  const results = [];
  for (const p of profiles) results.push(await probeMainnet(p));
  const report = {
    at: new Date().toISOString(),
    scope: "READ_ONLY_NO_KEYS_NO_ORDERS",
    mainnetExecutionEnabled: false,
    results,
  };
  mkdirSync(output, { recursive: true });
  writeFileSync(
    `${output}/readiness.json`,
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
  writeFileSync(
    `${output}/approval-packages.json`,
    JSON.stringify(
      profiles
        .filter((p) => p.network !== "zcash")
        .map((p) => mainnetApprovalPackage(p)),
      null,
      2,
    ) + "\n",
  );
}
void main().catch(() => {
  console.error(
    "Read-only mainnet configuration invalid; no execution attempted.",
  );
  process.exitCode = 1;
});
