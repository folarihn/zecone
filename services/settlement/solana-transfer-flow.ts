// Wallet authorization and observer interlock around the existing devnet executor.
// No key loader. Mainnet is deliberately not routed through this testnet engine.
import { createHash } from "node:crypto";
import { verifyMessage, getAddress, type Address, type Hex } from "viem";
import type { SolanaSettlement } from "../solana/settlement.ts";
import {
  SettlementReview,
  type DeliveryRequest,
} from "../wallet/settlement-review.ts";
import type { WatchOnlyZcash } from "../signer/watch-evidence.ts";
import { fingerprint } from "../wallet/transaction-intents.ts";
import { digest as transactionDigest } from "../solana/transactions.ts";
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export class SolanaTransferFlow {
  constructor(
    readonly reviewService: SettlementReview,
    readonly service: SolanaSettlement,
    readonly authorizer: Address,
  ) {
    getAddress(authorizer);
    if (reviewService.service.store !== service.store)
      throw Error("SAME_JOURNAL_REQUIRED");
    service.store.db.exec(`CREATE TABLE IF NOT EXISTS solana_wallet_grants(
      review_id TEXT PRIMARY KEY, session TEXT NOT NULL, authorizer TEXT NOT NULL,
      signature TEXT NOT NULL, message TEXT NOT NULL, order_id TEXT UNIQUE,
      binding TEXT, proof TEXT, busy INTEGER NOT NULL DEFAULT 0, execution_claim INTEGER NOT NULL DEFAULT 0,
      prepared_at INTEGER);
      UPDATE wallet_settlement_reviews SET state='RECOVERY_REQUIRED'
      WHERE id IN (SELECT review_id FROM solana_wallet_grants WHERE order_id IS NULL);`);
    for (const row of service.store.db
      .prepare(
        "SELECT order_id FROM solana_wallet_grants WHERE busy=1 AND order_id IS NOT NULL",
      )
      .all()) {
      const id = String(row.order_id);
      if (service.row(id).state !== "COMPLETED")
        service.recover(id, "interrupted_wallet_operation");
    }
  }
  private get db() {
    return this.service.store.db;
  }
  private get now() {
    return this.reviewService.now();
  }
  async review(
    session: string,
    request: DeliveryRequest,
    action: "transfer" | "spl-transfer" | "swap",
  ) {
    if (action !== "transfer" || request.spl) throw Error("NATIVE_SOL_ONLY");
    if (this.service.store.all().length)
      throw Error("FRESH_ISOLATED_CHECKOUT_REQUIRED");
    const result = await this.reviewService.review(session, request, action);
    return {
      ...result,
      authorizer: this.authorizer,
      message: this.message(result.id),
    };
  }
  private message(id: string) {
    const row = this.db
      .prepare("SELECT * FROM wallet_settlement_reviews WHERE id=?")
      .get(id);
    if (!row) throw Error("REVIEW_REQUIRED");
    const p = JSON.parse(String(row.payload));
    if (
      fingerprint({
        id: String(row.id),
        session: String(row.session),
        expires: Number(row.expires),
        payload: p,
      }) !== row.digest
    )
      throw Error("REVIEW_DIGEST_MISMATCH");
    if (p.swap || p.spl || p.network !== "solana:devnet")
      throw Error("NATIVE_SOL_ONLY");
    return `ZecOne TESTNET native SOL checkout\nReview: ${id}\nTerms: ${row.digest}\nRecipient: ${p.input.recipient}\nRelayer: ${p.input.relayer}\nLamports: ${p.input.lamports}\nFee cap: ${p.feeCap}\nTotal debit cap: ${p.debitCap}\nTestnet zatoshis: ${p.zatoshis}\nOrder deadline: ${p.orderDeadline}\nReview expires: ${row.expires}\nOne bounded settlement. No mainnet. No arbitrary dApp signing.`;
  }
  async authorizeSigned(
    session: string,
    id: string,
    digest: string,
    signature: Hex,
    assertContext: () => void,
  ) {
    if (!this.reviewService.sourceBinding?.reserveRelayer)
      throw Error("SOURCE_AND_RELAYER_RESERVATIONS_REQUIRED");
    const message = this.message(id);
    if (
      !(await verifyMessage({ address: this.authorizer, message, signature }))
    )
      throw Error("USER_SIGNATURE_REQUIRED");
    assertContext();
    const r = this.db
      .prepare(
        "SELECT * FROM wallet_settlement_reviews WHERE id=? AND session=? AND digest=? AND state='REVIEW' AND expires>?",
      )
      .get(id, session, digest, this.now);
    if (!r || this.service.store.all().length)
      throw Error("REVIEW_UNAVAILABLE");
    this.db
      .prepare(
        "INSERT INTO solana_wallet_grants(review_id,session,authorizer,signature,message) VALUES(?,?,?,?,?)",
      )
      .run(id, session, this.authorizer, signature, message);
    try {
      const terms = JSON.parse(String(r.payload));
      const orderId = `0x${transactionDigest(`phase7b:${terms.input.profileId}:${terms.input.requestId}`)}`;
      this.reviewService.sourceBinding.reserveRelayer(
        "solana:devnet",
        terms.input.relayer,
        orderId,
        BigInt(terms.debitCap),
        await this.reviewService.reads.balance(terms.input.relayer),
      );
      const result = await this.reviewService.authorize(
        session,
        id,
        digest,
        true,
        true,
        assertContext,
      );
      const order = this.service.store.get(result.orderId)!;
      this.db
        .prepare(
          "UPDATE solana_wallet_grants SET order_id=?,binding=? WHERE review_id=?",
        )
        .run(
          result.orderId,
          hash({
            intent: order.intent,
            account: order.account,
            address: order.address,
          }),
          id,
        );
      return result;
    } catch (e) {
      this.db
        .prepare(
          "UPDATE wallet_settlement_reviews SET state='RECOVERY_REQUIRED' WHERE id=?",
        )
        .run(id);
      throw e;
    }
  }
  private grant(id: string) {
    const g = this.db
      .prepare("SELECT * FROM solana_wallet_grants WHERE order_id=?")
      .get(id);
    const o = this.service.store.get(id);
    if (
      !g ||
      !o ||
      g.authorizer !== this.authorizer ||
      g.binding !==
        hash({ intent: o.intent, account: o.account, address: o.address }) ||
      this.message(String(g.review_id)) !== g.message ||
      this.service.intent(id).action !== "SOLANA_DEVNET_SOL_DELIVERY"
    )
      throw Error("WALLET_GRANT_MISMATCH");
    const r = this.db
      .prepare(
        "SELECT payload,state,session FROM wallet_settlement_reviews WHERE id=? AND order_id=?",
      )
      .get(g.review_id!, id);
    const p = r ? JSON.parse(String(r.payload)) : null,
      i = this.service.intent(id);
    if (
      !p ||
      r!.state !== "CREATED" ||
      r!.session !== g.session ||
      p.orderDeadline !== i.expiry ||
      p.input.recipient !== i.recipient ||
      p.input.relayer !== i.relayer ||
      p.input.lamports !== i.lamports ||
      p.feeCap !== i.feeCap ||
      p.zatoshis !== i.zatoshis ||
      p.input.account !== o.account ||
      p.input.paymentAddress !== o.address
    )
      throw Error("WALLET_TERMS_MISMATCH");
    return g;
  }
  private async verify(id: string) {
    const g = this.grant(id);
    if (
      !(await verifyMessage({
        address: this.authorizer,
        message: String(g.message),
        signature: String(g.signature) as Hex,
      }))
    )
      throw Error("USER_SIGNATURE_REQUIRED");
    return g;
  }
  private proof(id: string) {
    return hash({
      at: this.service.store.get(id)!.observed_at,
      rows: this.db
        .prepare(
          "SELECT key,zatoshis,height,block_hash,confirmed FROM payments WHERE order_id=? AND active=1 ORDER BY key",
        )
        .all(id),
    });
  }
  private claim(id: string, execution = false) {
    const result = this.db
      .prepare(
        `UPDATE solana_wallet_grants SET busy=1${execution ? ",execution_claim=1" : ""} WHERE order_id=? AND busy=0 AND execution_claim=0`,
      )
      .run(id);
    if (result.changes !== 1) throw Error("OPERATION_OR_EXECUTION_CLAIMED");
  }
  async observe(id: string, scanner: Pick<WatchOnlyZcash, "observe">) {
    await this.verify(id);
    this.claim(id);
    this.db
      .prepare("UPDATE solana_wallet_grants SET proof=NULL WHERE order_id=?")
      .run(id);
    try {
      if (this.service.store.all().length !== 1)
        throw Error("ISOLATED_CHECKOUT_REQUIRED");
      this.service.authorize(id, await scanner.observe());
      this.db
        .prepare("UPDATE solana_wallet_grants SET proof=? WHERE order_id=?")
        .run(this.proof(id), id);
      return this.state(id);
    } finally {
      this.db
        .prepare("UPDATE solana_wallet_grants SET busy=0 WHERE order_id=?")
        .run(id);
    }
  }
  private eligible(id: string) {
    const g = this.grant(id);
    if (!g.proof || g.proof !== this.proof(id))
      throw Error("NATIVE_OBSERVATION_REQUIRED");
    return this.service.eligible(id);
  }
  async prepare(id: string) {
    await this.verify(id);
    this.eligible(id);
    this.claim(id);
    try {
      await this.reviewService.reads.check();
      const p = await this.service.prepare(id);
      this.db
        .prepare(
          "UPDATE solana_wallet_grants SET prepared_at=? WHERE order_id=?",
        )
        .run(this.now, id);
      return {
        ...p,
        approvalExpires: Math.min(
          this.now + 90,
          this.service.intent(id).expiry,
        ),
        signing: false,
        broadcast: false,
      };
    } finally {
      this.db
        .prepare("UPDATE solana_wallet_grants SET busy=0 WHERE order_id=?")
        .run(id);
    }
  }
  async execute(
    id: string,
    approval: { orderId: string; digest: string; approved: true },
    signer: Parameters<SolanaSettlement["execute"]>[2],
  ) {
    const g = await this.verify(id);
    this.eligible(id);
    if (
      !g.prepared_at ||
      Number(g.prepared_at) + 90 <= this.now ||
      approval.orderId !== id ||
      approval.approved !== true ||
      !this.service.row(id).prepared ||
      JSON.parse(this.service.row(id).prepared!).digest !== approval.digest
    )
      throw Error("FRESH_EXACT_APPROVAL_REQUIRED");
    await this.reviewService.reads.check();
    this.eligible(id);
    this.claim(id, true);
    try {
      await this.service.execute(id, approval, signer, async () => {
        await this.verify(id);
        this.eligible(id);
        if (Number(this.grant(id).prepared_at) + 90 <= this.now)
          throw Error("EXACT_APPROVAL_EXPIRED");
      });
    } catch (e) {
      if (this.service.row(id).state !== "COMPLETED")
        this.service.recover(id, "wallet_execution_uncertain");
      throw e;
    } finally {
      this.db
        .prepare("UPDATE solana_wallet_grants SET busy=0 WHERE order_id=?")
        .run(id);
    }
    return this.state(id);
  }
  async reconcile(id: string) {
    await this.verify(id);
    await this.service.reconcile(id);
    if (this.service.row(id).state === "COMPLETED")
      this.reviewService.sourceBinding?.completeRelayer?.(id);
    return this.state(id);
  }
  state(id: string) {
    this.grant(id);
    const v = this.service.view(id),
      total = this.service.store.totals(id),
      g = this.grant(id);
    const state =
      v.state === "COMPLETED"
        ? "COMPLETED"
        : v.state === "RECOVERY_REQUIRED" || v.orderState === "recovery"
          ? "RECOVERY_REQUIRED"
          : v.signature
            ? "EXECUTING"
            : v.orderState === "expired"
              ? "FAILED"
              : v.orderState === "verified" && g.proof === this.proof(id)
                ? "CONFIRMED"
                : total.received > 0n
                  ? "DETECTED"
                  : "PAYMENT_PENDING";
    return {
      orderId: id,
      state,
      network: v.network,
      receivedZatoshis: v.receivedZatoshis,
      confirmedZatoshis: v.confirmedZatoshis,
      confirmations: v.confirmations,
      requiredConfirmations: 10,
      signature: v.signature,
      explorer: v.explorer,
      deliveredAmount: v.deliveredAmount,
      liveRefundsEnabled: false,
    };
  }
  scopedState(session: string, id: string) {
    this.reviewService.orderFor(session, id);
    return this.state(id);
  }
}
