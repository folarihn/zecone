import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
const destination = ".state/phase6/preserved.json";
const roots = [
  ".secrets",
  ".state/phase52",
  ".state/phase52-profile.json",
  ".state/phase52-preservation.json",
  "docs/phase52-evidence",
];
const walk = (p) =>
  !existsSync(p)
    ? []
    : readdirSync(p, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(join(p, e.name))
          : e.isFile()
            ? [join(p, e.name)]
            : [],
      );
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
if (process.argv[2] === "init") {
  if (existsSync(destination)) throw Error("preservation_already_initialized");
  const files = roots.flatMap((p) =>
    existsSync(p) ? (p.endsWith(".json") ? [p] : walk(p)) : [],
  );
  // Preserve every historical wallet database, transaction marker and raw transaction.
  files.push(
    ...walk(".state").filter(
      (p) =>
        !p.includes("phase6") &&
        !p.includes("fixture") &&
        !p.includes("test-profile") &&
        /\.(sqlite.*|db.*|raw)$|request-.*\.json$/.test(p),
    ),
  );
  mkdirSync(".state/phase6", { recursive: true });
  writeFileSync(
    destination,
    JSON.stringify(
      Object.fromEntries([...new Set(files)].map((p) => [p, hash(p)])),
    ),
    { flag: "wx" },
  );
  console.log(JSON.stringify({ preservedFiles: new Set(files).size }));
} else {
  const files = JSON.parse(readFileSync(destination, "utf8"));
  const changed = Object.entries(files)
    .filter(([p, h]) => !existsSync(p) || hash(p) !== h)
    .map(([p]) => p);
  const report = {
    at: new Date().toISOString(),
    filesChecked: Object.keys(files).length,
    changedFiles: changed,
  };
  writeFileSync(
    "docs/phase6-evidence/preservation.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  if (changed.length) process.exitCode = 1;
}
