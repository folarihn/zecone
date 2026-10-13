import { network, NETWORK_IDS } from "../evm/networks.ts";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { PurchaseJournal, type PurchaseRow } from "./journal.ts";
import {
  PurchaseBase,
  interpret,
  terms,
  validateSignature,
  priceZatoshis,
  RATE,
  GAS_BUDGET,
  type MarketConfig,
  type UnsignedPurchase,
  type PurchaseIntent,
} from "./purchase.ts";
import { Zcash } from "../execution/zcash.ts";
import { Store } from "../execution/store.ts";
import { locked, readJson, exclusiveJson } from "../execution/io.ts";
import { requireApproval, uuid } from "../wallet/engine.ts";
import { ApiError, type Session } from "../wallet/security.ts";
import { userWalletNative } from "../wallet/native.ts";
import type { Base } from "../execution/base.ts";
import type { Executor } from "../execution/worker.ts";
import { classifyIntent, type SignedExecutionIntent, type UnsignedExecutionIntent } from "../execution/model.ts";
export interface PurchaseBackend extends Executor {
  public: Base["public"]; account: Base["account"];
  check(): Promise<void>; validate(intent: SignedExecutionIntent): Promise<Hex>;
}
const exec = promisify(execFile),
  now = () => Math.floor(Date.now() / 1000),
  hash = (v: unknown) =>
    createHash("sha256").update(JSON.stringify(v)).digest("hex");
export class Purchases {
  busy = false;
  lockPath = ".state/service.lock";
  legacyPath = ".state/orders.sqlite";
  approvalDir = ".state/purchase-approvals";
  signerScript = "scripts/local-purchase-sign.ts";
  receiptUncertainReason = "nft_ownership_or_receipt_uncertain";
  validateTerms(i: UnsignedExecutionIntent) { if(i.kind!=="purchase")throw Error("wrong_execution_adapter");return terms(i, this.config(i.chainId), this.manifest.base.user, now()); }
  validateSigned(i: SignedExecutionIntent) { const view=classifyIntent(i);if(view.action!=="NFT_PURCHASE")throw Error("wrong_execution_adapter");return validateSignature(view.signed, this.config(i.chainId), this.manifest.base.user, now()); }
  available() {
    return NETWORK_IDS.some(id => existsSync(network(id).deploymentFile));
  }
  constructor(
    readonly store = new PurchaseJournal(),
    readonly manifest = readJson<{
      base: { user: Address };
      zcash: { payer: { account: string; address: string } };
    }>("docs/PUBLIC_WALLETS.json"),
    readonly scanner: Pick<Zcash, "allocate" | "observe"> = new Zcash(),
  ) {
    this.store.db
      .prepare(
        "UPDATE purchase_requests SET stage='review' WHERE stage IN ('creating','sending')",
      )
      .run();
  }
  config(chainId = 84532) {
    const file = network(chainId).deploymentFile;
    if (!existsSync(file))
      throw new ApiError(503, "Marketplace has not been configured.");
    const c = readJson<MarketConfig>(file);
    if ((c.chainId ?? 84532) !== chainId) throw Error("deployment_chain_mismatch");
    return c;
  }
  base(chainId = 84532): PurchaseBackend {
    return new PurchaseBase(this.config(chainId));
  }
  async native<T>(args: string[], deadline?: number): Promise<T> {
    return userWalletNative<T>(args, deadline);
  }
  async review(s: Session, origin: string, id: string, p: unknown[], chainId = 84532) {
    requireApproval(s, true);
    const c = this.config(chainId);
    if (origin !== c.origin)
      throw new ApiError(403, "This marketplace origin is not allowlisted.");
    if (
      p.length !== 1 ||
      !p[0] ||
      typeof p[0] !== "object" ||
      Array.isArray(p[0])
    )
      throw Error("invalid_purchase");
    const b = this.base(chainId);
    await b.check();
    const l = await interpret(
      b.public,
      c,
      p[0] as Record<string, unknown>,
      this.manifest.base.user,
      b.account.address,
    );
    const expiry = Math.min(now() + 3600, l.listingExpiry - 60);
    if (expiry < now() + 1800)
      throw new ApiError(
        409,
        "Listing expires too soon for shielded payment confirmation.",
      );
    const orderId = toHex(randomBytes(32));
    const i: UnsignedPurchase = {
      kind: "purchase",
      orderId,
      nonce: orderId,
      chainId,
      ...(chainId === 84532 ? {} : { sourceNetwork: keccak256(toHex("zcash-testnet")), provider: b.account.address, adapter: keccak256(toHex(network(chainId).adapter)) }),
      contract: c.executor,
      marketplace: c.marketplace,
      listingId: l.listingId,
      nft: l.nft,
      tokenId: l.tokenId,
      seller: l.seller,
      recipient: this.manifest.base.user,
      price: l.price,
      gasBudget: network(chainId).gasBudget.toString(),
      zatoshis: priceZatoshis(BigInt(l.price), chainId).toString(),
      rate: RATE.toString(),
      maxSlippageBps: "0",
      expiry,
      calldataHash: l.calldataHash,
      refundHash: keccak256(toHex(this.manifest.zcash.payer.address)),
      originHash: keccak256(toHex(origin)),
    };
    terms(i, c, this.manifest.base.user, now());
    await this.withLock(async () => this.store.reserve(
      id,
      origin,
      s.id,
      i,
      this.manifest.zcash.payer.address,
      randomUUID(),
      await b.public.getBalance({
        address: b.account.address,
        blockTag: "pending",
      }),
      now(),
    ));
    return {
      ...i,
      networkName: network(chainId).name,
      account: i.recipient,
      estimatedGas: l.estimatedGas,
      liquidityWei: (BigInt(i.price) + BigInt(i.gasBudget)).toString(),
      refundDestination: this.manifest.zcash.payer.address,
      simulation:
        "Marketplace eth_call and gas estimation succeeded. Listing is rechecked before payment and execution.",
      trust:
        "Simulated rate: 1 TAZ = 0.02 test ETH. Fixed gas reserve is charged even if unused. Provider supplies ETH; marketplace receives ETH. Provider can correlate payment and purchase. Manual refunds only.",
    };
  }
  async approve(s: Session, id: string) {
    requireApproval(s, true);
    const r = this.store.row(uuid(id));
    if (!r || r.session !== s.id)
      throw new ApiError(403, "Purchase session mismatch.");
    if (r.order_id) return { purchaseId: id };
    if (r.stage !== "draft")
      throw new ApiError(409, "Reconcile the existing purchase.");
    const i = JSON.parse(r.intent) as UnsignedExecutionIntent;
    this.validateTerms(i);
    this.store.stage(id, "creating");
    try {
      const path = resolve(this.approvalDir, `${id}.json`);
      exclusiveJson(path, {
        approved: true,
        expires: Math.min(s.expires, Date.now() + 300000),
        intent: i,
      });
      const { stdout } = await exec(
        process.execPath,
        ["--import", "tsx", this.signerScript, path],
        { windowsHide: true, timeout: 90000, maxBuffer: 100000 },
      );
      const signed = readJson<SignedExecutionIntent>(JSON.parse(stdout).intentFile);
      await this.attach(r, signed);
    } catch {
      this.store.stage(id, "review");
      throw new ApiError(
        503,
        "Purchase creation requires reconciliation; do not pay again.",
      );
    }
    return { purchaseId: id };
  }
  async attach(r: PurchaseRow, signed: SignedExecutionIntent) {
    classifyIntent(signed);
    const { signature: approvalSignature, ...unsigned } = signed;
    if (JSON.stringify(unsigned) !== r.intent) throw Error("signed_reservation_mismatch");
    const b = this.base(signed.chainId),
      id = await this.validateSigned(signed);
    await b.validate(signed);
    await this.withLock(async () => {
      const dest = await this.scanner.allocate(id);
      this.store.create(id, signed, dest.account, dest.address, now());
      this.store.db
        .prepare(
          "UPDATE purchase_requests SET order_id=?,stage='awaiting' WHERE id=?",
        )
        .run(id, r.id);
    });
  }
  row(id: string) {
    const r = this.store.row(uuid(id));
    if (!r) throw new ApiError(404, "Purchase not found.");
    return r;
  }
  cancelDraft(id: string) {
    const r = this.store.row(id);
    if (r?.stage === "draft") {
      this.store.stage(id, "cancelled");
      this.store.release(id);
    }
  }
  view(r: PurchaseRow, external = false): any {
    const i = JSON.parse(r.intent) as UnsignedPurchase,
      o = r.order_id ? this.store.get(r.order_id) : undefined,
      tot = o ? this.store.totals(o.id) : { received: 0n, confirmed: 0n };
    const scans = o
      ? (this.store.db
          .prepare(
            "SELECT detail FROM audit WHERE order_id=? AND event='scan_verified' ORDER BY seq DESC LIMIT 1",
          )
          .get(o.id) as { detail: string } | undefined)
      : undefined;
    const tip = scans ? JSON.parse(scans.detail).tip : 0;
    const notes = o
      ? (this.store.db
          .prepare("SELECT height FROM payments WHERE order_id=? AND active=1")
          .all(o.id) as { height: number }[])
      : [];
    const confirmations = notes.length
      ? Math.max(0, Math.min(...notes.map((n) => tip - n.height + 1)))
      : 0;
    const recoveries = o
      ? this.store.db
          .prepare(
            "SELECT reason,status FROM recoveries WHERE order_id=? AND status='review_required'",
          )
          .all(o.id)
      : [];
    const status =
      recoveries.length || r.stage === "review" || o?.state === "recovery"
        ? "Manual recovery required"
        : o?.state === "settled"
          ? "Completed"
          : o?.state === "failed"
            ? "Failed"
            : o?.state === "expired" || (i.expiry <= now() && !o?.tx_hash)
              ? "Expired"
              : o?.tx_hash
                ? "Executing"
                : o?.state === "verified"
                  ? "Payment verified"
                  : tot.received > 0n
                    ? `Confirming`
                    : r.stage === "sending"
                      ? "Sending shielded payment"
                      : r.stage === "sent"
                        ? "Payment sent — awaiting mining"
                        : r.stage === "draft"
                          ? "Awaiting quote approval"
                          : r.stage === "cancelled"
                            ? "Quote rejected"
                            : "Awaiting payment";
    const publicView = {
      id: r.id,
      chainId: i.chainId,
      networkName: network(i.chainId).name,
      explorer: network(i.chainId).explorer,
      status,
      listingId: i.listingId,
      nft: i.nft,
      tokenId: i.tokenId,
      recipient: i.recipient,
      baseTx: o?.tx_hash ?? null,
      ownerVerified: o?.state === "settled" && !recoveries.length,
      manualRecovery:
        recoveries.length > 0 ||
        r.stage === "review" ||
        o?.state === "recovery",
    };
    return external
      ? publicView
      : {
          ...publicView,
          stage: r.stage,
          origin: r.origin,
          price: i.price,
          zatoshis: i.zatoshis,
          gasBudget: i.gasBudget,
          expiry: i.expiry,
          refundDestination: r.refund,
          confirmations,
          requiredConfirmations: 10,
          receivedZatoshis: tot.received.toString(),
          paymentTx: r.payment_tx,
          fee: r.native_quote ? JSON.parse(r.native_quote) : null,
          recoveries,
          refundPolicy:
            "Manual review only. No refund has been sent. Do not make another payment.",
        };
  }
  list() {
    return this.store.rows().map((r) => this.view(r));
  }
  externalStatus(origin: string, id: string) {
    const r = this.row(id);
    if (r.origin !== origin)
      throw new ApiError(403, "Purchase origin mismatch.");
    return this.view(r, true);
  }
  async fee(s: Session, id: string) {
    requireApproval(s, true);
    const r = this.row(id),
      o = r.order_id ? this.store.get(r.order_id) : undefined;
    if (
      !o ||
      !["awaiting", "quoted"].includes(r.stage) ||
      o.state !== "awaiting_payment" ||
      this.store.totals(o.id).received > 0n
    )
      throw new ApiError(409, "This purchase cannot accept another payment.");
    await this.base(JSON.parse(o.intent).chainId).validate(JSON.parse(o.intent));
    const q = await this.native<{ feeZatoshis: string; totalZatoshis: string }>(
      [
        "quote",
        "--account",
        this.manifest.zcash.payer.account,
        "--address",
        o.address,
        "--zatoshis",
        JSON.parse(o.intent).zatoshis,
      ],
    );
    const quote = {
      id: randomUUID(),
      feeZatoshis: q.feeZatoshis,
      totalZatoshis: q.totalZatoshis,
      expires: Date.now() + 120000,
    };
    this.store.db
      .prepare(
        "UPDATE purchase_requests SET native_quote=?,quote_session=?,stage='quoted' WHERE id=? AND stage IN ('awaiting','quoted')",
      )
      .run(JSON.stringify(quote), s.id, id);
    return this.view(this.row(id));
  }
  async pay(s: Session, id: string, quoteId: string, approved: unknown) {
    requireApproval(s, approved);
    const r = this.row(id);
    if (["sending", "sent", "review"].includes(r.stage)) return this.view(r);
    const o = r.order_id ? this.store.get(r.order_id) : undefined,
      q = r.native_quote ? JSON.parse(r.native_quote) : null;
    if (
      !o ||
      o.state !== "awaiting_payment" ||
      this.store.totals(o.id).received > 0n ||
      r.stage !== "quoted" ||
      r.quote_session !== s.id ||
      !q ||
      q.id !== quoteId ||
      q.expires <= Date.now()
    )
      throw new ApiError(409, "Fresh exact payment approval is required.");
    await this.base(JSON.parse(o.intent).chainId).validate(JSON.parse(o.intent));
    if (
      this.store.db
        .prepare(
          "UPDATE purchase_requests SET stage='sending' WHERE id=? AND stage='quoted'",
        )
        .run(id).changes !== 1
    )
      throw new ApiError(409, "Payment already started.");
    void (async () => {
      try {
        if (q.expires <= Date.now()) throw Error("fee_expired");
        const paid = await this.native<{ txid: string }>(
          [
            "send",
            "--request-id",
            r.send_request,
            "--account",
            this.manifest.zcash.payer.account,
            "--address",
            o.address,
            "--zatoshis",
            JSON.parse(o.intent).zatoshis,
            "--max-fee-zatoshis",
            q.feeZatoshis,
            "--allow-testnet-broadcast",
          ],
          q.expires,
        );
        this.store.db
          .prepare(
            "UPDATE purchase_requests SET payment_tx=?,stage='sent' WHERE id=?",
          )
          .run(paid.txid, id);
      } catch {
        this.store.stage(id, "review");
      }
    })();
    return this.view(this.row(id));
  }
  async reconcile(s: Session, id: string) {
    requireApproval(s, true);
    const r = this.row(id);
    if (r.stage === "review" && !r.order_id) {
      const path = resolve(this.approvalDir, `${id}.signed.json`);
      if (existsSync(path)) await this.attach(r, readJson(path));
    } else if (
      r.stage === "review" &&
      r.order_id &&
      existsSync(`.secrets/user/zcash/request-${r.send_request}.json`)
    ) {
      const p = await this.native<{ txid: string; status: string }>([
        "reconcile-send",
        "--request-id",
        r.send_request,
      ]);
      this.store.db
        .prepare("UPDATE purchase_requests SET payment_tx=?,stage=? WHERE id=?")
        .run(
          p.txid,
          p.status === "known-to-server-requires-wallet-confirmation"
            ? "sent"
            : "review",
          id,
        );
    }
    return this.view(this.row(id));
  }
  recover(id: string, reason: string) {
    this.store.atomic(() => {
      this.store.recover(id, reason, {}, now());
      this.store.transition(id, "recovery", now());
    });
  }
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + 60000;
    for (;;) {
      try {
        return await locked(this.lockPath, fn);
      } catch (e: any) {
        if (
          e.code !== "EEXIST" ||
          e.path !== this.lockPath ||
          Date.now() >= deadline
        )
          throw e;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
  async tick() {
    if (this.busy || !this.available() || !this.store.rows().length) return;
    // Draft-only quotes need no merchant scan or global execution lock.
    if (!this.store.all().length) {
      for (const r of this.store.rows())
        if (JSON.parse(r.intent).expiry <= now()) this.store.release(r.id);
      return;
    }
    this.busy = true;
    try {
      await locked(this.lockPath, async () => {
        const snapshot = await this.scanner.observe();
        this.store.observe(snapshot, now());
        for (const r of this.store.rows()) {
          const i = JSON.parse(r.intent) as UnsignedPurchase,
            o = r.order_id ? this.store.get(r.order_id) : undefined;
          if (
            i.expiry <= now() &&
            (!o || (!o.tx_hash && o.state === "expired"))
          )
            this.store.release(r.id);
          if (!o) continue;
          if (o.tx_hash) {
            try {
              const receipt = await this.base(i.chainId).receipt(o);
              if (receipt.status === "success") {
                this.store.db
                  .prepare(
                    "UPDATE recoveries SET status='resolved_by_receipt' WHERE order_id=? AND reason='broadcast_confirmation_unknown'",
                  )
                  .run(o.id);
                if (o.state !== "settled")
                  this.store.settled(o.id, receipt, now());
                this.store.release(r.id);
              } else if (receipt.status === "reverted") {
                this.store.failed(o.id, now());
                this.store.release(r.id);
              } else if (o.state === "settled") {
                this.recover(o.id, "base_reorganization_after_completion");
              } else if (now() >= i.expiry) {
                this.recover(o.id, "broadcast_confirmation_unknown");
              }
            } catch {
              this.recover(o.id, this.receiptUncertainReason);
            }
            continue;
          }
        }
        const r = this.store
          .rows()
          .find(
            (r) =>
              r.order_id &&
              ["sent", "sending"].includes(r.stage) &&
              this.store.eligible(this.store.get(r.order_id)!, now()),
          );
        if (!r) return;
        const o = this.store.get(r.order_id!)!;
        const chainId = JSON.parse(o.intent).chainId as number;
        if (this.store.all().some(x => JSON.parse(x.intent).chainId === chainId && x.tx_hash && !["settled", "failed"].includes(x.state))) return;
        if (chainId === 84532) {
          const old = new Store(this.legacyPath);
          try { if (old.all().some(x => x.tx_hash && ["prepared", "submitted", "recovery"].includes(x.state))) return; }
          finally { old.close(); }
        }
        try {
          const b = this.base(chainId);
          const balance = await b.public.getBalance({
            address: b.account.address,
            blockTag: "pending",
          });
          if (balance < this.store.reserved(chainId))
            throw Error("insufficient_provider_liquidity");
          const signed = await b.prepare(o);
          this.store.prepared(o.id, signed.raw, signed.hash, now());
          this.store.event(
            o.id,
            "broadcast_attempt",
            { hash: signed.hash },
            now(),
          );
          try {
            const hash = await b.broadcast(signed.raw);
            if (hash !== signed.hash) throw Error("hash_mismatch");
            this.store.submitted(o.id, now());
          } catch {
            this.recover(o.id, "broadcast_confirmation_unknown");
          }
        } catch (e) {
          const allowed = [
            "listing_sold",
            "listing_cancelled",
            "listing_expired",
            "listing_changed",
            "seller_ownership_changed",
            "seller_approval_revoked",
            "insufficient_provider_liquidity",
            "gas_budget_exceeded",
            "already_consumed_reconcile",
            "slippage_exceeded", "excessive_price_impact", "quote_reference_reorganization", "pool_reserves_or_token_behavior", "contract_code_mismatch",
          ];
          this.recover(
            o.id,
            e instanceof Error && allowed.includes(e.message)
              ? e.message
              : "gas_estimation_or_rpc_failure",
          );
        }
      });
    } catch {
      /* Lock contention or scanner/RPC failure cannot authorize a purchase. */
    } finally {
      this.busy = false;
    }
  }
}
