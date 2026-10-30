import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { getAddressEncoder } from "@solana/kit";
import { originOf } from "../wallet/dapp-policy.ts";
import { publicKey, SolanaError } from "./network.ts";
export class SolanaPermissions {
  constructor(
    readonly db: DatabaseSync,
    readonly accounts: readonly string[],
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS solana_permissions(origin TEXT PRIMARY KEY,account TEXT NOT NULL); CREATE TABLE IF NOT EXISTS solana_reviews(id TEXT PRIMARY KEY,origin TEXT NOT NULL,session TEXT NOT NULL,method TEXT NOT NULL,expires INTEGER NOT NULL,state TEXT NOT NULL)",
    );
  }
  account(origin: string) {
    originOf(origin);
    const row = this.db
      .prepare("SELECT account FROM solana_permissions WHERE origin=?")
      .get(origin);
    return row && this.accounts.includes(String(row.account))
      ? String(row.account)
      : null;
  }
  request(origin: string, session: string, method: string) {
    originOf(origin);
    if (!["connect", "signMessage", "signTransaction"].includes(method))
      throw new SolanaError("UNSUPPORTED_METHOD");
    if (method !== "connect" && !this.account(origin))
      throw new SolanaError("UNAUTHORIZED_ORIGIN");
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO solana_reviews VALUES(?,?,?,?,?,?)")
      .run(id, origin, session, method, Date.now() + 120000, "PENDING");
    return {
      id,
      origin,
      method,
      expires: Date.now() + 120000,
      accounts: method === "connect" ? this.accounts : [],
      warning:
        method === "connect"
          ? "Share a public devnet address only."
          : "Signing is disabled in the browser validation backend. Reject this request.",
    };
  }
  approve(id: string, session: string, account: string, approved: boolean) {
    const row = this.db
      .prepare(
        "SELECT * FROM solana_reviews WHERE id=? AND session=? AND state='PENDING' AND expires>?",
      )
      .get(id, session, Date.now());
    if (!row) throw new SolanaError("REVIEW_EXPIRED_OR_USED");
    if (
      approved &&
      row.method === "connect" &&
      !this.accounts.includes(account)
    )
      throw new SolanaError("INVALID_ACCOUNT");
    this.db
      .prepare("UPDATE solana_reviews SET state=? WHERE id=?")
      .run(approved && row.method === "connect" ? "APPROVED" : "REJECTED", id);
    if (!approved) throw new SolanaError("USER_REJECTED");
    if (row.method !== "connect")
      throw new SolanaError("BROWSER_SIGNING_DISABLED");
    this.db
      .prepare("INSERT OR REPLACE INTO solana_permissions VALUES(?,?)")
      .run(String(row.origin), account);
    return {
      address: account,
      publicKey: Array.from(getAddressEncoder().encode(publicKey(account))),
      chains: ["solana:devnet"],
      features: [],
    };
  }
  revoke(origin: string) {
    originOf(origin);
    this.db
      .prepare("DELETE FROM solana_permissions WHERE origin=?")
      .run(origin);
    this.db
      .prepare(
        "UPDATE solana_reviews SET state='REJECTED' WHERE origin=? AND state='PENDING'",
      )
      .run(origin);
  }
}
