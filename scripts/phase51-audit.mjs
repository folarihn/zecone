// Preserve the original checkpoint and reports; publish only new scoped audit results.
import {
  readFileSync,
  existsSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const baseline = JSON.parse(
  readFileSync(".secrets/phase5-checkpoint/manifest.json", "utf8"),
);
const changedPriorFiles = baseline.files
  .filter((f) => sha(readFileSync(f.path)) !== f.sha256)
  .map((f) => f.path);
const changedPrivateFiles = baseline.privateFiles.filter(
  (f) => sha(readFileSync(f.path)) !== f.sha256,
).length;
const orders = baseline.orders.map((before) => {
  const db = new DatabaseSync(`.state/${before.name}.sqlite`, {
    readOnly: true,
  });
  const rows = db
    .prepare("SELECT id,state,tx_hash,intent,raw FROM orders ORDER BY id")
    .all();
  const broadcasts = db
    .prepare("SELECT count(*) n FROM audit WHERE event='broadcast_attempt'")
    .get().n;
  db.close();
  return {
    database: before.name,
    count: rows.length,
    unchanged: sha(JSON.stringify(rows)) === before.projectionHash,
    broadcasts,
    previousBroadcasts: before.broadcasts,
  };
});
const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8" })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
const oldEvidenceChanges = git(
  "diff",
  "--name-only",
  "6975598",
  "--",
  "docs/phase5-evidence",
);
const dependencyPinChanges = git(
  "diff",
  "--name-only",
  "6975598",
  "--",
  "Cargo.toml",
  "Cargo.lock",
  "package-lock.json",
  "services/zcash/Cargo.toml",
  "services/zcash-watch/Cargo.toml",
  "services/zcash-watch/Cargo.lock",
  "services/refund-signer-native/Cargo.toml",
  "services/refund-signer-native/Cargo.lock",
);
const secrets = [];
function collect(value, key = "") {
  if (
    typeof value === "string" &&
    value.length >= 24 &&
    /private.?key|mnemonic|seed|api.?key|^key$|^token$/i.test(key)
  )
    secrets.push(Buffer.from(value));
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) collect(v, k);
}
try {
  for (const path of [
    ".secrets/user/base-sepolia.json",
    ".secrets/relayer/base-sepolia.json",
    ".secrets/marketplace-seller/base-sepolia.json",
    ".secrets/opensea-development-key.json",
    ".secrets/browser-pairing.json",
  ])
    if (existsSync(path)) collect(JSON.parse(readFileSync(path, "utf8")));
  for (const path of [
    ".secrets/user/zcash/seed.bin",
    ".secrets/merchant/zcash/seed.bin",
  ])
    if (existsSync(path)) {
      const b = readFileSync(path);
      secrets.push(
        b,
        Buffer.from(b.toString("hex")),
        Buffer.from(b.toString("base64")),
      );
    }
  // Viewing keys are also private. Comparing them requires no decryption or signing.
  function viewingKeys(dir) {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name);
      if (f.isDirectory()) viewingKeys(p);
      else if (f.isFile() && f.name === "viewing-key.txt")
        secrets.push(readFileSync(p));
    }
  }
  for (const dir of [
    ".secrets/phase5-watch",
    ".secrets/phase5-refund-validation",
    ".state/phase5-watch",
    ".state/phase5-refund-validation",
  ])
    viewingKeys(dir);
  const files = [
    ...new Set([
      ...git("diff", "--name-only", "6975598"),
      ...git("ls-files", "--others", "--exclude-standard"),
    ]),
  ].filter((p) => existsSync(p));
  const exposed = files.filter((p) => {
    const b = readFileSync(p);
    return secrets.some(
      (s) =>
        b.includes(s) ||
        (s.toString().startsWith("0x") && b.includes(s.subarray(2))),
    );
  });
  const report = {
    at: new Date().toISOString(),
    priorPublicFilesChecked: baseline.files.length,
    changedPriorFiles,
    privateCredentialFilesChecked: baseline.privateFiles.length,
    changedPrivateFiles,
    orders,
    oldEvidenceChanges,
    dependencyPinChanges,
    knownSecretPatternsChecked: secrets.length,
    publishableFilesChecked: files.length,
    exposedFiles: exposed,
    scope:
      "Known local credential/viewing-key patterns only; compared in memory, never emitted. Does not prove absence of every possible secret representation.",
  };
  mkdirSync("docs/phase51-evidence", { recursive: true });
  writeFileSync(
    "docs/phase51-evidence/preservation-and-secret-audit.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
  if (
    changedPriorFiles.length ||
    changedPrivateFiles ||
    oldEvidenceChanges.length ||
    dependencyPinChanges.length ||
    exposed.length ||
    orders.some((o) => !o.unchanged || o.broadcasts !== o.previousBroadcasts)
  )
    process.exitCode = 1;
} finally {
  secrets.forEach((b) => b.fill(0));
}
