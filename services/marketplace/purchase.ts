import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  keccak256,
  parseAbi,
  recoverTypedDataAddress,
  decodeEventLog,
  toHex,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { Base } from "../execution/base.ts";
import type { Intent } from "../execution/intent.ts";
import type { Order } from "../execution/store.ts";
import type { Result } from "../execution/worker.ts";
export const RATE = 20000000000000000n,
  GAS_BUDGET = 100000000000000n,
  MAX_PRICE = 1000000000000000n,
  MAX_GAS = 600000n,
  MAX_FEE = 100000000n,
  L1_RESERVE = 40000000000000n;
export const quoteTypes = {
  PurchaseQuote: [
    { name: "orderId", type: "bytes32" },
    { name: "chainId", type: "uint256" },
    { name: "marketplace", type: "address" },
    { name: "listingId", type: "uint256" },
    { name: "nft", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "seller", type: "address" },
    { name: "recipient", type: "address" },
    { name: "price", type: "uint256" },
    { name: "gasBudget", type: "uint256" },
    { name: "zatoshis", type: "uint256" },
    { name: "rate", type: "uint256" },
    { name: "maxSlippageBps", type: "uint256" },
    { name: "expiry", type: "uint64" },
    { name: "calldataHash", type: "bytes32" },
    { name: "refundHash", type: "bytes32" },
    { name: "originHash", type: "bytes32" },
  ],
} as const;
const tuple =
  "(bytes32 orderId,uint256 chainId,address marketplace,uint256 listingId,address nft,uint256 tokenId,address seller,address recipient,uint256 price,uint256 gasBudget,uint256 zatoshis,uint256 rate,uint256 maxSlippageBps,uint64 expiry,bytes32 calldataHash,bytes32 refundHash,bytes32 originHash)";
export const executorAbi = parseAbi([
  "error Replay()",
  `function execute(${tuple} q,bytes signature) payable`,
  `function quoteId(${tuple} q) view returns(bytes32)`,
  "function relayer() view returns(address)",
  "function marketplace() view returns(address)",
  "function consumed(bytes32) view returns(bool)",
  "event PurchaseExecuted(bytes32 indexed digest,uint256 indexed listingId,address indexed recipient,address nft,uint256 tokenId,uint256 price)",
]);
export const marketAbi = parseAbi([
  "function buy(uint256 id,address recipient) payable",
  "function list(address nft,uint256 tokenId,uint256 price,uint64 expiry) returns(uint256)",
  "function cancel(uint256 id)",
  "function nextId() view returns(uint256)",
  "function sold(uint256 id) view returns(bool)",
  "function getListing(uint256 id) view returns((address nft,uint256 tokenId,address seller,uint256 price,uint64 expiry,bool active))",
  "event Purchased(uint256 indexed id,address indexed payer,address indexed recipient,address nft,uint256 tokenId,address seller,uint256 price)",
]);
export const nftAbi = parseAbi([
  "function ownerOf(uint256) view returns(address)",
  "function getApproved(uint256) view returns(address)",
  "function isApprovedForAll(address,address) view returns(bool)",
  "function setApprovalForAll(address,bool)",
  "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
]);
export type MarketConfig = {
  marketplace: Address;
  executor: Address;
  nft: Address;
  deploymentBlock?: string;
  origin: string;
};
export type PurchaseIntent = Intent & {
  kind: "purchase";
  orderId: Hex;
  chainId: 84532;
  marketplace: Address;
  listingId: string;
  nft: Address;
  tokenId: string;
  seller: Address;
  price: string;
  gasBudget: string;
  rate: string;
  maxSlippageBps: "0";
  calldataHash: Hex;
  refundHash: Hex;
  originHash: Hex;
};
export type UnsignedPurchase = Omit<PurchaseIntent, "signature">;
export const priceZatoshis = (price: bigint) =>
  ((price + GAS_BUDGET) * 100000000n + RATE - 1n) / RATE;
export function purchaseTyped(i: UnsignedPurchase) {
  return {
    domain: {
      name: "ZecOneMarketplace",
      version: "1",
      chainId: 84532,
      verifyingContract: i.contract,
    },
    types: quoteTypes,
    primaryType: "PurchaseQuote" as const,
    message: {
      orderId: i.orderId,
      chainId: BigInt(i.chainId),
      marketplace: i.marketplace,
      listingId: BigInt(i.listingId),
      nft: i.nft,
      tokenId: BigInt(i.tokenId),
      seller: i.seller,
      recipient: i.recipient,
      price: BigInt(i.price),
      gasBudget: BigInt(i.gasBudget),
      zatoshis: BigInt(i.zatoshis),
      rate: BigInt(i.rate),
      maxSlippageBps: BigInt(i.maxSlippageBps),
      expiry: BigInt(i.expiry),
      calldataHash: i.calldataHash,
      refundHash: i.refundHash,
      originHash: i.originHash,
    },
  };
}
export function terms(
  i: UnsignedPurchase,
  c: MarketConfig,
  user: Address,
  at: number,
) {
  const data = encodeFunctionData({
    abi: marketAbi,
    functionName: "buy",
    args: [BigInt(i.listingId), user],
  });
  if (
    i.kind !== "purchase" ||
    i.chainId !== 84532 ||
    getAddress(i.contract) !== getAddress(c.executor) ||
    getAddress(i.marketplace) !== getAddress(c.marketplace) ||
    getAddress(i.nft) !== getAddress(c.nft) ||
    getAddress(i.recipient) !== getAddress(user) ||
    getAddress(i.seller) === getAddress(user) ||
    i.nonce !== i.orderId ||
    !/^0x[0-9a-f]{64}$/.test(i.orderId) ||
    BigInt(i.orderId) === 0n ||
    BigInt(i.price) <= 0n ||
    BigInt(i.price) > MAX_PRICE ||
    i.gasBudget !== GAS_BUDGET.toString() ||
    i.rate !== RATE.toString() ||
    i.maxSlippageBps !== "0" ||
    i.zatoshis !== priceZatoshis(BigInt(i.price)).toString() ||
    !Number.isSafeInteger(i.expiry) ||
    i.expiry <= at ||
    i.expiry > at + 3600 ||
    i.calldataHash !== keccak256(data) ||
    i.originHash !== keccak256(toHex(c.origin)) ||
    !/^0x[0-9a-f]{64}$/.test(i.refundHash) ||
    BigInt(i.refundHash) === 0n
  )
    throw Error("invalid_purchase_terms");
  return hashTypedData(purchaseTyped(i));
}
export async function validateSignature(
  i: PurchaseIntent,
  c: MarketConfig,
  user: Address,
  at: number,
) {
  const id = terms(i, c, user, at);
  if (
    getAddress(
      await recoverTypedDataAddress({
        ...purchaseTyped(i),
        signature: i.signature,
      }),
    ) !== getAddress(user)
  )
    throw Error("unauthorized_signer");
  return id;
}
export async function inspectListing(
  client: Base["public"],
  c: MarketConfig,
  id: bigint,
  recipient: Address,
) {
  if ((await client.getChainId()) !== 84532) throw Error("wrong_chain");
  const l = await client.readContract({
    address: c.marketplace,
    abi: marketAbi,
    functionName: "getListing",
    args: [id],
  });
  if (l.seller === "0x0000000000000000000000000000000000000000")
    throw Error("unknown_listing");
  if (!l.active) {
    const sold = await client.readContract({
      address: c.marketplace,
      abi: marketAbi,
      functionName: "sold",
      args: [id],
    });
    throw Error(sold ? "listing_sold" : "listing_cancelled");
  }
  const block = await client.getBlock();
  if (BigInt(l.expiry) <= block.timestamp) throw Error("listing_expired");
  if (
    getAddress(l.nft) !== getAddress(c.nft) ||
    l.price <= 0n ||
    l.price > MAX_PRICE ||
    getAddress(recipient) === getAddress(l.seller)
  )
    throw Error("unsupported_listing");
  const [owner, approved, all] = await Promise.all([
    client.readContract({
      address: l.nft,
      abi: nftAbi,
      functionName: "ownerOf",
      args: [l.tokenId],
    }),
    client.readContract({
      address: l.nft,
      abi: nftAbi,
      functionName: "getApproved",
      args: [l.tokenId],
    }),
    client.readContract({
      address: l.nft,
      abi: nftAbi,
      functionName: "isApprovedForAll",
      args: [l.seller, c.marketplace],
    }),
  ]);
  if (getAddress(owner) !== getAddress(l.seller))
    throw Error("seller_ownership_changed");
  if (!all && getAddress(approved) !== getAddress(c.marketplace))
    throw Error("seller_approval_revoked");
  return l;
}
export async function interpret(
  client: Base["public"],
  c: MarketConfig,
  tx: Record<string, unknown>,
  user: Address,
  payer: Address = user,
) {
  if (
    Object.keys(tx).some(
      (k) => !["from", "to", "value", "data", "chainId"].includes(k),
    ) ||
    tx.chainId !== "0x14a34" ||
    typeof tx.from !== "string" ||
    getAddress(tx.from) !== getAddress(user) ||
    typeof tx.to !== "string" ||
    getAddress(tx.to) !== getAddress(c.marketplace) ||
    typeof tx.data !== "string" ||
    typeof tx.value !== "string" ||
    !/^0x[0-9a-fA-F]+$/.test(tx.value)
  )
    throw Error("unsupported_purchase_transaction");
  const call = decodeFunctionData({ abi: marketAbi, data: tx.data as Hex });
  if (call.functionName !== "buy") throw Error("unsupported_purchase_method");
  const [listingId, recipient] = call.args;
  if (
    getAddress(recipient) !== getAddress(user) ||
    encodeFunctionData({
      abi: marketAbi,
      functionName: "buy",
      args: [listingId, recipient],
    }) !== tx.data
  )
    throw Error("changed_calldata_or_recipient");
  const l = await inspectListing(client, c, listingId, user);
  if (l.price !== BigInt(tx.value)) throw Error("price_changed");
  const request = {
    account: payer,
    to: c.marketplace,
    data: tx.data as Hex,
    value: l.price,
  };
  await client.call(request);
  const estimatedGas = await client.estimateGas(request);
  return {
    listingId: listingId.toString(),
    nft: l.nft,
    tokenId: l.tokenId.toString(),
    seller: l.seller,
    price: l.price.toString(),
    listingExpiry: Number(l.expiry),
    calldataHash: keccak256(tx.data as Hex),
    estimatedGas: estimatedGas.toString(),
  };
}
export class PurchaseBase extends Base {
  constructor(
    readonly config: MarketConfig,
    confirmations = 3,
    rpc?: string,
    keyFile?: string,
  ) {
    super(config.executor, confirmations, rpc, keyFile);
  }
  override async check() {
    await this.chain();
    const [r, m, code] = await Promise.all([
      this.public.readContract({
        address: this.contract,
        abi: executorAbi,
        functionName: "relayer",
      }),
      this.public.readContract({
        address: this.contract,
        abi: executorAbi,
        functionName: "marketplace",
      }),
      this.public.getBytecode({ address: this.config.marketplace }),
    ]);
    if (
      getAddress(r) !== this.account.address ||
      getAddress(m) !== getAddress(this.config.marketplace) ||
      !code
    )
      throw Error("executor_configuration_mismatch");
  }
  async validate(i: PurchaseIntent) {
    await this.check();
    const id = await validateSignature(
      i,
      this.config,
      i.recipient,
      Math.floor(Date.now() / 1000),
    );
    if (getAddress(i.recipient) === this.account.address)
      throw Error("provider_cannot_be_recipient");
    const l = await inspectListing(
      this.public,
      this.config,
      BigInt(i.listingId),
      i.recipient,
    );
    if (
      l.price.toString() !== i.price ||
      l.tokenId.toString() !== i.tokenId ||
      getAddress(l.nft) !== getAddress(i.nft) ||
      getAddress(l.seller) !== getAddress(i.seller) ||
      Number(l.expiry) < i.expiry
    )
      throw Error("listing_changed");
    return id;
  }
  override async prepare(o: Order) {
    const i = JSON.parse(o.intent) as PurchaseIntent;
    if ((await this.validate(i)) !== o.id)
      throw Error("purchase_identity_mismatch");
    if (
      await this.public.readContract({
        address: this.contract,
        abi: executorAbi,
        functionName: "consumed",
        args: [o.id],
      })
    )
      throw Error("already_consumed_reconcile");
    const data = encodeFunctionData({
      abi: executorAbi,
      functionName: "execute",
      args: [purchaseTyped(i).message, i.signature],
    });
    const call = {
      account: this.account.address,
      to: this.contract,
      data,
      value: BigInt(i.price),
    };
    await this.public.call(call);
    const [estimate, fees, nonce] = await Promise.all([
      this.public.estimateGas(call),
      this.public.estimateFeesPerGas(),
      this.public.getTransactionCount({
        address: this.account.address,
        blockTag: "pending",
      }),
    ]);
    const gas = (estimate * 12n) / 10n + 1n;
    if (
      gas > MAX_GAS ||
      fees.maxFeePerGas > MAX_FEE ||
      gas * fees.maxFeePerGas + L1_RESERVE > GAS_BUDGET
    )
      throw Error("gas_budget_exceeded");
    const raw = await this.wallet.signTransaction({
      ...call,
      account: this.account,
      chain: this.wallet.chain,
      nonce,
      gas,
      ...fees,
    });
    return { raw, hash: keccak256(raw) };
  }
  override async receipt(o: Order): Promise<Result> {
    await this.check();
    let r;
    try {
      r = await this.public.getTransactionReceipt({ hash: o.tx_hash! });
    } catch (e) {
      if (e instanceof TransactionReceiptNotFoundError)
        return { status: "pending" };
      throw e;
    }
    const head = await this.public.getBlockNumber();
    if (
      head - r.blockNumber + 1n < BigInt(this.confirmations) ||
      (await this.public.getBlock({ blockNumber: r.blockNumber })).hash !==
        r.blockHash
    )
      return { status: "pending" };
    if (r.status === "reverted") return { status: "reverted" };
    const i = JSON.parse(o.intent) as PurchaseIntent;
    const executions = r.logs
      .filter(
        (l) =>
          getAddress(l.address) === getAddress(this.contract) &&
          l.topics[0] ===
            keccak256(
              toHex(
                "PurchaseExecuted(bytes32,uint256,address,address,uint256,uint256)",
              ),
            ),
      )
      .map(
        (l) =>
          decodeEventLog({
            abi: executorAbi,
            eventName: "PurchaseExecuted",
            data: l.data,
            topics: l.topics,
          }).args,
      );
    const purchases = r.logs
      .filter(
        (l) =>
          getAddress(l.address) === getAddress(this.config.marketplace) &&
          l.topics[0] ===
            keccak256(
              toHex(
                "Purchased(uint256,address,address,address,uint256,address,uint256)",
              ),
            ),
      )
      .map(
        (l) =>
          decodeEventLog({
            abi: marketAbi,
            eventName: "Purchased",
            data: l.data,
            topics: l.topics,
          }).args,
      );
    const [owner, consumed] = await Promise.all([
      this.public.readContract({
        address: i.nft,
        abi: nftAbi,
        functionName: "ownerOf",
        args: [BigInt(i.tokenId)],
      }),
      this.public.readContract({
        address: this.contract,
        abi: executorAbi,
        functionName: "consumed",
        args: [o.id],
      }),
    ]);
    if (
      executions.length !== 1 ||
      purchases.length !== 1 ||
      executions[0].digest !== o.id ||
      purchases[0].id.toString() !== i.listingId ||
      purchases[0].tokenId.toString() !== i.tokenId ||
      getAddress(purchases[0].nft) !== getAddress(i.nft) ||
      getAddress(purchases[0].seller) !== getAddress(i.seller) ||
      purchases[0].price.toString() !== i.price ||
      getAddress(purchases[0].recipient) !== getAddress(i.recipient) ||
      getAddress(purchases[0].payer) !== getAddress(this.contract) ||
      !consumed ||
      getAddress(owner) !== getAddress(i.recipient)
    )
      throw Error("nft_ownership_or_receipt_mismatch");
    return {
      status: "success",
      hash: r.transactionHash,
      block: r.blockNumber.toString(),
      recipient: owner,
      tokenId: i.tokenId,
    };
  }
}
