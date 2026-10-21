// Non-spending production configuration inspection. Network probes are opt-in,
// read-only, and never unlock a keystore or construct a payment.
import { readFileSync } from "node:fs";
import { inspectMainnetConfiguration } from "../services/settlement/mainnet-config-validation.ts";
import { probeMainnet } from "../services/settlement/mainnet-probe.ts";
import type { ProductionProfile } from "../services/settlement/production-safety.ts";

function args() {
  const values = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i++) {
    const flag = process.argv[i];
    if (!flag.startsWith("--")) throw Error("INVALID_ARGUMENTS");
    if (flag === "--probe") {
      values.set("probe", "true");
      continue;
    }
    if (!process.argv[i + 1]) throw Error("INVALID_ARGUMENTS");
    values.set(flag.slice(2), process.argv[++i]);
  }
  return values;
}
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const probeable = (value: string) => {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return (
      !host.endsWith(".invalid") &&
      host !== "localhost" &&
      !host.endsWith(".local") &&
      !host.endsWith(".test") &&
      !host.endsWith(".example")
    );
  } catch {
    return false;
  }
};

async function main() {
  const values = args(),
    file = values.get("profiles");
  if (!file) throw Error("PROFILES_REQUIRED");
  const profiles = read(file);
  if (!Array.isArray(profiles)) throw Error("PROFILE_FILE_INVALID");
  const report = inspectMainnetConfiguration({
    profiles,
    readOnly: values.get("readonly")
      ? read(values.get("readonly")!)
      : undefined,
  });
  if (values.get("probe") === "true") {
    for (const result of report.profiles) {
      const profile = profiles.find(
        (p): p is ProductionProfile =>
          !!p &&
          typeof p === "object" &&
          (p as ProductionProfile).network === result.network,
      );
      if (
        !profile ||
        !Array.isArray(profile.providers) ||
        !profile.providers.length ||
        !profile.providers.every(
          (p) => typeof p.endpoint === "string" && probeable(p.endpoint),
        )
      )
        continue;
      (result as Record<string, unknown>).readOnlyProbe =
        await probeMainnet(profile);
    }
  }
  process.stdout.write(
    JSON.stringify({
      ...report,
      scope: "NO_KEYS_NO_ORDERS_NO_SIGNING_NO_BROADCAST",
    }) + "\n",
  );
}
main().catch((error: unknown) => {
  const code =
    error instanceof Error && /^[A-Z0-9_]{1,96}$/.test(error.message)
      ? error.message
      : "INVALID_CONFIGURATION_CHECK";
  process.stderr.write(
    JSON.stringify({
      error: code,
      signing: false,
      broadcast: false,
      executionAvailable: false,
    }) + "\n",
  );
  process.exitCode = 1;
});
