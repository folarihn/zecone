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
  native = packages("services/refund-signer-native/Cargo.lock");
const added = native.filter(
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
  nativePackages: native.length,
  dependenciesAbsentFromLegacyLock: added,
  pins: native.filter((p) =>
    [
      "pczt",
      "orchard",
      "zcash_protocol",
      "zcash_primitives",
      "zcash_keys",
    ].includes(p.name),
  ),
};
writeFileSync(
  "docs/phase5-evidence/native-refund-dependencies.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
if (added.length) process.exitCode = 1;
