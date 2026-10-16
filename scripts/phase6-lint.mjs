// Repository-scoped formatting and extension syntax lint; typechecks run separately.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
const files = [
  "app/wallet.tsx",
  "app/globals.css",
  "app/account-panel.tsx",
  "app/checkout/tracker.tsx",
  "app/checkout/clock.ts",
  "app/checkout/terms.tsx",
  "app/swaps/panel.tsx",
  "app/seaport/panel.tsx",
  "app/purchases/panel.tsx",
  "services/wallet/checkouts.ts",
  "services/wallet/snapshot.ts",
  "services/wallet/snapshot-api.ts",
  "services/wallet/dapp-policy.ts",
  "scripts/phase6c-snapshot.ts",
  "scripts/phase6c-viewer.ts",
  "scripts/phase6c-preserve.mjs",
  "tests/phase6c.test.ts",
  "tests/phase6c/real-data.spec.ts",
  "playwright.phase6c.config.ts",
  "services/wallet/read-rpc.ts",
  "services/wallet/api.ts",
  "services/wallet/dapps.ts",
  "services/wallet/engine.ts",
  "services/wallet/view.ts",
  "services/marketplace/service.ts",
  "scripts/phase6-preserve.mjs",
  "scripts/phase6-lint.mjs",
  "tests/phase6.test.ts",
  "tests/ui/phase6.spec.ts",
  "tests/ui/wallet.spec.ts",
  "tests/ui/extension.spec.ts",
  "tests/extension-policy.test.ts",
  "tests/extension/installed.spec.ts",
  "tests/opensea.test.ts",
  ...readdirSync("extension")
    .filter((f) => /\.(js|json)$/.test(f))
    .map((f) => "extension/" + f),
];
const format = spawnSync(
  process.execPath,
  [
    "node_modules/prettier/bin/prettier.cjs",
    process.argv.includes("--fix") ? "--write" : "--check",
    ...files,
  ],
  { stdio: "inherit", windowsHide: true },
);
if (format.status) process.exit(format.status ?? 1);
for (const f of files.filter((f) => f.endsWith(".js") || f.endsWith(".mjs"))) {
  const result = spawnSync(process.execPath, ["--check", f], {
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status) process.exit(result.status ?? 1);
}
