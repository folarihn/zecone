import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
const inventory = JSON.parse(
  readFileSync(".state/phase6/preserved.json", "utf8"),
);
const changedFiles = Object.entries(inventory)
  .filter(
    ([p, h]) =>
      !existsSync(p) ||
      createHash("sha256").update(readFileSync(p)).digest("hex") !== h,
  )
  .map(([p]) => p);
const report = {
  at: new Date().toISOString(),
  filesChecked: Object.keys(inventory).length,
  changedFiles,
};
writeFileSync(
  "docs/phase6c-evidence/preservation.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
if (changedFiles.length) process.exitCode = 1;
