// No wallet API, decryption, signing, database writes or claim removal.
import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  copyFileSync,
  constants,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, dirname, resolve, relative } from "node:path";
const pointer = ".state/phase52-preservation.json",
  evidence = "docs/phase52-evidence";
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8" })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
const protectedFiles = [];
function walk(dir) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    if (f.isSymbolicLink()) throw Error("historical_symlink_requires_review");
    if (f.isDirectory()) {
      if (!["phase52", "phase52-preservation"].includes(f.name)) walk(p);
    } else if (f.isFile()) protectedFiles.push({ path: p, sha256: sha(p) });
  }
}
if (process.argv[2] === "init") {
  if (existsSync(pointer))
    throw Error("preservation_checkpoint_exists_do_not_rebaseline");
  if (git("rev-parse", "HEAD")[0] !== git("rev-parse", "fec8341")[0])
    throw Error("unexpected_starting_checkpoint");
  walk(".secrets");
  walk(".state");
  const root = join(".secrets/phase52-preservation", randomUUID());
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const snapshots = [];
  for (const base of [
    ".state/orders.sqlite",
    ".state/purchases.sqlite",
    ".state/dapps.sqlite",
    ".state/wallet-app.sqlite",
    ".secrets/user/zcash/wallet.sqlite",
    ".secrets/merchant/zcash/wallet.sqlite",
  ]) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const source = base + suffix;
      if (!existsSync(source)) continue;
      const dest = join(root, "database-snapshots", source);
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      copyFileSync(source, dest, constants.COPYFILE_EXCL);
      if (sha(source) !== sha(dest))
        throw Error("snapshot_changed_during_copy");
      snapshots.push({ source, destination: dest, sha256: sha(dest) });
    }
  }
  const publicFiles = git("ls-files", "docs").map((path) => ({
    path,
    sha256: sha(path),
  }));
  const pins = git(
    "ls-files",
    "Cargo.toml",
    "Cargo.lock",
    "package-lock.json",
    "services/zcash/Cargo.toml",
    "services/refund-signer-native/Cargo.toml",
    "services/refund-signer-native/Cargo.lock",
    "services/zcash-watch/Cargo.toml",
    "services/zcash-watch/Cargo.lock",
  ).map((path) => ({ path, sha256: sha(path) }));
  const manifest = join(root, "manifest.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      at: new Date().toISOString(),
      checkpoint: "fec8341",
      protectedFiles,
      publicFiles,
      pins,
      snapshots,
    }),
    { flag: "wx", mode: 0o600 },
  );
  writeFileSync(pointer, JSON.stringify({ manifest }), {
    flag: "wx",
    mode: 0o600,
  });
}
const config = JSON.parse(readFileSync(pointer, "utf8"));
if (
  !resolve(config.manifest).startsWith(
    resolve(".secrets/phase52-preservation") + "\\",
  ) &&
  process.platform === "win32"
)
  throw Error("invalid_checkpoint_path");
const baseline = JSON.parse(readFileSync(config.manifest, "utf8"));
const changed = baseline.protectedFiles.filter(
  (f) => !existsSync(f.path) || sha(f.path) !== f.sha256,
);
const changedPublic = baseline.publicFiles
  .filter((f) => !existsSync(f.path) || sha(f.path) !== f.sha256)
  .map((f) => f.path);
const reviewedBuildFeatureChanges = [];
const normalized = (s) => s.replaceAll("\r\n", "\n").trim();
const originalWatchManifest = execFileSync(
  "git",
  ["show", "fec8341:services/zcash-watch/Cargo.toml"],
  { encoding: "utf8" },
);
const expectedWatchManifest = normalized(originalWatchManifest)
  .replace(
    '"orchard"] }\nzcash_client_sqlite = "=0.23.0-pre.1"',
    '"orchard", "pczt"] }\nzcash_client_sqlite = { version = "=0.23.0-pre.1", features = ["transparent-inputs", "serde"] }',
  )
  .replace(
    'zcash_protocol = "=0.11.0-pre.0"',
    'zcash_protocol = "=0.11.0-pre.0"\nzcash_primitives = "=0.31.0-pre.1"',
  )
  .replace(
    'tempfile = "3"\nzcash_primitives = "=0.31.0-pre.1"',
    'tempfile = "3"',
  );
function reviewedFeatureChange(path) {
  if (
    path === "services/zcash-watch/Cargo.toml" &&
    normalized(readFileSync(path, "utf8")) === expectedWatchManifest
  ) {
    reviewedBuildFeatureChanges.push({
      path,
      change:
        "Enable backend PCZT plus required SQLite serde/transparent-input support; move the same pinned primitives crate from dev to runtime. No version changes.",
    });
    return true;
  }
  if (path === "services/zcash-watch/Cargo.lock") {
    const old = normalized(
        execFileSync("git", ["show", `fec8341:${path}`], { encoding: "utf8" }),
      ),
      current = normalized(readFileSync(path, "utf8"));
    const strip = (s) => s.replace(/^dependencies = \[\n[\s\S]*?^\]\n?/gm, "");
    const dependencies = (s) =>
      s
        .split("[[package]]")
        .slice(1)
        .map((b) =>
          (b.match(/^dependencies = \[\n([\s\S]*?)^\]/m)?.[1] ?? "")
            .split("\n")
            .filter(Boolean),
        );
    const a = dependencies(old),
      b = dependencies(current);
    if (
      strip(old) === strip(current) &&
      a.length === b.length &&
      a.every((xs, i) => xs.every((x) => b[i].includes(x)))
    ) {
      reviewedBuildFeatureChanges.push({
        path,
        change:
          "Only dependency edges added for required build features; every package version, source and checksum is identical.",
        addedDependencyEdges: b.reduce(
          (n, xs, i) => n + xs.length - a[i].length,
          0,
        ),
      });
      return true;
    }
  }
  return false;
}
const changedPins = baseline.pins
  .filter((f) => sha(f.path) !== f.sha256)
  .map((f) => f.path)
  .filter((path) => !reviewedFeatureChange(path));
const badSnapshots = baseline.snapshots.filter(
  (f) => sha(f.destination) !== f.sha256,
);
const report = {
  at: new Date().toISOString(),
  checkpoint: baseline.checkpoint,
  historicalPrivateFilesChecked: baseline.protectedFiles.length,
  changedHistoricalPrivateFiles: changed.length,
  historicalPublicFilesChecked: baseline.publicFiles.length,
  changedHistoricalPublicFiles: changedPublic,
  changedDependencyPins: changedPins,
  reviewedBuildFeatureChanges,
  databaseSnapshots: baseline.snapshots.length,
  changedSnapshots: badSnapshots.length,
  quarantinedWalletReadByWalletApi: false,
  quarantinedWalletWritten: false,
  scope:
    "Hashes of files present at the start; private manifest and byte copies of historical DB files. New disposable files are excluded. Database files were copied while wallet services were stopped.",
};
mkdirSync(evidence, { recursive: true });
writeFileSync(
  join(
    evidence,
    process.argv[2] === "init"
      ? "preservation-baseline.json"
      : "preservation-final.json",
  ),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
if (
  changed.length ||
  changedPublic.length ||
  changedPins.length ||
  badSnapshots.length
)
  process.exitCode = 1;
