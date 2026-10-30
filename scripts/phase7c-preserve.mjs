import { readFileSync, writeFileSync, existsSync } from "node:fs";
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
  additionalPhase7B: null,
};
if (existsSync(".state/phase7c/phase7b-preserved.json")) {
  const extra = JSON.parse(
    readFileSync(".state/phase7c/phase7b-preserved.json", "utf8"),
  );
  const different = Object.entries(extra).filter(
    ([p, h]) =>
      !existsSync(p) ||
      createHash("sha256").update(readFileSync(p)).digest("hex") !== h,
  );
  report.additionalPhase7B = {
    filesChecked: Object.keys(extra).length,
    changedCount: different.length,
  };
  if (different.length) process.exitCode = 1;
}
writeFileSync(
  "docs/phase7c-evidence/preservation.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
if (changed.length) process.exitCode = 1;
