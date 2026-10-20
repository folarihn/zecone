// Orchestration around the existing Store, native transfer adapter and worker.
// No key loader or automatic execution loop. One isolated watch account/order.
import { randomUUID, createHash } from "node:crypto";
import { verifyMessage, getAddress, type Address, type Hex } from "viem";
import {
  EvmTransferSettlement,
  type EvmTransferRequest,
} from "./evm-transfer.ts";
import { transferDigest, validateTransfer } from "./transfers.ts";
import type { EvmTransferIntent } from "./transfer-types.ts";
import {
  validateWatchSnapshot,
  type WatchOnlyZcash,
  type WatchSnapshot,
} from "../signer/watch-evidence.ts";
import type { Executor } from "../execution/worker.ts";
import { revealPaymentRequest } from "../wallet/checkouts.ts";
import type { SourceBinding } from "./source-bindings.ts";
export class NativeTransferFlow {
  constructor(
    readonly settlement: EvmTransferSettlement,
    readonly authorizer: Address,
    readonly binding?: SourceBinding,
  ) {
    getAddress(authorizer);
    settlement.store.db
      .exec(`CREATE TABLE IF NOT EXISTS native_transfer_reviews(
      id TEXT PRIMARY KEY, session TEXT NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL,
      expires INTEGER NOT NULL, state TEXT NOT NULL, order_id TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS native_transfer_authority(order_id TEXT PRIMARY KEY,
      digest TEXT NOT NULL, reserved TEXT NOT NULL, authorizer TEXT NOT NULL, signature TEXT NOT NULL, execution_claim INTEGER NOT NULL DEFAULT 0,
      submission_claim INTEGER NOT NULL DEFAULT 0, evidence_valid INTEGER NOT NULL DEFAULT 0,
      watch_claim INTEGER NOT NULL DEFAULT 0, proof_digest TEXT);
      UPDATE native_transfer_reviews SET state='RECOVERY_REQUIRED' WHERE state='CREATING';`);
    for (const row of settlement.store.db
      .prepare(
        "SELECT o.id FROM orders o JOIN native_transfer_authority a ON a.order_id=o.id WHERE (a.execution_claim=1 AND o.tx_hash IS NULL AND o.state='verified') OR (a.submission_claim=1 AND o.state='prepared')",
      )
      .all()) {
      const id = String(row.id);
      settlement.store.recover(
        id,
        "interrupted_native_execution",
        {},
        settlement.now(),
      );
      settlement.store.transition(id, "recovery", settlement.now());
    }
  }
  private get store() {
    return this.settlement.store;
  }
  private get now() {
    return this.settlement.now();
  }
  async review(
    session: string,
    request: EvmTransferRequest,
    source?: EvmTransferIntent["source"],
  ) {
    request = structuredClone(request);
    source = source ? structuredClone(source) : undefined;
    if (!session || request.asset.kind !== "native") throw Error("NATIVE_ONLY");
    if (getAddress(request.relayer) === getAddress(this.authorizer))
      throw Error("DISTINCT_USER_RELAYER_REQUIRED");
    if (this.store.all().length)
      throw Error("FRESH_ISOLATED_CHECKOUT_REQUIRED");
    await this.checkRecipient(request.recipient);
    await this.checkRelayer(request.relayer);
    const preview = await this.settlement.preview(structuredClone(request));
    // Explicit maximum is separate from the current estimate. Paid orders
    // cannot silently increase this signed limit as fees change.
    preview.intent.feeCapWei = request.feeCapWei;
    preview.intent.fundingBinding = this.fundingBinding(
      request.account,
      request.paymentAddress,
    );
    if (source) preview.intent.source = structuredClone(source);
    const id = randomUUID(),
      expires = preview.quote.expires;
    // Authorize a bounded order, not a replaceable transaction hash. Financial
    // terms are fixed; execution re-simulates within these caps after payment.
    const payload = {
      request: structuredClone(request),
      intent: preview.intent,
    };
    const digest = transferDigest(preview.intent);
    this.store.db
      .prepare(
        "INSERT INTO native_transfer_reviews VALUES(?,?,?,?,?,'REVIEW',NULL)",
      )
      .run(id, session, JSON.stringify(payload), digest, expires);
    return {
      id,
      digest,
      expires,
      message: this.message(id, digest, expires, preview.intent),
      chainId: preview.intent.chainId,
      recipient: preview.intent.recipient,
      amount: preview.intent.amount,
      zatoshis: preview.intent.zatoshis,
      feeCapWei: preview.intent.feeCapWei,
      estimatedFeeWei: preview.quote.feeCapWei,
      pricing: preview.intent.pricing,
      orderExpiry: preview.intent.expiry,
      call: preview.call,
      source: preview.intent.source,
      financialOrderCreated: false,
      executionAuthorized: false,
    };
  }
  private async checkRecipient(recipient: Address) {
    await this.settlement.adapter.health();
    const code = await this.settlement.adapter.client.getBytecode({
      address: getAddress(recipient),
    });
    if (code && code !== "0x") throw Error("EOA_RECIPIENT_REQUIRED");
  }
  private fundingBinding(account: string, address: string) {
    return createHash("sha256")
      .update(JSON.stringify({ account, address }))
      .digest("hex");
  }
  private checkRequest(p: {
    request: EvmTransferRequest;
    intent: EvmTransferIntent;
  }) {
    if (
      p.intent.fundingBinding !==
        this.fundingBinding(p.request.account, p.request.paymentAddress) ||
      [
        "recipient",
        "relayer",
        "amount",
        "feeCapWei",
        "profileId",
        "requestId",
      ].some((key) => (p.request as any)[key] !== (p.intent as any)[key]) ||
      p.request.asset.kind !== "native" ||
      p.intent.asset.kind !== "native" ||
      p.intent.action !== "EVM_NATIVE_TRANSFER"
    )
      throw Error("AUTHORIZED_REQUEST_CHANGED");
  }
  private async checkRelayer(relayer: Address) {
    const [confirmed, pending] = await Promise.all([
      this.settlement.adapter.client.getTransactionCount({
        address: relayer,
        blockTag: "latest",
      }),
      this.settlement.adapter.client.getTransactionCount({
        address: relayer,
        blockTag: "pending",
      }),
    ]);
    if (confirmed !== pending) throw Error("RELAYER_BUSY");
  }
  private message(
    id: string,
    digest: string,
    expires: number,
    i: EvmTransferIntent,
  ) {
    return `ZecOne TESTNET ZEC-funded native delivery\nReview: ${id}\nOrder terms: ${digest}\nChain: ${i.chainId}\nRecipient: ${i.recipient}\nRelayer: ${i.relayer}\nNative amount (wei): ${i.amount}\nMaximum destination fee (wei): ${i.feeCapWei}\nPayment (testnet zatoshis): ${i.zatoshis}\nOrder expires: ${i.expiry}\nOrigin: ${i.source?.origin ?? "local wallet"}\nReview expires: ${expires}\nAuthorize one settlement within these exact order limits. No arbitrary wallet signing. No mainnet.`;
  }
  async authorize(
    session: string,
    id: string,
    signature: Hex,
    approved: boolean,
    assertContext: () => void = () => {},
  ) {
    assertContext();
    const row = this.store.db
      .prepare("SELECT * FROM native_transfer_reviews WHERE id=? AND session=?")
      .get(id, session);
    if (
      !approved ||
      !row ||
      row.state !== "REVIEW" ||
      Number(row.expires) <= this.now
    )
      throw Error("EXACT_REVIEW_REQUIRED");
    const p = JSON.parse(String(row.payload));
    this.checkRequest(p);
    if (
      !(await verifyMessage({
        address: this.authorizer,
        message: this.message(
          id,
          String(row.digest),
          Number(row.expires),
          p.intent,
        ),
        signature,
      }))
    )
      throw Error("WALLET_AUTHORIZATION_REQUIRED");
    validateTransfer(p.intent, this.settlement.policy, this.now);
    if (transferDigest(p.intent) !== row.digest) throw Error("TERMS_CHANGED");
    const refreshed = await this.settlement.preview(p.request);
    await this.checkRecipient(p.intent.recipient);
    await this.checkRelayer(p.intent.relayer);
    if (BigInt(refreshed.quote.feeCapWei) > BigInt(p.intent.feeCapWei))
      throw Error("FEE_TERMS_CHANGED");
    if (Number(row.expires) <= this.now) throw Error("REVIEW_EXPIRED");
    const reserve = BigInt(p.intent.amount) + BigInt(p.intent.feeCapWei);
    if (BigInt(refreshed.quote.balance) < reserve)
      throw Error("INSUFFICIENT_RESERVED_LIQUIDITY");
    const orderId = refreshed.id;
    this.store.atomic(() => {
      assertContext();
      if (this.store.all().length)
        throw Error("FRESH_ISOLATED_CHECKOUT_REQUIRED");
      const claimed = this.store.db
        .prepare(
          "UPDATE native_transfer_reviews SET state='CREATING' WHERE id=? AND state='REVIEW' AND expires>?",
        )
        .run(id, this.now);
      if (Number(claimed.changes) !== 1) throw Error("REVIEW_CLAIMED");
    });
    try {
      if (!this.binding) throw Error("GLOBAL_SOURCE_BINDING_REQUIRED");
      this.binding.claim(p.request.account, p.request.paymentAddress, orderId);
      // Use the reviewed intent, not the re-quoted nonce/fee terms. Store.create
      // retains its native uniqueness and audit behavior.
      this.store.create(
        orderId,
        p.intent,
        p.request.account,
        p.request.paymentAddress,
        this.now,
      );
      this.store.atomic(() => {
        this.store.db
          .prepare(
            "INSERT INTO native_transfer_authority(order_id,digest,reserved,authorizer,signature) VALUES(?,?,?,?,?)",
          )
          .run(
            orderId,
            row.digest,
            reserve.toString(),
            this.authorizer,
            signature,
          );
        this.store.db
          .prepare(
            "UPDATE native_transfer_reviews SET state='CREATED',order_id=? WHERE id=?",
          )
          .run(orderId, id);
        this.store.event(
          orderId,
          "native_wallet_authorized",
          { digest: row.digest },
          this.now,
        );
      });
      return this.status(session, id);
    } catch (e) {
      this.store.db
        .prepare(
          "UPDATE native_transfer_reviews SET state='RECOVERY_REQUIRED' WHERE id=?",
        )
        .run(id);
      throw e;
    }
  }
  async observe(id: string, scanner: Pick<WatchOnlyZcash, "observe">) {
    this.authority(id);
    const claim = this.store.db
      .prepare(
        "UPDATE native_transfer_authority SET watch_claim=1,evidence_valid=0 WHERE order_id=? AND watch_claim=0 AND execution_claim=0",
      )
      .run(id);
    if (Number(claim.changes) !== 1) throw Error("WATCH_OR_EXECUTION_CLAIMED");
    try {
      return this.applySnapshot(id, await scanner.observe());
    } finally {
      this.store.db
        .prepare(
          "UPDATE native_transfer_authority SET watch_claim=0 WHERE order_id=?",
        )
        .run(id);
    }
  }
  private applySnapshot(id: string, s: WatchSnapshot) {
    const order = this.store.get(id);
    if (!order || this.store.all().length !== 1 || !this.authority(id))
      throw Error("ISOLATED_AUTHORIZED_ORDER_REQUIRED");
    validateWatchSnapshot(s, this.now);
    if (
      s.account !== order.account ||
      s.address !== order.address ||
      s.payments.some(
        (p) =>
          p.pool !== 4 ||
          !s.native.inputs.some(
            (n) =>
              n.paymentKey === `${p.txid}:${p.pool}:${p.index}` &&
              n.zatoshis === p.zatoshis &&
              n.minedHeight === p.height,
          ),
      )
    )
      throw Error("OWNED_PAYMENT_BINDING_REQUIRED");
    this.store.observe(s, this.now);
    this.store.db
      .prepare(
        "UPDATE native_transfer_authority SET evidence_valid=1,proof_digest=? WHERE order_id=?",
      )
      .run(this.paymentProof(id), id);
    const totals = this.store.totals(id),
      i = JSON.parse(order.intent);
    if (
      totals.received > BigInt(i.zatoshis) ||
      (this.now >= i.expiry && totals.received > 0n) ||
      (order.state === "verified" && totals.confirmed < BigInt(i.zatoshis))
    ) {
      this.store.recover(id, "native_payment_requires_recovery", {}, this.now);
      this.store.transition(id, "recovery", this.now);
    }
    return this.orderState(id);
  }
  private authority(id: string) {
    const row = this.store.db
      .prepare("SELECT * FROM native_transfer_authority WHERE order_id=?")
      .get(id);
    const order = this.store.get(id);
    const intent = order ? JSON.parse(order.intent) : null;
    if (
      !row ||
      !order ||
      intent?.family !== "evm" ||
      intent?.chainId !== this.settlement.adapter.chainId ||
      intent?.action !== "EVM_NATIVE_TRANSFER" ||
      intent?.asset?.kind !== "native" ||
      intent?.fundingBinding !==
        this.fundingBinding(order.account, order.address) ||
      getAddress(String(row.authorizer)) !== getAddress(this.authorizer) ||
      transferDigest(intent) !== row.digest
    )
      throw Error("ORDER_AUTHORIZATION_MISMATCH");
    return row;
  }
  private paymentProof(id: string) {
    return createHash("sha256")
      .update(
        JSON.stringify({
          observedAt: this.store.get(id)!.observed_at,
          payments: this.store.db
            .prepare(
              "SELECT key,zatoshis,height,block_hash,confirmed FROM payments WHERE order_id=? AND active=1 ORDER BY key",
            )
            .all(id),
        }),
      )
      .digest("hex");
  }
  private async checkGrant(id: string) {
    const authority = this.authority(id);
    const review = this.store.db
      .prepare(
        "SELECT * FROM native_transfer_reviews WHERE order_id=? AND state='CREATED'",
      )
      .get(id);
    if (!review) throw Error("FINANCIAL_REVIEW_REQUIRED");
    const p = JSON.parse(String(review.payload));
    this.checkRequest(p);
    const order = this.store.get(id)!;
    if (
      p.intent.fundingBinding !==
        this.fundingBinding(order.account, order.address) ||
      transferDigest(p.intent) !== authority.digest ||
      !(await verifyMessage({
        address: this.authorizer,
        message: this.message(
          String(review.id),
          String(authority.digest),
          Number(review.expires),
          p.intent,
        ),
        signature: String(authority.signature) as Hex,
      }))
    )
      throw Error("WALLET_AUTHORIZATION_REQUIRED");
  }
  async execute(id: string, executor: Executor, operatorApproved: boolean) {
    const authority = this.authority(id);
    if (!operatorApproved) throw Error("LIVE_OPERATOR_APPROVAL_REQUIRED");
    const o = this.store.get(id)!;
    if (o.state === "settled") throw Error("DUPLICATE_EXECUTION_REJECTED");
    await this.checkGrant(id);
    if (o.tx_hash) return this.reconcile(id, executor);
    if (
      authority.evidence_valid !== 1 ||
      authority.proof_digest !== this.paymentProof(id)
    )
      throw Error("NATIVE_WATCH_VERIFICATION_REQUIRED");
    if (!this.store.eligible(o, this.now))
      throw Error("VERIFIED_PAYMENT_REQUIRED");
    validateTransfer(JSON.parse(o.intent), this.settlement.policy, this.now);
    const review = this.store.db
      .prepare(
        "SELECT payload FROM native_transfer_reviews WHERE order_id=? AND state='CREATED'",
      )
      .get(id);
    if (!review) throw Error("FINANCIAL_REVIEW_REQUIRED");
    const fresh = await this.settlement.preview(
      JSON.parse(String(review.payload)).request,
    );
    await this.checkRecipient(JSON.parse(o.intent).recipient);
    await this.checkRelayer(JSON.parse(o.intent).relayer);
    const intent = JSON.parse(o.intent);
    if (BigInt(fresh.quote.feeCapWei) > BigInt(intent.feeCapWei))
      throw Error("FEE_TERMS_CHANGED");
    if (
      fresh.quote.expires <= this.now ||
      !this.store.eligible(this.store.get(id)!, this.now) ||
      this.authority(id).evidence_valid !== 1 ||
      this.authority(id).proof_digest !== this.paymentProof(id)
    )
      throw Error("VERIFIED_PAYMENT_OR_QUOTE_EXPIRED");
    const claim = this.store.atomic(() => {
      const result = this.store.db
        .prepare(
          "UPDATE native_transfer_authority SET execution_claim=1 WHERE order_id=? AND execution_claim=0 AND watch_claim=0 AND evidence_valid=1",
        )
        .run(id);
      if (Number(result.changes) === 1)
        this.store.event(
          id,
          "native_operator_execution_approved",
          {
            mode: "ONE_BOUNDED_NATIVE_SETTLEMENT",
            termsDigest: authority.digest,
          },
          this.now,
        );
      return result;
    });
    if (Number(claim.changes) !== 1) throw Error("EXECUTION_ALREADY_CLAIMED");
    const guarded: Executor = {
      prepare: (order) => executor.prepare(order),
      receipt: (order) => executor.receipt(order),
      broadcast: async (raw) => {
        const changed = this.store.db
          .prepare(
            "UPDATE native_transfer_authority SET submission_claim=1 WHERE order_id=? AND submission_claim=0",
          )
          .run(id);
        if (Number(changed.changes) !== 1)
          throw Error("SUBMISSION_RECONCILIATION_REQUIRED");
        return executor.broadcast(raw);
      },
    };
    try {
      await this.settlement.execute(id, guarded);
    } catch (e) {
      if (this.store.get(id)?.state !== "settled") {
        this.store.recover(id, "native_execution_uncertain", {}, this.now);
        this.store.transition(id, "recovery", this.now);
      }
      throw e;
    }
    return this.orderState(id);
  }
  async reconcile(id: string, executor: Pick<Executor, "receipt">) {
    this.authority(id);
    await this.checkGrant(id);
    const o = this.store.get(id)!;
    if (o.state === "settled") return this.orderState(id);
    if (!o.tx_hash) throw Error("NO_SUBMISSION_TO_RECONCILE");
    const result = await executor.receipt(o);
    if (result.status === "success") this.store.settled(id, result, this.now);
    if (result.status === "reverted") this.store.failed(id, this.now);
    return this.orderState(id);
  }
  private orderState(id: string) {
    const order = this.store.get(id)!,
      totals = this.store.totals(id);
    const evidence = this.authority(id);
    const verified =
      evidence.evidence_valid === 1 &&
      evidence.proof_digest === this.paymentProof(id);
    const expired = this.now >= JSON.parse(order.intent).expiry;
    const state =
      order.state === "settled"
        ? "COMPLETED"
        : order.state === "recovery" ||
            (expired && totals.received > 0n && !order.tx_hash)
          ? "RECOVERY_REQUIRED"
          : ["failed", "expired"].includes(order.state)
            ? "FAILED"
            : order.tx_hash
              ? "EXECUTING"
              : expired
                ? "FAILED"
                : order.state === "verified" && verified
                  ? "PAYMENT_CONFIRMED"
                  : totals.received > 0n
                    ? "PAYMENT_DETECTED"
                    : "PAYMENT_PENDING";
    return {
      state,
      receivedZatoshis: totals.received.toString(),
      confirmedZatoshis: verified ? totals.confirmed.toString() : "0",
      nativePaymentVerified: verified,
      requiredConfirmations: this.store.confirmations,
      transactionHash: order.tx_hash,
      liveRefundsEnabled: false,
    };
  }
  status(session: string, reviewId: string) {
    const row = this.store.db
      .prepare("SELECT * FROM native_transfer_reviews WHERE id=? AND session=?")
      .get(reviewId, session);
    if (!row) throw Error("SCOPED_REVIEW_REQUIRED");
    if (!row.order_id)
      return { state: row.state, financialOrderCreated: false };
    return {
      ...this.orderState(String(row.order_id)),
      financialOrderCreated: true,
    };
  }
  paymentRequest(session: string, reviewId: string) {
    const row = this.store.db
      .prepare(
        "SELECT order_id FROM native_transfer_reviews WHERE id=? AND session=? AND state='CREATED'",
      )
      .get(reviewId, session);
    if (!row) throw Error("SCOPED_REVIEW_REQUIRED");
    const id = String(row.order_id),
      order = this.store.get(id)!;
    return revealPaymentRequest(
      id,
      order,
      this.store.totals(id).received,
      this.now,
    );
  }
  source(session: string, reviewId: string): EvmTransferIntent["source"] {
    const row = this.store.db
      .prepare(
        "SELECT payload FROM native_transfer_reviews WHERE id=? AND session=?",
      )
      .get(reviewId, session);
    if (!row) throw Error("SCOPED_REVIEW_REQUIRED");
    return JSON.parse(String(row.payload)).intent.source;
  }
  resume(session: string) {
    const row = this.store.db
      .prepare(
        "SELECT * FROM native_transfer_reviews WHERE session=? AND state='CREATED' ORDER BY expires DESC LIMIT 1",
      )
      .get(session);
    if (!row) return null;
    const i = JSON.parse(String(row.payload)).intent;
    return {
      review: {
        id: row.id,
        recipient: i.recipient,
        amount: i.amount,
        feeCapWei: i.feeCapWei,
        expires: row.expires,
        source: i.source,
        orderExpiry: i.expiry,
      },
      status: this.status(session, String(row.id)),
    };
  }
}
