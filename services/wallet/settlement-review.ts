// Wallet handoff only. Payment verification, signing and execution remain in
// SolanaSettlement. This module deliberately has no signer or payment sender.
import { randomUUID } from "node:crypto";
import type { SolanaSettlement } from "../solana/settlement.ts";
import { publicKey } from "../solana/network.ts";
import { validateTerms } from "../solana/cpmm.ts";
import type { SolanaSplAsset, SwapTerms } from "../solana/settlement-model.ts";
import { fingerprint } from "./transaction-intents.ts";
import { revealPaymentRequest } from "./checkouts.ts";
import { digest as transactionDigest } from "../solana/transactions.ts";
import type { SourceBinding } from "../settlement/source-bindings.ts";

export type DeliveryRequest = {
  profileId: string;
  requestId: string;
  recipient: string;
  relayer: string;
  lamports: string;
  account: string;
  paymentAddress: string;
  // Operator-supplied allowlisted token; never accepted from the dApp.
  spl?: SolanaSplAsset;
};
export type ReviewReads = {
  // Must verify devnet genesis before returning any account data.
  check(): Promise<void>;
  balance(address: string): Promise<bigint>;
  tokenBalance?(address: string, mint: string): Promise<bigint>;
  terms(): Promise<SwapTerms>;
};
export class SettlementReview {
  constructor(
    readonly service: Pick<SolanaSettlement, "store" | "quote">,
    readonly reads: ReviewReads,
    readonly now = () => Math.floor(Date.now() / 1000),
    readonly sourceBinding?: SourceBinding,
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
    action: "transfer" | "spl-transfer" | "swap",
  ) {
    // Copy before await: caller mutation cannot alter the approved destination.
    const input = structuredClone(request);
    if (action === "spl-transfer" && !input.spl)
      throw Error("SPL_ASSET_REQUIRED");
    if (!session || !["transfer", "spl-transfer", "swap"].includes(action))
      throw Error("INVALID_REVIEW");
    publicKey(input.recipient);
    publicKey(input.relayer);
    const spl = action === "spl-transfer" ? structuredClone(input.spl) : null;
    if (
      input.recipient === input.relayer ||
      (spl
        ? !/^[1-9]\d{0,17}$/.test(input.lamports) ||
          !spl ||
          spl.kind !== "SPL" ||
          !Number.isInteger(spl.decimals) ||
          spl.decimals < 0 ||
          spl.decimals > 255
        : !["1000000", "2000000", "5000000"].includes(input.lamports)) ||
      !/^[a-f0-9]{64}$/.test(input.account) ||
      !input.paymentAddress.startsWith("utest1")
    )
      throw Error("DELIVERY_POLICY");
    if (spl) publicKey(spl.mint);
    if (!spl && input.spl) delete input.spl;
    const started = this.now();
    await this.reads.check();
    const swap =
      action === "swap" ? structuredClone(await this.reads.terms()) : undefined;
    if (swap) {
      validateTerms(swap);
      if (input.lamports !== swap.amountIn) throw Error("SWAP_INPUT_MISMATCH");
    }
    const debitCap = spl
      ? 10000n
      : BigInt(input.lamports) + 10000n + (swap ? 6000000n : 0n);
    if ((await this.reads.balance(input.relayer)) < debitCap)
      throw Error("INSUFFICIENT_LIQUIDITY");
    if (
      spl &&
      (!this.reads.tokenBalance ||
        (await this.reads.tokenBalance(input.relayer, spl.mint)) <
          BigInt(input.lamports))
    )
      throw Error("INSUFFICIENT_TOKEN_LIQUIDITY");
    if (this.now() - started > 30) throw Error("STALE_REVIEW");
    const payload = {
      input,
      ...(swap ? { swap } : {}),
      ...(spl ? { spl } : {}),
      network: "solana:devnet",
      zatoshis: "100000",
      pricing: "FIXED_TESTNET_DEMO_NOT_EXCHANGE_RATE",
      feeCap: "10000",
      rentCap: swap ? "6000000" : "0",
      debitCap: debitCap.toString(),
      orderDeadline: started + 7200,
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
      ...(swap ? { swap } : {}),
      ...(spl ? { spl } : {}),
      zatoshis: payload.zatoshis,
      pricing: payload.pricing,
      feeCap: payload.feeCap,
      rentCap: payload.rentCap,
      debitCap: payload.debitCap,
      financialOrderCreated: false,
      executionAuthorized: false,
    };
  }
  status(session: string) {
    return (
      this.service.store.db
        .prepare(
          "SELECT id,state,order_id,expires FROM wallet_settlement_reviews WHERE session=? ORDER BY expires DESC",
        )
        .all(session) as {
        id: string;
        state: string;
        order_id: string | null;
        expires: number;
      }[]
    ).map((r) => ({
      id: r.id,
      state: r.state,
      expires: r.expires,
      orderId: r.order_id,
    }));
  }
  orderFor(session: string, orderId: string) {
    const row = this.service.store.db
      .prepare(
        "SELECT order_id FROM wallet_settlement_reviews WHERE session=? AND order_id=? AND state='CREATED'",
      )
      .get(session, orderId) as { order_id: string } | undefined;
    if (!row) throw Error("REVIEW_ORDER_NOT_OWNED");
    return this.service.store.get(orderId)!;
  }
  financialAction(session: string, reviewId: string) {
    const row = this.service.store.db
      .prepare(
        "SELECT payload FROM wallet_settlement_reviews WHERE id=? AND session=?",
      )
      .get(reviewId, session);
    if (!row) throw Error("SCOPED_REVIEW_REQUIRED");
    const p = JSON.parse(String(row.payload));
    return p.spl ? "spl-transfer" : p.swap ? "swap" : "transfer";
  }
  paymentRequest(session: string, orderId: string) {
    const order = this.orderFor(session, orderId);
    return revealPaymentRequest(
      orderId,
      order,
      this.service.store.totals(orderId).received,
      this.now(),
    );
  }
  async authorize(
    session: string,
    id: string,
    digest: string,
    approved: boolean,
    financialCreationEnabled = false,
    assertContext: () => void = () => {},
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
      if (
        p.spl &&
        (!this.reads.tokenBalance ||
          (await this.reads.tokenBalance(p.input.relayer, p.spl.mint)) <
            BigInt(p.input.lamports))
      )
        throw Error("INSUFFICIENT_TOKEN_LIQUIDITY");
      if (Number(row.expires) <= this.now()) throw Error("REVIEW_EXPIRED");
      const orderId = `0x${transactionDigest(`${p.swap ? "phase7c" : p.spl ? "spl-delivery" : "phase7b"}:${p.input.profileId}:${p.input.requestId}`)}`;
      if (this.service.store.get(orderId))
        throw Error("EXISTING_ORDER_REQUIRES_RECONCILIATION");
      const current = db
        .prepare("SELECT state FROM wallet_settlement_reviews WHERE id=?")
        .get(id);
      if (current?.state !== "CREATING") throw Error("REVIEW_CLAIM_LOST");
      assertContext();
      this.sourceBinding?.claim(
        p.input.account,
        p.input.paymentAddress,
        orderId,
      );
      const view = this.service.quote(p.input, p.swap, p.spl);
      if (p.orderDeadline) {
        const order = this.service.store.get(view.id)!;
        const intent = JSON.parse(order.intent);
        intent.expiry = Math.min(intent.expiry, p.orderDeadline);
        db.prepare("UPDATE orders SET intent=? WHERE id=?").run(
          JSON.stringify(intent),
          view.id,
        );
      }
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
