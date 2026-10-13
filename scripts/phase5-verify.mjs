// Preserve old evidence and credential bytes. Publish only counts and mismatches.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const checkpoint = JSON.parse(
  readFileSync(".secrets/phase5-checkpoint/manifest.json", "utf8"),
);
const changed = checkpoint.files
  .filter((f) => sha(readFileSync(f.path)) !== f.sha256)
  .map((f) => f.path);
const changedPrivateCount = checkpoint.privateFiles.filter(
  (f) => sha(readFileSync(f.path)) !== f.sha256,
).length;
const orders = checkpoint.orders.map((before) => {
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
const result = {
  at: new Date().toISOString(),
  priorFileCount: checkpoint.files.length,
  changedPriorFiles: changed,
  privateFilesUnchanged: changedPrivateCount === 0,
  orders,
};
writeFileSync(
  "docs/phase5-evidence/preservation-verification.json",
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result, null, 2));
if (
  changed.length ||
  changedPrivateCount ||
  orders.some((o) => !o.unchanged || o.broadcasts !== o.previousBroadcasts)
)
  process.exitCode = 1;
