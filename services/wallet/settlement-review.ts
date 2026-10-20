// Wallet handoff only. Payment verification, signing and execution remain in
// SolanaSettlement. This module deliberately has no signer or payment sender.
import { randomUUID } from "node:crypto";
import type { SolanaSettlement } from "../solana/settlement.ts";
import { publicKey } from "../solana/network.ts";
import { validateTerms } from "../solana/cpmm.ts";
import type { SwapTerms } from "../solana/settlement-model.ts";
import { fingerprint } from "./transaction-intents.ts";
import { digest as transactionDigest } from "../solana/transactions.ts";

export type DeliveryRequest = {
  profileId: string;
  requestId: string;
  recipient: string;
  relayer: string;
  lamports: string;
  account: string;
  paymentAddress: string;
};
export type ReviewReads = {
  // Must verify devnet genesis before returning any account data.
  check(): Promise<void>;
  balance(address: string): Promise<bigint>;
  terms(): Promise<SwapTerms>;
};
export class SettlementReview {
  constructor(
    readonly service: Pick<SolanaSettlement, "store" | "quote">,
    readonly reads: ReviewReads,
    readonly now = () => Math.floor(Date.now() / 1000),
  ) {
    service.store.db.exec(`CREATE TABLE IF NOT EXISTS wallet_settlement_reviews(
      id TEXT PRIMARY KEY, session TEXT NOT NULL, digest TEXT NOT NULL,
      payload TEXT NOT NULL, expires INTEGER NOT NULL, state TEXT NOT NULL,
      order_id TEXT);
      UPDATE wallet_settlement_reviews SET state='RECOVERY_REQUIRED'
      WHERE state='CREATING';`);
  }
  async review(
    session: string,
    request: DeliveryRequest,
    action: "transfer" | "swap",
  ) {
    // Copy before await: caller mutation cannot alter the approved destination.
    const input = structuredClone(request);
    if (!session || !["transfer", "swap"].includes(action))
      throw Error("INVALID_REVIEW");
    publicKey(input.recipient);
    publicKey(input.relayer);
    if (
      input.recipient === input.relayer ||
      !["1000000", "2000000", "5000000"].includes(input.lamports) ||
      !/^[a-f0-9]{64}$/.test(input.account) ||
      !input.paymentAddress.startsWith("utest1")
    )
      throw Error("DELIVERY_POLICY");
    const started = this.now();
    await this.reads.check();
    const swap =
      action === "swap" ? structuredClone(await this.reads.terms()) : undefined;
    if (swap) {
      validateTerms(swap);
      if (input.lamports !== swap.amountIn) throw Error("SWAP_INPUT_MISMATCH");
    }
    const debitCap = BigInt(input.lamports) + 10000n + (swap ? 6000000n : 0n);
    if ((await this.reads.balance(input.relayer)) < debitCap)
      throw Error("INSUFFICIENT_LIQUIDITY");
    if (this.now() - started > 30) throw Error("STALE_REVIEW");
    const payload = {
      input,
      ...(swap ? { swap } : {}),
      network: "solana:devnet",
      zatoshis: "100000",
      pricing: "FIXED_TESTNET_DEMO_NOT_EXCHANGE_RATE",
      feeCap: "10000",
      rentCap: swap ? "6000000" : "0",
      debitCap: debitCap.toString(),
    };
    const id = randomUUID(),
      expires = started + 90;
    const digest = fingerprint({ id, session, expires, payload });
    this.service.store.db
      .prepare(
        "INSERT INTO wallet_settlement_reviews VALUES(?,?,?,?,?,'REVIEW',NULL)",
      )
      .run(id, session, digest, JSON.stringify(payload), expires);
    // Account and shielded receiving address stay operator-only.
    return {
      id,
      digest,
      expires,
      network: payload.network,
      recipient: input.recipient,
      lamports: input.lamports,
      swap,
      zatoshis: payload.zatoshis,
      pricing: payload.pricing,
      feeCap: payload.feeCap,
      rentCap: payload.rentCap,
      debitCap: payload.debitCap,
      financialOrderCreated: false,
      executionAuthorized: false,
    };
  }
  async authorize(
    session: string,
    id: string,
    digest: string,
    approved: boolean,
    financialCreationEnabled = false,
  ) {
    if (!approved || !financialCreationEnabled)
      throw Error("FINANCIAL_AUTHORIZATION_REQUIRED");
    const db = this.service.store.db;
    const row = db
      .prepare(
        "SELECT * FROM wallet_settlement_reviews WHERE id=? AND session=?",
      )
      .get(id, session);
    if (
      !row ||
      row.digest !== digest ||
      row.state !== "REVIEW" ||
      Number(row.expires) <= this.now()
    )
      throw Error("REVIEW_UNAVAILABLE");
    const claimed = db
      .prepare(
        "UPDATE wallet_settlement_reviews SET state='CREATING' WHERE id=? AND state='REVIEW' AND expires>?",
      )
      .run(id, this.now());
    if (Number(claimed.changes) !== 1) throw Error("REVIEW_CLAIMED");
    try {
      const p = JSON.parse(String(row.payload));
      await this.reads.check();
      if (
        p.swap &&
        fingerprint(await this.reads.terms()) !== fingerprint(p.swap)
      )
        throw Error("REQUOTE_REQUIRED");
      if ((await this.reads.balance(p.input.relayer)) < BigInt(p.debitCap))
        throw Error("INSUFFICIENT_LIQUIDITY");
      if (Number(row.expires) <= this.now()) throw Error("REVIEW_EXPIRED");
      const orderId = `0x${transactionDigest(`${p.swap ? "phase7c" : "phase7b"}:${p.input.profileId}:${p.input.requestId}`)}`;
      if (this.service.store.get(orderId))
        throw Error("EXISTING_ORDER_REQUIRES_RECONCILIATION");
      const current = db
        .prepare("SELECT state FROM wallet_settlement_reviews WHERE id=?")
        .get(id);
      if (current?.state !== "CREATING") throw Error("REVIEW_CLAIM_LOST");
      const view = this.service.quote(p.input, p.swap);
      db.prepare(
        "UPDATE wallet_settlement_reviews SET state='CREATED',order_id=? WHERE id=? AND state='CREATING'",
      ).run(view.id, id);
      return {
        orderId: view.id,
        financialOrderCreated: true,
        executionAuthorized: false,
      };
    } catch (e) {
      // A crash or ambiguous adapter outcome never automatically creates another order.
      db.prepare(
        "UPDATE wallet_settlement_reviews SET state='RECOVERY_REQUIRED' WHERE id=?",
      ).run(id);
      throw e;
    }
  }
}
