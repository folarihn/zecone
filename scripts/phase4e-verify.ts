// Read-only local evidence checks. Never emit credentials, signatures or private mappings.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { verifyMessage, type Hex, type Address } from "viem";
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const preserved = JSON.parse(readFileSync("docs/phase4e-evidence/preservation.json", "utf8"));
const changed = preserved.files.filter((f: any) => hash(readFileSync(f.path)) !== f.sha256).map((f: any) => f.path);
const orders = ["orders", "purchases"].map(name => {
  const current = new DatabaseSync(`.state/${name}.sqlite`, {readOnly: true});
  const before = new DatabaseSync(`.secrets/phase4d-checkpoint/state_${name}.sqlite`, {readOnly: true});
  const projection = (db: DatabaseSync) => db.prepare("SELECT id,state,tx_hash,intent,raw FROM orders ORDER BY id").all();
  const rows = projection(current), unchanged = JSON.stringify(rows) === JSON.stringify(projection(before));
  const broadcasts = current.prepare("SELECT count(*) n FROM audit WHERE event='broadcast_attempt'").get()!.n;
  const previousBroadcasts = before.prepare("SELECT count(*) n FROM audit WHERE event='broadcast_attempt'").get()!.n;
  current.close(); before.close();
  return {database: name, orders: rows.length, states: rows.map(r => r.state), unchanged, broadcasts, previousBroadcasts};
});
const db = new DatabaseSync(".state/dapps.sqlite", {readOnly: true});
const requests = db.prepare("SELECT method,state,review,result,tx_hash FROM requests WHERE origin=? ORDER BY created").all("https://opensea.io");
const approvals = [];
for (const row of requests) {
  const review = JSON.parse(String(row.review));
  const verified = row.method === "personal_sign" && row.state === "done" ? await verifyMessage({address: review.account as Address, message: {raw: review.raw as Hex}, signature: JSON.parse(String(row.result)) as Hex}) : null;
  approvals.push({method: row.method, state: row.state, chainId: review.chainId, account: review.account, signatureVerifiedLocally: verified, messageHash: review.raw ? hash(review.raw) : null, transactionHash: row.tx_hash});
}
const permissionRemaining = !!db.prepare("SELECT origin FROM permissions WHERE origin=?").get("https://opensea.io");
db.close();
const result = {at: new Date().toISOString(), priorFiles: preserved.files.length, changedPriorFiles: changed, orders, opensea: {approvals, permissionRemaining}};
writeFileSync("docs/phase4e-evidence/preservation-and-live-verification.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (changed.length || orders.some(o => !o.unchanged || o.broadcasts !== o.previousBroadcasts) || approvals.some(a => a.signatureVerifiedLocally === false || a.transactionHash)) process.exitCode = 1;
