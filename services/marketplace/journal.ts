import { Store } from "../execution/store.ts";
import type { UnsignedPurchase } from "./purchase.ts";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
export function providerReserved(path = ".state/purchases.sqlite") {
  if (!existsSync(path)) return false;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return !!db
      .prepare("SELECT id FROM purchase_requests WHERE reserved!='0' LIMIT 1")
      .get();
  } finally {
    db.close();
  }
}
export type PurchaseRow = {
  id: string;
  origin: string;
  session: string;
  intent: string;
  refund: string;
  stage: string;
  send_request: string;
  native_quote: string | null;
  quote_session: string | null;
  payment_tx: string | null;
  order_id: string | null;
  reserved: string;
  created: number;
};
export class PurchaseJournal extends Store {
  constructor(path = ".state/purchases.sqlite") {
    super(path);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS purchase_requests(id TEXT PRIMARY KEY,origin TEXT NOT NULL,session TEXT NOT NULL,intent TEXT NOT NULL,refund TEXT NOT NULL,stage TEXT NOT NULL,send_request TEXT NOT NULL UNIQUE,native_quote TEXT,quote_session TEXT,payment_tx TEXT,order_id TEXT UNIQUE,reserved TEXT NOT NULL,created INTEGER NOT NULL); DROP INDEX IF EXISTS one_active_listing; CREATE UNIQUE INDEX IF NOT EXISTS one_active_chain_listing ON purchase_requests(COALESCE(json_extract(intent,'$.chainId'),84532),json_extract(intent,'$.marketplace'),json_extract(intent,'$.listingId')) WHERE reserved!='0';`,
    );
  }
  rows() {
    return this.db
      .prepare("SELECT * FROM purchase_requests WHERE json_extract(intent,'$.kind')='purchase' ORDER BY created DESC")
      .all() as PurchaseRow[];
  }
  row(id: string) {
    return this.db
      .prepare("SELECT * FROM purchase_requests WHERE id=?")
      .get(id) as PurchaseRow | undefined;
  }
  reserved(chainId = 84532) {
    const rows = this.db.prepare("SELECT reserved FROM purchase_requests WHERE COALESCE(json_extract(intent,'$.chainId'),84532)=?").all(chainId) as {reserved:string}[];
    return rows.reduce((sum,r)=>sum+BigInt(r.reserved),0n);
  }
  reserve<T extends Pick<UnsignedPurchase, "chainId" | "price" | "gasBudget">>(
    id: string,
    origin: string,
    session: string,
    intent: T,
    refund: string,
    request: string,
    balance: bigint,
    at: number,
  ) {
    return this.atomic(() => {
      if (this.row(id)) throw Error("duplicate_quote");
      const value = BigInt(intent.price) + BigInt(intent.gasBudget);
      if (this.reserved(intent.chainId) + value > balance)
        throw Error("insufficient_provider_liquidity");
      this.db
        .prepare(
          "INSERT INTO purchase_requests(id,origin,session,intent,refund,stage,send_request,reserved,created) VALUES(?,?,?,?,?,'draft',?,?,?)",
        )
        .run(
          id,
          origin,
          session,
          JSON.stringify(intent),
          refund,
          request,
          value.toString(),
          at,
        );
      return this.row(id)!;
    });
  }
  stage(id: string, stage: string) {
    this.db
      .prepare("UPDATE purchase_requests SET stage=? WHERE id=?")
      .run(stage, id);
  }
  release(id: string) {
    this.db
      .prepare("UPDATE purchase_requests SET reserved='0' WHERE id=?")
      .run(id);
  }
}
