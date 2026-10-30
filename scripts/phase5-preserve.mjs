// Local-only checkpoint. Never print credential bytes or private database records.
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  copyFileSync,
  constants,
} from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";
import { join } from "node:path";
const root = ".secrets/phase5-checkpoint";
const digest = (p) =>
  createHash("sha256").update(readFileSync(p)).digest("hex");
const files = execFileSync(
  "git",
  [
    "ls-files",
    "docs",
    "Cargo.lock",
    "Cargo.toml",
    "services/zcash/Cargo.toml",
    "package-lock.json",
  ],
  { encoding: "utf8" },
)
  .trim()
  .split(/\r?\n/);
if (existsSync(`${root}/manifest.json`))
  throw Error("Checkpoint already exists; refusing replacement");
mkdirSync(root, { recursive: true, mode: 0o700 });
const privateFiles = [];
function preserve(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) preserve(path);
    else if (
      entry.isFile() &&
      !/\.sqlite(?:-wal|-shm)?$/.test(path) &&
      !entry.name.endsWith(".lock")
    ) {
      const target = join(root, path);
      mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
      copyFileSync(path, target, constants.COPYFILE_EXCL);
      if (digest(path) !== digest(target))
        throw Error("Private checkpoint verification failed");
      privateFiles.push({ path, sha256: digest(target) });
    }
  }
}
for (const dir of [
  ".secrets/user",
  ".secrets/merchant",
  ".secrets/relayer",
  ".secrets/marketplace-seller",
])
  if (existsSync(dir)) preserve(dir);
const databases = [];
for (const path of [
  ".state/orders.sqlite",
  ".state/purchases.sqlite",
  ".state/dapps.sqlite",
  ".state/wallet-app.sqlite",
  ".secrets/user/zcash/wallet.sqlite",
  ".secrets/merchant/zcash/wallet.sqlite",
]) {
  const db = new DatabaseSync(path, { readOnly: true });
  const target = join(root, path.replaceAll(/[\\/]/g, "_"));
  if (existsSync(target)) throw Error("Backup already exists");
  await backup(db, target);
  db.close();
  const check = new DatabaseSync(target, { readOnly: true });
  if (check.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
    throw Error("Backup integrity");
  check.close();
  databases.push({ path, target, sha256: digest(target) });
}
const orders = ["orders", "purchases"].map((name) => {
  const db = new DatabaseSync(`.state/${name}.sqlite`, { readOnly: true });
  const rows = db
    .prepare("SELECT id,state,tx_hash,intent,raw FROM orders ORDER BY id")
    .all();
  const n = db
    .prepare("SELECT count(*) n FROM audit WHERE event='broadcast_attempt'")
    .get().n;
  db.close();
  return {
    name,
    count: rows.length,
    states: rows.map((r) => r.state),
    projectionHash: createHash("sha256")
      .update(JSON.stringify(rows))
      .digest("hex"),
    broadcasts: n,
  };
});
const publicRecord = {
  at: new Date().toISOString(),
  commit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  files: files.map((path) => ({ path, sha256: digest(path) })),
  orders,
  privateFilesPreserved: privateFiles.length,
  consistentDatabaseBackups: databases.length,
};
writeFileSync(
  `${root}/manifest.json`,
  JSON.stringify({ ...publicRecord, privateFiles, databases }, null, 2),
  { flag: "wx", mode: 0o600 },
);
writeFileSync(
  "docs/phase5-evidence/preservation.json",
  JSON.stringify(publicRecord, null, 2),
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    preservedFiles: files.length,
    privateFiles: privateFiles.length,
    databases: databases.length,
    orders,
  }),
);
