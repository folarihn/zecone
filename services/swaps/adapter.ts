import {
  createPublicClient,
  http,
  getAddress,
  keccak256,
  encodeFunctionData,
  decodeEventLog,
  parseTransaction,
  TransactionReceiptNotFoundError,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { Base } from "../execution/base.ts";
import { network } from "../evm/networks.ts";
import type { Order } from "../execution/store.ts";
import type { Result } from "../execution/worker.ts";
import {
  BUDGET,
  CHAIN,
  factoryAbi,
  routerAbi,
  tokenAbi,
  pairAbi,
  executorAbi,
  output,
  impactBps,
  signature,
  swapParams,
  swapTyped,
  type SwapConfig,
  type SwapIntent,
  type UnsignedSwap,
} from "./intent.ts";

export function client(rpc = network(CHAIN).rpc) {
  return createPublicClient({
    chain: baseSepolia,
    transport: http(rpc, { timeout: 30000, retryCount: 1 }),
  });
}
export async function inspect(
  c: SwapConfig,
  p = client(),
  blockNumber?: bigint,
) {
  if (c.chainId !== CHAIN || (await p.getChainId()) !== CHAIN)
    throw Error("wrong_chain");
  const block = await p.getBlock(
    blockNumber === undefined ? {} : { blockNumber },
  );
  if (
    !block.hash ||
    (blockNumber === undefined &&
      Date.now() / 1000 - Number(block.timestamp) > 300)
  )
    throw Error("stale_pool_state");
  for (const address of [
    c.factory,
    c.router,
    c.weth,
    c.token,
    c.pool,
    c.executor,
  ]) {
    const code = await p.getBytecode({ address, blockNumber: block.number });
    if (
      !code ||
      !c.codeHashes[address] ||
      keccak256(code) !== c.codeHashes[address]
    )
      throw Error("contract_code_mismatch");
  }
  const [
    factory,
    weth,
    pair,
    decimals,
    token0,
    token1,
    reserves,
    provider,
    router,
    token,
    pool,
  ] = await Promise.all([
    p.readContract({
      address: c.router,
      abi: routerAbi,
      functionName: "factory",
      blockNumber: block.number,
    }),
    p.readContract({
      address: c.router,
      abi: routerAbi,
      functionName: "WETH",
      blockNumber: block.number,
    }),
    p.readContract({
      address: c.factory,
      abi: factoryAbi,
      functionName: "getPair",
      args: [c.weth, c.token],
      blockNumber: block.number,
    }),
    p.readContract({
      address: c.token,
      abi: tokenAbi,
      functionName: "decimals",
      blockNumber: block.number,
    }),
    p.readContract({
      address: c.pool,
      abi: pairAbi,
      functionName: "token0",
      blockNumber: block.number,
    }),
    p.readContract({
      address: c.pool,
      abi: pairAbi,
      functionName: "token1",
      blockNumber: block.number,
    }),
    p.readContract({
      address: c.pool,
      abi: pairAbi,
      functionName: "getReserves",
      blockNumber: block.number,
    }),
    p.readContract({
      address: c.executor,
      abi: executorAbi,
      functionName: "relayer",
      blockNumber: block.number,
    }),
    p.readContract({
      address: c.executor,
      abi: executorAbi,
      functionName: "router",
      blockNumber: block.number,
    }),
    p.readContract({
      address: c.executor,
      abi: executorAbi,
      functionName: "token",
      blockNumber: block.number,
    }),
    p.readContract({
      address: c.executor,
      abi: executorAbi,
      functionName: "pool",
      blockNumber: block.number,
    }),
  ]);
  const eq = (a: unknown, b: string) => getAddress(String(a)) === getAddress(b);
  if (
    !eq(factory, c.factory) ||
    !eq(weth, c.weth) ||
    !eq(pair, c.pool) ||
    decimals !== 18 ||
    !eq(provider, c.provider) ||
    !eq(router, c.router) ||
    !eq(token, c.token) ||
    !eq(pool, c.pool) ||
    !(
      [token0, token1].some((t) => eq(t, c.weth)) &&
      [token0, token1].some((t) => eq(t, c.token))
    )
  )
    throw Error("pool_configuration_mismatch");
  const nativeFirst = eq(token0, c.weth),
    reserveIn = reserves[nativeFirst ? 0 : 1],
    reserveOut = reserves[nativeFirst ? 1 : 0];
  const [inBalance, outBalance] = await Promise.all([
    p.readContract({
      address: c.weth,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [c.pool],
      blockNumber: block.number,
    }),
    p.readContract({
      address: c.token,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [c.pool],
      blockNumber: block.number,
    }),
  ]);
  if (
    inBalance !== reserveIn ||
    outBalance !== reserveOut ||
    reserveIn <= 0n ||
    reserveOut <= 0n
  )
    throw Error("pool_reserves_or_token_behavior");
  return { block, nativeFirst, reserveIn, reserveOut };
}
export async function quoted(c: SwapConfig, amount: bigint, p = client()) {
  const state = await inspect(c, p),
    expectedOut = output(amount, state.reserveIn, state.reserveOut),
    impact = impactBps(amount, expectedOut, state.reserveIn, state.reserveOut);
  if (expectedOut <= 0n || impact > 300) throw Error("excessive_price_impact");
  const route = [c.weth, c.token] as const;
  const dex = await p.readContract({
    address: c.router,
    abi: routerAbi,
    functionName: "getAmountsOut",
    args: [amount, route],
    blockNumber: state.block.number,
  });
  if (dex[1] !== expectedOut) throw Error("router_quote_mismatch");
  const call = {
    account: c.provider,
    to: c.router,
    value: amount,
    data: encodeFunctionData({
      abi: routerAbi,
      functionName: "swapExactETHForTokens",
      args: [
        (expectedOut * 99n) / 100n,
        route,
        c.user,
        state.block.timestamp + 3600n,
      ],
    }),
  };
  await p.call(call);
  const gas = await p.estimateGas(call);
  const fees = await p.estimateFeesPerGas();
  const estimate =
    (((gas + 150000n) * 12n) / 10n) * fees.maxFeePerGas +
    network(CHAIN).dataReserve;
  if (estimate > BUDGET || fees.maxFeePerGas > network(CHAIN).maxFee)
    throw Error("gas_budget_exceeded");
  return { ...state, expectedOut, impact, estimatedFee: estimate };
}
export class SwapBase extends Base {
  constructor(
    readonly config: SwapConfig,
    confirmations = 3,
    rpc?: string,
    keyFile?: string,
  ) {
    super(config.executor, confirmations, rpc ?? network(CHAIN).rpc, keyFile);
  }
  override async check() {
    await inspect(this.config, this.public);
    if (getAddress(this.config.provider) !== this.account.address)
      throw Error("wrong_provider");
  }
  async validate(i: SwapIntent) {
    const id = await signature(i, this.config, Math.floor(Date.now() / 1000));
    await this.check();
    const reference = await inspect(
      this.config,
      this.public,
      BigInt(i.referenceBlock),
    );
    if (
      reference.block.hash !== i.referenceHash ||
      output(BigInt(i.maxNative), reference.reserveIn, reference.reserveOut) !==
        BigInt(i.expectedOut)
    )
      throw Error("quote_reference_reorganization");
    const current = await quoted(this.config, BigInt(i.maxNative), this.public);
    if (current.expectedOut < BigInt(i.minOut))
      throw Error("slippage_exceeded");
    return id;
  }
  async simulation(i: SwapIntent) {
    await this.validate(i);
    const call = {
      account: this.account.address,
      to: this.contract,
      value: BigInt(i.maxNative),
      data: encodeFunctionData({
        abi: executorAbi,
        functionName: "execute",
        args: [swapTyped(i).message, swapParams(i), i.signature],
      }),
    };
    await this.public.call(call);
    const gas = ((await this.public.estimateGas(call)) * 12n) / 10n + 1n,
      fees = await this.public.estimateFeesPerGas();
    if (
      gas > network(CHAIN).maxGas ||
      fees.maxFeePerGas > network(CHAIN).maxFee ||
      gas * fees.maxFeePerGas + network(CHAIN).dataReserve > BigInt(i.maxGas)
    )
      throw Error("gas_budget_exceeded");
    if (
      (await this.public.getBalance({
        address: this.account.address,
        blockTag: "pending",
      })) <
      BigInt(i.maxNative) + BigInt(i.maxGas)
    )
      throw Error("insufficient_provider_liquidity");
    return { call, gas, fees };
  }
  override async prepare(o: Order) {
    const i = JSON.parse(o.intent) as SwapIntent;
    if (
      (await signature(i, this.config, Math.floor(Date.now() / 1000))) !== o.id
    )
      throw Error("intent_identity_mismatch");
    const { call, gas, fees } = await this.simulation(i);
    const nonce = await this.public.getTransactionCount({
      address: this.account.address,
      blockTag: "pending",
    });
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
    const head = await this.public.getBlockNumber();
    if (
      head - r.blockNumber + 1n < BigInt(this.confirmations) ||
      (await this.public.getBlock({ blockNumber: r.blockNumber })).hash !==
        r.blockHash
    )
      return { status: "pending" };
    if (r.status !== "success") return { status: "reverted" };
    const i = JSON.parse(o.intent) as SwapIntent,
      c = this.config;
    // Runtime hashes and receipt-block balances verify delivery historically, even after later user transfers.
    const state = await inspect(c, this.public, r.blockNumber);
    const events = (address: string, abi: any, eventName: string) =>
      r.logs
        .filter((l) => getAddress(l.address) === getAddress(address))
        .flatMap((l) => {
          try {
            const e = decodeEventLog({
              abi,
              data: l.data,
              topics: l.topics,
            }) as { eventName: string; args: unknown };
            return e.eventName === eventName ? [e.args as any] : [];
          } catch {
            return [];
          }
        });
    const ex = events(c.executor, executorAbi, "SwapExecuted"),
      sw = events(c.pool, pairAbi, "Swap"),
      tr = events(c.token, tokenAbi, "Transfer"),
      sync = events(c.pool, pairAbi, "Sync");
    const tx = await this.public.getTransaction({ hash: o.tx_hash! });
    if (
      ex.length !== 1 ||
      sw.length !== 1 ||
      sync.length !== 1 ||
      ex[0].digest !== o.id ||
      getAddress(ex[0].recipient) !== getAddress(i.recipient) ||
      getAddress(ex[0].token) !== getAddress(c.token) ||
      ex[0].amountIn !== BigInt(i.maxNative) ||
      ex[0].amountOut < BigInt(i.minOut) ||
      ex[0].balanceAfter - ex[0].balanceBefore !== ex[0].amountOut ||
      getAddress(sw[0].sender) !== getAddress(c.router) ||
      getAddress(sw[0].to) !== getAddress(i.recipient) ||
      sw[0][state.nativeFirst ? "amount0In" : "amount1In"] !==
        BigInt(i.maxNative) ||
      sw[0][state.nativeFirst ? "amount1Out" : "amount0Out"] !==
        ex[0].amountOut ||
      sw[0][state.nativeFirst ? "amount1In" : "amount0In"] !== 0n ||
      sw[0][state.nativeFirst ? "amount0Out" : "amount1Out"] !== 0n ||
      tr.filter(
        (t) =>
          getAddress(t.from) === getAddress(c.pool) &&
          getAddress(t.to) === getAddress(i.recipient) &&
          t.value === ex[0].amountOut,
      ).length !== 1 ||
      getAddress(tx.from) !== getAddress(c.provider) ||
      getAddress(tx.to!) !== getAddress(c.executor) ||
      tx.value !== BigInt(i.maxNative) ||
      tx.input !==
        encodeFunctionData({
          abi: executorAbi,
          functionName: "execute",
          args: [swapTyped(i).message, swapParams(i), i.signature],
        })
    )
      throw Error("token_receipt_mismatch");
    if (
      !(await this.public.readContract({
        address: c.executor,
        abi: executorAbi,
        functionName: "consumed",
        args: [o.id],
        blockNumber: r.blockNumber,
      }))
    )
      throw Error("unconsumed_swap");
    return {
      status: "success",
      hash: r.transactionHash,
      block: r.blockNumber.toString(),
      recipient: i.recipient,
      token: i.outputToken,
      amountOut: ex[0].amountOut.toString(),
      balanceBefore: ex[0].balanceBefore.toString(),
      balanceAfter: ex[0].balanceAfter.toString(),
    };
  }
}
