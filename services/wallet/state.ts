import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
export type Checkout = {
  id: string;
  intent: string;
  order_id: string | null;
  request_id: string;
  stage: string;
  quote: string | null;
  quote_session: string | null;
  txid: string | null;
  error: string | null;
  created: number;
};
export class AppState {
  db: DatabaseSync;
  constructor(path = ".state/wallet-app.sqlite") {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS checkouts(id TEXT PRIMARY KEY,intent TEXT NOT NULL,order_id TEXT UNIQUE,request_id TEXT NOT NULL UNIQUE,stage TEXT NOT NULL,quote TEXT,quote_session TEXT,txid TEXT,error TEXT,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,message TEXT NOT NULL,expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS nft_candidates(token TEXT PRIMARY KEY,hash TEXT NOT NULL,height TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  }
  get(id: string) {
    return this.db.prepare("SELECT * FROM checkouts WHERE id=?").get(id) as
      Checkout | undefined;
  }
  all() {
    return this.db
      .prepare("SELECT * FROM checkouts ORDER BY created DESC")
      .all() as Checkout[];
  }
  update(id: string, stage: string, error: string | null = null) {
    this.db
      .prepare("UPDATE checkouts SET stage=?,error=? WHERE id=?")
      .run(stage, error, id);
  }
  close() {
    this.db.close();
  }
}
