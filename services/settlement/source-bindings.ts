// Desktop-wide replay index, not another payment/execution engine. Financial
// facts stay in Store; this index only prevents recycling an isolated account.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
export interface SourceBinding {
  claim(account: string, address: string, orderId: string): void;
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export class SourceBindings implements SourceBinding {
  constructor(
    readonly db: DatabaseSync,
    readonly owner: string,
    readonly historical: () => readonly string[] = () => [],
  ) {
    db.exec(
      "PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS source_bindings(account TEXT PRIMARY KEY,address TEXT NOT NULL UNIQUE,order_id TEXT NOT NULL UNIQUE,owner TEXT NOT NULL)",
    );
  }
  claim(account: string, address: string, orderId: string) {
    if (this.historical().includes(account))
      throw Error("HISTORICAL_SOURCE_REUSE_FORBIDDEN");
    const a = hash(account),
      receiver = hash(address),
      owner = hash(this.owner);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.db
        .prepare(
          "SELECT * FROM source_bindings WHERE account=? OR address=? OR order_id=?",
        )
        .get(a, receiver, orderId);
      if (
        old &&
        (old.account !== a ||
          old.address !== receiver ||
          old.order_id !== orderId ||
          old.owner !== owner)
      )
        throw Error("SOURCE_ALREADY_BOUND");
      if (!old)
        this.db
          .prepare("INSERT INTO source_bindings VALUES(?,?,?,?)")
          .run(a, receiver, orderId, owner);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
// Reads only account identifiers from known historical financial databases.
// Never imports credentials, note details, viewing keys or source transaction IDs.
export function historicalSourceAccounts() {
  const paths = [".state/orders.sqlite", ".state/purchases.sqlite"];
  for (const phase of ["phase7b", "phase7c"]) {
    const profile = `.state/${phase}/profile.json`;
    if (existsSync(profile)) {
      const p = JSON.parse(readFileSync(profile, "utf8"));
      if (!/^[a-f0-9-]{36}$/.test(p.id))
        throw Error("HISTORICAL_PROFILE_INVALID");
      paths.push(`.state/${phase}/${p.id}/settlement.sqlite`);
    }
  }
  const accounts: string[] = [];
  for (const inventory of [
    ".state/phase6/preserved.json",
    ".state/phase7c/phase7b-preserved.json",
  ]) {
    if (!existsSync(inventory)) continue;
    for (const file of Object.keys(
      JSON.parse(readFileSync(inventory, "utf8")),
    )) {
      if (!file.replaceAll("\\", "/").endsWith("/watch-only.json")) continue;
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      if (typeof manifest.keyId === "string") accounts.push(manifest.keyId);
    }
  }
  for (const path of paths)
    if (existsSync(path)) {
      const db = new DatabaseSync(resolve(path), { readOnly: true });
      try {
        accounts.push(
          ...db
            .prepare("SELECT account FROM orders")
            .all()
            .map((r) => String(r.account)),
        );
      } finally {
        db.close();
      }
    }
  return accounts;
}
