import { randomUUID, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { keccak256, toHex, parseEther } from "viem";
import { Purchases } from "../marketplace/service.ts";
import { PurchaseJournal, type PurchaseRow } from "../marketplace/journal.ts";
import { readJson } from "../execution/io.ts";
import { requireApproval } from "../wallet/engine.ts";
import { type Session, ApiError } from "../wallet/security.ts";
import { SwapBase, quoted, client } from "./adapter.ts";
import {
  tokenAbi,
  CHAIN,
  ADAPTER,
  SOURCE,
  BUDGET,
  terms,
  signature,
  zecCost,
  type SwapConfig,
  type UnsignedSwap,
  type SwapIntent,
} from "./intent.ts";
export const CONFIG = ".state/swap-84532-confirmed.json";
export class SwapJournal extends PurchaseJournal {
  override rows() {
    return this.db
      .prepare(
        "SELECT * FROM purchase_requests WHERE json_extract(intent,'$.kind')='swap' ORDER BY created DESC",
      )
      .all() as PurchaseRow[];
  }
}
// Inherits exactly the existing native payment lifecycle and provider lock. No separate reservation ledger.
export class Swaps extends Purchases {
  override approvalDir = ".state/swap-approvals";
  override signerScript = "scripts/local-swap-sign.ts";
  override receiptUncertainReason = "token_receipt_uncertain";
  constructor(
    store = new SwapJournal(),
    manifest?: Purchases["manifest"],
    scanner?: Purchases["scanner"],
  ) {
    super(store, manifest, scanner);
  }
  override available() {
    return existsSync(CONFIG);
  }
  configuration() {
    return readJson<SwapConfig>(CONFIG);
  }
  override base(chainId = CHAIN) {
    if (chainId !== CHAIN) throw Error("unsupported_swap_chain");
    return new SwapBase(this.configuration());
  }
  override validateTerms(i: UnsignedSwap) {
    return terms(i, this.configuration(), Math.floor(Date.now() / 1000));
  }
  override validateSigned(i: SwapIntent) {
    return signature(i, this.configuration(), Math.floor(Date.now() / 1000));
  }
  override row(id: string) {
    const r = super.row(id);
    if (JSON.parse(r.intent).kind !== "swap")
      throw new ApiError(404, "Swap not found");
    return r;
  }
  override async approve(s: Session, id: string) {
    this.row(id);
    return super.approve(s, id);
  }
  async quote(
    s: Session,
    input: {
      chainId?: unknown;
      amount?: unknown;
      slippageBps?: unknown;
      token?: unknown;
    },
  ) {
    requireApproval(s, true);
    if (
      input.chainId !== CHAIN ||
      typeof input.amount !== "string" ||
      !/^(0|[1-9][0-9]*)\.[0-9]{1,18}$/.test(input.amount) ||
      !Number.isSafeInteger(input.slippageBps) ||
      Number(input.slippageBps) < 1 ||
      Number(input.slippageBps) > 300
    )
      throw new ApiError(
        400,
        "Use Base Sepolia, a decimal ETH input and slippage from 1 to 300 bps.",
      );
    const c = this.configuration();
    if (input.token !== c.token)
      throw new ApiError(400, "Only the configured test token is allowed.");
    const amount = parseEther(input.amount);
    if (amount <= 0n || amount > 200000000000000n)
      throw new ApiError(400, "Input must be at most 0.0002 test ETH.");
    const p = client(),
      q = await quoted(c, amount, p),
      id = randomUUID(),
      orderId = toHex(randomBytes(32));
    const i: UnsignedSwap = {
      kind: "swap",
      version: 1,
      chainId: CHAIN,
      contract: c.executor,
      orderId,
      nonce: toHex(randomBytes(32)),
      recipient: c.user,
      provider: c.provider,
      sourceNetwork: SOURCE,
      adapter: ADAPTER,
      target: c.router,
      maxNative: amount.toString(),
      price: amount.toString(),
      maxGas: BUDGET.toString(),
      gasBudget: BUDGET.toString(),
      zatoshis: zecCost(amount).toString(),
      expiry: Math.floor(Date.now() / 1000) + 3600,
      refundHash: keccak256(toHex(this.manifest.zcash.payer.address)),
      inputAsset: c.weth,
      outputToken: c.token,
      decimals: 18,
      router: c.router,
      route: [c.weth, c.token],
      expectedOut: q.expectedOut.toString(),
      minOut: (
        (q.expectedOut * BigInt(10000 - Number(input.slippageBps))) /
        10000n
      ).toString(),
      slippageBps: Number(input.slippageBps),
      referenceBlock: q.block.number.toString(),
      referenceHash: q.block.hash!,
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
        await p.getBalance({ address: c.provider, blockTag: "pending" }),
        Math.floor(Date.now() / 1000),
      ),
    );
    this.store.event(
      orderId,
      "swap_quote",
      {
        block: i.referenceBlock,
        hash: i.referenceHash,
        reserveIn: q.reserveIn.toString(),
        reserveOut: q.reserveOut.toString(),
        impactBps: q.impact,
        estimatedFee: q.estimatedFee.toString(),
      },
      Math.floor(Date.now() / 1000),
    );
    return {
      ...this.view(this.row(id)),
      intent: i,
      impactBps: q.impact,
      estimatedFee: q.estimatedFee.toString(),
    };
  }
  override view(r: PurchaseRow) {
    const base = super.view(r),
      i = JSON.parse(r.intent) as SwapIntent,
      o = r.order_id ? this.store.get(r.order_id) : undefined;
    const receipt = o
      ? (this.store.db
          .prepare(
            "SELECT detail FROM audit WHERE order_id=? AND event LIKE '%->settled' ORDER BY seq DESC LIMIT 1",
          )
          .get(o.id) as { detail: string } | undefined)
      : undefined;
    const { nft, tokenId, listingId, ownerVerified, ...common } = base;
    const audit = this.store.db
      .prepare(
        "SELECT detail FROM audit WHERE order_id=? AND event='swap_quote' ORDER BY seq LIMIT 1",
      )
      .get(i.orderId) as { detail: string } | undefined;
    const quoted = audit ? JSON.parse(audit.detail) : {};
    return {
      ...common,
      impactBps: quoted.impactBps,
      estimatedFee: quoted.estimatedFee,
      token: i.outputToken,
      symbol: "ZTEST",
      decimals: i.decimals,
      router: i.router,
      route: i.route,
      amountIn: i.maxNative,
      expectedOut: i.expectedOut,
      minOut: i.minOut,
      slippageBps: i.slippageBps,
      referenceBlock: i.referenceBlock,
      referenceHash: i.referenceHash,
      receiptVerified: base.ownerVerified,
      receipt: receipt ? JSON.parse(receipt.detail) : null,
      trust:
        "Simulated ZEC rate. Prefunded provider; actual test AMM swap. Minimum output is enforced, but execution may fail while Zcash confirms. Manual recovery only.",
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
  async assets() {
    if (!this.available())
      return {
        available: false,
        chains: [{ chainId: CHAIN, name: "Base Sepolia", supported: false }],
        tokens: [],
      };
    const c = this.configuration();
    await this.base().check();
    const balance = await client().readContract({
      address: c.token,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [c.user],
    });
    return {
      available: true,
      chainId: CHAIN,
      name: "Base Sepolia",
      tokens: [
        {
          address: c.token,
          symbol: "ZTEST",
          decimals: 18,
          balance: balance.toString(),
        },
      ],
    };
  }
}
