import {
  getAddress,
  keccak256,
  recoverTypedDataAddress,
  hashDomain,
  encodeFunctionData,
  decodeEventLog,
  parseTransaction,
  TransactionReceiptNotFoundError,
  type Hex,
} from "viem";
import { Base } from "../execution/base.ts";
import { network } from "../evm/networks.ts";
import { client } from "../swaps/adapter.ts";
import { nftAbi } from "../marketplace/purchase.ts";
import type { Order } from "../execution/store.ts";
import type { Result } from "../execution/worker.ts";
import {
  CHAIN,
  PROTOCOL,
  PROTOCOL_CODE,
  seaportAbi,
  executorAbi,
  components,
  advanced,
  orderTyped,
  listingTerms,
  fulfillment,
  eq,
  signature,
  typed,
  type SeaportConfig,
  type Listing,
  type SeaportIntent,
} from "./protocol.ts";
export async function protocolCheck(
  c: SeaportConfig,
  p = client(),
  blockNumber?: bigint,
) {
  if (
    c.chainId !== CHAIN ||
    c.protocolVersion !== "1.6" ||
    !eq(c.protocol, PROTOCOL) ||
    (await p.getChainId()) !== CHAIN
  )
    throw Error("invalid_protocol");
  const block = await p.getBlock(
    blockNumber === undefined ? {} : { blockNumber },
  );
  if (
    !block.hash ||
    (blockNumber === undefined &&
      Date.now() / 1000 - Number(block.timestamp) > 300)
  )
    throw Error("stale_chain");
  for (const address of [PROTOCOL, c.nft, c.executor]) {
    const code = await p.getBytecode({ address, blockNumber: block.number });
    const expected = eq(address, PROTOCOL)
      ? PROTOCOL_CODE
      : c.codeHashes[address];
    if (!code || !expected || keccak256(code) !== expected)
      throw Error("contract_code_mismatch");
  }
  const info = (await p.readContract({
    address: PROTOCOL,
    abi: seaportAbi,
    functionName: "information",
    blockNumber: block.number,
  })) as readonly [string, Hex, string];
  const domain = hashDomain({
    domain: {
      name: "Seaport",
      version: "1.6",
      chainId: BigInt(CHAIN),
      verifyingContract: PROTOCOL,
    },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
    },
  });
  if (
    info[0] !== "1.6" ||
    info[1] !== domain ||
    !eq(info[2], "0x00000000F9490004C11Cef243f5400493c00Ad63")
  )
    throw Error("invalid_protocol_domain");
  for (const [functionName, value] of [
    ["relayer", c.provider],
    ["nft", c.nft],
    ["seller", c.seller],
    ["feeRecipient", c.feeRecipient],
  ] as const) {
    if (
      !eq(
        await p.readContract({
          address: c.executor,
          abi: executorAbi,
          functionName,
          blockNumber: block.number,
        }),
        value,
      )
    )
      throw Error("executor_configuration_mismatch");
  }
  for (const address of [c.seller, c.feeRecipient]) {
    const code = await p.getBytecode({ address, blockNumber: block.number });
    if (code && code !== "0x")
      throw Error("contract_consideration_recipient_unsupported");
  }
  return block;
}
export async function verifyListing(
  l: Listing,
  c: SeaportConfig,
  p = client(),
  blockNumber?: bigint,
) {
  const block = await protocolCheck(c, p, blockNumber),
    amounts = listingTerms(l, c, Number(block.timestamp));
  const [hash, counter, status, owner, approved, all] = await Promise.all([
    p.readContract({
      address: PROTOCOL,
      abi: seaportAbi,
      functionName: "getOrderHash",
      args: [components(l.parameters)],
      blockNumber: block.number,
    }),
    p.readContract({
      address: PROTOCOL,
      abi: seaportAbi,
      functionName: "getCounter",
      args: [c.seller],
      blockNumber: block.number,
    }),
    p
      .readContract({
        address: PROTOCOL,
        abi: seaportAbi,
        functionName: "getOrderStatus",
        args: [l.orderHash],
        blockNumber: block.number,
      })
      .then((v) => v as readonly [boolean, boolean, bigint, bigint]),
    p.readContract({
      address: c.nft,
      abi: nftAbi,
      functionName: "ownerOf",
      args: [BigInt(amounts.tokenId)],
      blockNumber: block.number,
    }),
    p.readContract({
      address: c.nft,
      abi: nftAbi,
      functionName: "getApproved",
      args: [BigInt(amounts.tokenId)],
      blockNumber: block.number,
    }),
    p.readContract({
      address: c.nft,
      abi: nftAbi,
      functionName: "isApprovedForAll",
      args: [c.seller, PROTOCOL],
      blockNumber: block.number,
    }),
  ]);
  if (hash !== l.orderHash || counter !== BigInt(l.parameters.counter))
    throw Error("listing_changed");
  if (status[1]) throw Error("listing_cancelled");
  if (status[2] !== 0n) throw Error("listing_sold");
  if (!eq(owner, c.seller)) throw Error("seller_ownership_changed");
  if (!all && !eq(approved, PROTOCOL)) throw Error("seller_approval_revoked");
  if (
    !status[0] &&
    (l.signature === "0x" ||
      !eq(
        await recoverTypedDataAddress({
          ...orderTyped(l),
          signature: l.signature,
        }),
        c.seller,
      ))
  )
    throw Error("invalid_seller_signature");
  // Never execute API data. Rebuild the only allowed call and simulate direct delivery.
  const call = {
    account: c.provider,
    to: PROTOCOL,
    data: fulfillment(l, c.user),
    value: amounts.total,
  };
  await p.call(call);
  const gas = await p.estimateGas(call),
    fees = await p.estimateFeesPerGas(),
    n = network(CHAIN);
  const estimatedFee =
    (((gas + 200000n) * 12n) / 10n) * fees.maxFeePerGas + n.dataReserve;
  if (estimatedFee > n.gasBudget || fees.maxFeePerGas > n.maxFee)
    throw Error("gas_budget_exceeded");
  return { ...amounts, block, estimatedFee };
}
export class SeaportBase extends Base {
  constructor(
    readonly config: SeaportConfig,
    confirmations = 3,
    rpc?: string,
    keyFile?: string,
  ) {
    super(config.executor, confirmations, rpc ?? network(CHAIN).rpc, keyFile);
  }
  override async check() {
    await protocolCheck(this.config, this.public);
    if (!eq(this.account.address, this.config.provider))
      throw Error("wrong_provider");
  }
  async validate(i: SeaportIntent) {
    const id = await signature(i, this.config, Math.floor(Date.now() / 1000));
    await this.check();
    await verifyListing(i.listing, this.config, this.public);
    return id;
  }
  async simulation(i: SeaportIntent) {
    await this.validate(i);
    const call = {
      account: this.account.address,
      to: this.contract,
      value: BigInt(i.price),
      data: encodeFunctionData({
        abi: executorAbi,
        functionName: "execute",
        args: [
          typed(i).message,
          advanced(i.listing),
          BigInt(i.listing.parameters.counter),
          i.signature,
        ],
      }),
    };
    await this.public.call(call);
    const gas = ((await this.public.estimateGas(call)) * 12n) / 10n + 1n,
      fees = await this.public.estimateFeesPerGas(),
      n = network(CHAIN);
    if (
      gas > n.maxGas ||
      fees.maxFeePerGas > n.maxFee ||
      gas * fees.maxFeePerGas + n.dataReserve > BigInt(i.gasBudget)
    )
      throw Error("gas_budget_exceeded");
    if (
      (await this.public.getBalance({
        address: this.account.address,
        blockTag: "pending",
      })) <
      BigInt(i.price) + BigInt(i.gasBudget)
    )
      throw Error("insufficient_provider_liquidity");
    return { call, gas, fees };
  }
  override async prepare(o: Order) {
    const i = JSON.parse(o.intent) as SeaportIntent;
    if (
      (await signature(i, this.config, Math.floor(Date.now() / 1000))) !== o.id
    )
      throw Error("intent_identity_mismatch");
    const { call, gas, fees } = await this.simulation(i),
      nonce = await this.public.getTransactionCount({
        address: this.account.address,
        blockTag: "pending",
      });
    const raw = await this.wallet.signTransaction({
      ...call,
      gas,
      ...fees,
      nonce,
      account: this.account,
      chain: this.wallet.chain,
    });
    return { raw, hash: keccak256(raw) };
  }
  override async broadcast(raw: Hex) {
    if (parseTransaction(raw).chainId !== CHAIN) throw Error("wrong_chain");
    return super.broadcast(raw);
  }
  override async receipt(o: Order): Promise<Result> {
    await this.chain();
    let r;
    try {
      r = await this.public.getTransactionReceipt({ hash: o.tx_hash! });
    } catch (e) {
      if (e instanceof TransactionReceiptNotFoundError)
        return { status: "pending" };
      throw e;
    }
    if (
      (await this.public.getBlockNumber()) - r.blockNumber + 1n <
        BigInt(this.confirmations) ||
      (await this.public.getBlock({ blockNumber: r.blockNumber })).hash !==
        r.blockHash
    )
      return { status: "pending" };
    if (r.status !== "success") return { status: "reverted" };
    const i = JSON.parse(o.intent) as SeaportIntent,
      c = this.config;
    await protocolCheck(c, this.public, r.blockNumber);
    const events = (address: string, abi: any, name: string) =>
      r.logs
        .filter((l) => eq(l.address, address))
        .flatMap((l) => {
          try {
            const e = decodeEventLog({
              abi,
              data: l.data,
              topics: l.topics,
            }) as { eventName: string; args: any };
            return e.eventName === name ? [e.args] : [];
          } catch {
            return [];
          }
        });
    const ex = events(c.executor, executorAbi, "SeaportPurchased"),
      se = events(PROTOCOL, seaportAbi, "OrderFulfilled"),
      tr = events(c.nft, nftAbi, "Transfer"),
      tx = await this.public.getTransaction({ hash: o.tx_hash! });
    if (
      ex.length !== 1 ||
      se.length !== 1 ||
      tr.filter(
        (t) =>
          eq(t.from, i.seller) &&
          eq(t.to, i.recipient) &&
          t.tokenId === BigInt(i.tokenId),
      ).length !== 1 ||
      ex[0].digest !== o.id ||
      ex[0].seaportOrderHash !== i.listing.orderHash ||
      !eq(ex[0].recipient, i.recipient) ||
      !eq(ex[0].nft, i.nft) ||
      ex[0].tokenId !== BigInt(i.tokenId) ||
      !eq(ex[0].seller, i.seller) ||
      ex[0].sellerAmount !==
        BigInt(i.listing.parameters.consideration[0].startAmount) ||
      ex[0].feeAmount !== BigInt(i.feeAmount) ||
      !eq(ex[0].feeRecipient, c.feeRecipient) ||
      se[0].orderHash !== i.listing.orderHash ||
      !eq(se[0].offerer, i.seller) ||
      !eq(se[0].recipient, i.recipient) ||
      se[0].offer.length !== 1 ||
      se[0].consideration.length !==
        i.listing.parameters.consideration.length ||
      !eq(tx.from, c.provider) ||
      !eq(tx.to!, c.executor) ||
      tx.value !== BigInt(i.price) ||
      tx.input !==
        encodeFunctionData({
          abi: executorAbi,
          functionName: "execute",
          args: [
            typed(i).message,
            advanced(i.listing),
            BigInt(i.listing.parameters.counter),
            i.signature,
          ],
        })
    )
      throw Error("seaport_receipt_mismatch");
    const item = se[0].offer[0];
    if (
      item.itemType !== 2 ||
      !eq(item.token, i.nft) ||
      item.identifier !== BigInt(i.tokenId) ||
      item.amount !== 1n
    )
      throw Error("seaport_receipt_mismatch");
    se[0].consideration.forEach((x: any, n: number) => {
      const a = i.listing.parameters.consideration[n];
      if (
        x.itemType !== 0 ||
        !eq(x.token, a.token) ||
        x.identifier !== 0n ||
        x.amount !== BigInt(a.startAmount) ||
        !eq(x.recipient, a.recipient)
      )
        throw Error("seaport_consideration_mismatch");
    });
    const [consumed, status, owner] = await Promise.all([
      this.public.readContract({
        address: c.executor,
        abi: executorAbi,
        functionName: "consumed",
        args: [o.id],
        blockNumber: r.blockNumber,
      }),
      this.public
        .readContract({
          address: PROTOCOL,
          abi: seaportAbi,
          functionName: "getOrderStatus",
          args: [i.listing.orderHash],
          blockNumber: r.blockNumber,
        })
        .then((v) => v as readonly [boolean, boolean, bigint, bigint]),
      this.public.readContract({
        address: c.nft,
        abi: nftAbi,
        functionName: "ownerOf",
        args: [BigInt(i.tokenId)],
        blockNumber: r.blockNumber,
      }),
    ]);
    if (
      !consumed ||
      status[2] !== 1n ||
      status[3] !== 1n ||
      !eq(owner, i.recipient)
    )
      throw Error("seaport_delivery_mismatch");
    return {
      status: "success",
      hash: r.transactionHash,
      block: r.blockNumber.toString(),
      recipient: i.recipient,
      tokenId: i.tokenId,
    };
  }
}
