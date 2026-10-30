import { readFileSync, writeFileSync } from "node:fs";
const packages = (path) =>
  readFileSync(path, "utf8")
    .split("[[package]]")
    .slice(1)
    .map((b) => ({
      name: b.match(/^name = "([^"]+)"/m)?.[1],
      version: b.match(/^version = "([^"]+)"/m)?.[1],
      checksum: b.match(/^checksum = "([^"]+)"/m)?.[1],
    }));
const legacy = packages("Cargo.lock"),
  watch = packages("services/zcash-watch/Cargo.lock");
const added = watch.filter(
  (p) =>
    p.checksum &&
    !legacy.some(
      (o) =>
        o.name === p.name &&
        o.version === p.version &&
        o.checksum === p.checksum,
    ),
);
const report = {
  at: new Date().toISOString(),
  watchPackages: watch.length,
  dependenciesAbsentFromLegacyLock: added,
  pins: watch.filter((p) =>
    [
      "zcash_client_backend",
      "zcash_client_sqlite",
      "zcash_keys",
      "zcash_protocol",
      "orchard",
    ].includes(p.name),
  ),
};
writeFileSync(
  "docs/phase5-evidence/watch-only-dependencies.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
if (added.length) process.exitCode = 1;
