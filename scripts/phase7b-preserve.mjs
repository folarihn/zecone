import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
const inventory = JSON.parse(
  readFileSync(".state/phase6/preserved.json", "utf8"),
);
const changed = Object.entries(inventory).filter(
  ([p, h]) =>
    !existsSync(p) ||
    createHash("sha256").update(readFileSync(p)).digest("hex") !== h,
);
const report = {
  at: new Date().toISOString(),
  filesChecked: Object.keys(inventory).length,
  changedCount: changed.length,
};
mkdirSync("docs/phase7b-evidence", { recursive: true });
writeFileSync(
  "docs/phase7b-evidence/preservation.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
if (changed.length) process.exitCode = 1;
