import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SolanaError } from "./network.ts";
export const PRIVACY_NOTICE =
  "Shielded ZEC funding protects the Zcash payment details on-chain. Solana swap transactions and token ownership remain public. ZecOne's relayer can correlate funding and delivery.";
// Positive projection: no payment address/tx, account hashes, profile/request IDs,
// viewing authority, payer, operator audit rows or signed wire in ordinary history.
export function swapBrowserView(v: any, handle: string) {
  return {
    handle,
    network: v.network,
    state: v.state,
    recipient: v.recipient,
    swap: v.swap
      ? {
          program: v.swap.program,
          pool: v.swap.pool,
          inputMint: v.swap.inputMint,
          outputMint: v.swap.outputMint,
          inputDecimals: v.swap.inputDecimals,
          outputDecimals: v.swap.outputDecimals,
          amountIn: v.swap.amountIn,
          expectedOut: v.swap.expectedOut,
          minimumOut: v.swap.minimumOut,
          slippageBps: v.swap.slippageBps,
        }
      : null,
    zatoshis: v.zatoshis,
    pricing: v.pricing,
    feeCap: v.feeCap,
    expires: v.expires,
    confirmations: v.confirmations,
    requiredConfirmations: v.requiredConfirmations,
    signature: v.signature,
    explorer: v.explorer,
    liveRefundsEnabled: false,
    deliveredAmount: v.deliveredAmount ?? null,
    estimatedFee: v.prepared?.fee ?? null,
    privacy: PRIVACY_NOTICE,
  };
}
export function deliveryBrowserView(v: any, handle: string) {
  return {
    handle,
    id: handle,
    network: v.network,
    state: v.state,
    recipient: v.recipient,
    lamports: v.lamports,
    zatoshis: v.zatoshis,
    feeCap: v.feeCap,
    expires: v.expires,
    confirmedZatoshis: v.confirmedZatoshis,
    confirmations: v.confirmations,
    requiredConfirmations: v.requiredConfirmations,
    signature: v.signature,
    explorer: v.explorer,
    estimatedFee: v.prepared?.fee ?? null,
    liveRefundsEnabled: false,
    privacy: PRIVACY_NOTICE,
  };
}
export class ScopedHistory {
  constructor(readonly db: DatabaseSync) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS swap_history_handles(handle TEXT PRIMARY KEY,session_id TEXT NOT NULL,order_id TEXT NOT NULL,UNIQUE(session_id,order_id)); CREATE TABLE IF NOT EXISTS swap_diagnostics(at INTEGER NOT NULL,code TEXT NOT NULL); CREATE TABLE IF NOT EXISTS swap_recipient_uses(address_hash TEXT PRIMARY KEY);",
    );
  }
  handle(session: string, order: string) {
    const old = this.db
      .prepare(
        "SELECT handle FROM swap_history_handles WHERE session_id=? AND order_id=?",
      )
      .get(session, order);
    if (old) return String(old.handle);
    const h = randomBytes(24).toString("hex");
    this.db
      .prepare("INSERT INTO swap_history_handles VALUES(?,?,?)")
      .run(h, session, order);
    return h;
  }
  order(session: string, handle: string) {
    const row = this.db
      .prepare(
        "SELECT order_id FROM swap_history_handles WHERE handle=? AND session_id=?",
      )
      .get(handle, session);
    if (!row) throw new SolanaError("UNKNOWN_CHECKOUT");
    return String(row.order_id);
  }
  rows(session: string) {
    return this.db
      .prepare(
        "SELECT handle,order_id FROM swap_history_handles WHERE session_id=?",
      )
      .all(session);
  }
  owns(session: string, order: string) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM swap_history_handles WHERE session_id=? AND order_id=?",
      )
      .get(session, order);
  }
  reused(address: string) {
    return !!this.db
      .prepare("SELECT 1 FROM swap_recipient_uses WHERE address_hash=?")
      .get(createHash("sha256").update(address).digest("hex"));
  }
  markRecipient(address: string) {
    this.db
      .prepare("INSERT OR IGNORE INTO swap_recipient_uses VALUES(?)")
      .run(createHash("sha256").update(address).digest("hex"));
  }
  diagnostic(code: string, now: number) {
    // Only finite codes: never arbitrary errors, URLs, identifiers, keys or addresses.
    if (!["RPC_UNAVAILABLE", "INVALID_REQUEST", "QUOTE_FAILED"].includes(code))
      throw new SolanaError("UNSAFE_DIAGNOSTIC");
    this.db.prepare("INSERT INTO swap_diagnostics VALUES(?,?)").run(now, code);
    this.db
      .prepare(
        "DELETE FROM swap_diagnostics WHERE at<? OR rowid NOT IN (SELECT rowid FROM swap_diagnostics ORDER BY rowid DESC LIMIT 100)",
      )
      .run(now - 86400);
  }
}
