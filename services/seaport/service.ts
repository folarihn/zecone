import { randomUUID, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { keccak256, toHex } from "viem";
import { Purchases } from "../marketplace/service.ts";
import { PurchaseJournal, type PurchaseRow } from "../marketplace/journal.ts";
import { readJson } from "../execution/io.ts";
import { requireApproval } from "../wallet/engine.ts";
import { ApiError, type Session } from "../wallet/security.ts";
import { SeaportBase, verifyListing } from "./adapter.ts";
import {
  CHAIN,
  SOURCE,
  ADAPTER,
  BUDGET,
  zecCost,
  terms,
  signature,
  type SeaportConfig,
  type SeaportIntent,
  type UnsignedSeaport,
  type Listing,
} from "./protocol.ts";
export const CONFIG = ".state/seaport-84532-confirmed.json",
  LISTING = ".state/seaport-controlled-listing.json";
export class SeaportJournal extends PurchaseJournal {
  constructor(path = ".state/purchases.sqlite") {
    super(path);
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS one_active_seaport_order ON purchase_requests(json_extract(intent,'$.chainId'),json_extract(intent,'$.listing.protocol'),json_extract(intent,'$.listing.orderHash')) WHERE reserved!='0' AND json_extract(intent,'$.kind')='seaport'",
    );
  }
  override rows() {
    return this.db
      .prepare(
        "SELECT * FROM purchase_requests WHERE json_extract(intent,'$.kind')='seaport' ORDER BY created DESC",
      )
      .all() as PurchaseRow[];
  }
}
export class SeaportPurchases extends Purchases {
  override approvalDir = ".state/seaport-approvals";
  override signerScript = "scripts/local-seaport-sign.ts";
  override receiptUncertainReason = "seaport_receipt_uncertain";
  constructor(
    store = new SeaportJournal(),
    manifest?: Purchases["manifest"],
    scanner?: Purchases["scanner"],
  ) {
    super(store, manifest, scanner);
  }
  override available() {
    return existsSync(CONFIG) && existsSync(LISTING);
  }
  configuration() {
    return readJson<SeaportConfig>(CONFIG);
  }
  listing() {
    return readJson<Listing>(LISTING);
  }
  override base(chainId = CHAIN) {
    if (chainId !== CHAIN) throw Error("unsupported_seaport_chain");
    return new SeaportBase(this.configuration());
  }
  override validateTerms(i: UnsignedSeaport) {
    return terms(i, this.configuration(), Math.floor(Date.now() / 1000));
  }
  override validateSigned(i: SeaportIntent) {
    return signature(i, this.configuration(), Math.floor(Date.now() / 1000));
  }
  override row(id: string) {
    const r = super.row(id);
    if (JSON.parse(r.intent).kind !== "seaport")
      throw new ApiError(404, "Seaport purchase not found");
    return r;
  }
  override async approve(s: Session, id: string) {
    this.row(id);
    return super.approve(s, id);
  }
  async quote(s: Session, input: { orderHash?: unknown; chainId?: unknown }) {
    requireApproval(s, true);
    const c = this.configuration(),
      listing = this.listing();
    if (input.chainId !== CHAIN || input.orderHash !== listing.orderHash)
      throw new ApiError(
        400,
        "Only the configured Base Sepolia Seaport listing is supported.",
      );
    const b = this.base(),
      q = await verifyListing(listing, c, b.public),
      at = Math.floor(Date.now() / 1000),
      expiry = Math.min(at + 3600, Number(listing.parameters.endTime) - 60);
    if (expiry < at + 1800)
      throw new ApiError(
        409,
        "Listing expires too soon for shielded confirmations.",
      );
    const id = randomUUID(),
      i: UnsignedSeaport = {
        kind: "seaport",
        version: 1,
        chainId: CHAIN,
        contract: c.executor,
        orderId: toHex(randomBytes(32)),
        nonce: toHex(randomBytes(32)),
        sourceNetwork: SOURCE,
        adapter: ADAPTER,
        provider: c.provider,
        recipient: c.user,
        price: q.total.toString(),
        gasBudget: BUDGET.toString(),
        zatoshis: zecCost(q.total).toString(),
        expiry,
        refundHash: keccak256(toHex(this.manifest.zcash.payer.address)),
        listing,
        nft: c.nft,
        tokenId: q.tokenId,
        seller: c.seller,
        feeRecipient: c.feeRecipient,
        feeAmount: q.fee,
      };
    this.validateTerms(i);
    await this.withLock(async () =>
      this.store.reserve(
        id,
        "http://127.0.0.1:3210",
        s.id,
        i,
        this.manifest.zcash.payer.address,
        randomUUID(),
        await b.public.getBalance({ address: c.provider, blockTag: "pending" }),
        at,
      ),
    );
    this.store.event(
      i.orderId,
      "seaport_quote",
      {
        referenceBlock: q.block.number.toString(),
        referenceHash: q.block.hash,
        estimatedFee: q.estimatedFee.toString(),
      },
      at,
    );
    return this.view(this.row(id));
  }
  override view(r: PurchaseRow) {
    const base = super.view(r),
      i = JSON.parse(r.intent) as SeaportIntent,
      a = this.store.db
        .prepare(
          "SELECT detail FROM audit WHERE order_id=? AND event='seaport_quote' ORDER BY seq LIMIT 1",
        )
        .get(i.orderId) as { detail: string } | undefined;
    return {
      ...base,
      source: i.listing.source,
      protocol: i.listing.protocol,
      protocolVersion: i.listing.protocolVersion,
      orderHash: i.listing.orderHash,
      seller: i.seller,
      sellerAmount: i.listing.parameters.consideration[0].startAmount,
      feeRecipient: i.feeRecipient,
      feeAmount: i.feeAmount,
      listingExpiry: i.listing.parameters.endTime,
      ...(a ? JSON.parse(a.detail) : {}),
      trust:
        "Controlled Seaport test listing, not an OpenSea API listing. Simulated rate: 1 TAZ = 0.02 test ETH; fixed gas reserve included. Listing availability can change. Public NFT ownership and provider correlation; manual recovery only.",
    };
  }
  override async fee(s: Session, id: string) {
    requireApproval(s, true);
    const r = this.row(id);
    if (r.order_id)
      await this.base().simulation(
        JSON.parse(this.store.get(r.order_id)!.intent),
      );
    return super.fee(s, id);
  }
  override async pay(
    s: Session,
    id: string,
    quoteId: string,
    approved: unknown,
  ) {
    requireApproval(s, approved);
    const r = this.row(id);
    if (r.stage === "quoted" && r.order_id)
      await this.base().simulation(
        JSON.parse(this.store.get(r.order_id)!.intent),
      );
    return super.pay(s, id, quoteId, approved);
  }
  async catalog() {
    if (!this.available())
      return {
        available: false,
        listings: [],
        apiStatus:
          "OpenSea testnet discovery unavailable; controlled listing not configured.",
      };
    const c = this.configuration(),
      l = this.listing();
    await this.base().check();
    let available = true;
    try {
      await verifyListing(l, c, this.base().public);
    } catch {
      available = false;
    }
    return {
      available: true,
      apiStatus:
        "Controlled Seaport listing; OpenSea API testnet discovery unavailable.",
      listings: [
        {
          orderHash: l.orderHash,
          source: l.source,
          chainId: CHAIN,
          nft: c.nft,
          tokenId: l.parameters.offer[0].identifierOrCriteria,
          seller: c.seller,
          recipient: c.user,
          protocol: l.protocol,
          protocolVersion: "1.6",
          price: l.parameters.consideration
            .reduce((n, x) => n + BigInt(x.startAmount), 0n)
            .toString(),
          feeAmount: l.parameters.consideration[1]?.startAmount ?? "0",
          feeRecipient: c.feeRecipient,
          expiry: l.parameters.endTime,
          available,
        },
      ],
    };
  }
}
