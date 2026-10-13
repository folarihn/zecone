import { createPublicClient, http, parseTransaction, type Address, type Hex, TransactionReceiptNotFoundError } from "viem";
import { chainFor, network } from "./networks.ts";

// No keys in this interface. Signing remains a separate local approved operation.
export class EvmAdapter {
  readonly policy;
  readonly client;
  constructor(readonly chainId: number) {
    this.policy = network(chainId);
    this.client = createPublicClient({ chain: chainFor(chainId), transport: http(this.policy.rpc, { timeout: 20000, retryCount: 1 }) });
  }
  async health() {
    if (await this.client.getChainId() !== this.chainId) throw Error("rpc_chain_mismatch");
    const block = await this.client.getBlock();
    if (!block.hash || /^0x0+$/.test(block.hash) || Number(block.timestamp) < Date.now()/1000 - 300 || Number(block.timestamp) > Date.now()/1000 + 30) throw Error("stale_rpc_head");
    return { chainId: this.chainId, block: block.number.toString(), hash: block.hash };
  }
  async prepare(call: { account: Address; to: Address; data: Hex; value: bigint }, budget = this.policy.gasBudget) {
    await this.health();
    await this.client.call(call);
    const [estimated, fees, nonce] = await Promise.all([this.client.estimateGas(call), this.client.estimateFeesPerGas(), this.client.getTransactionCount({ address: call.account, blockTag: "pending" })]);
    const gas = estimated * 12n / 10n + 1n;
    const feeCap = gas * fees.maxFeePerGas + this.policy.dataReserve;
    if (gas > this.policy.maxGas || fees.maxFeePerGas > this.policy.maxFee || feeCap > budget) throw Error("gas_budget_exceeded");
    return { nonce, gas, estimatedGas: estimated, ...fees, feeCap };
  }
  async submit(raw: Hex) {
    await this.health();
    if (parseTransaction(raw).chainId !== this.chainId) throw Error("signed_transaction_wrong_chain");
    return this.client.sendRawTransaction({ serializedTransaction: raw });
  }
  async receipt(hash: Hex) {
    await this.health();
    let r;
    try { r = await this.client.getTransactionReceipt({ hash }); }
    catch (e) { if (e instanceof TransactionReceiptNotFoundError) return null; throw e; }
    const head = await this.client.getBlockNumber();
    if (/^0x0+$/.test(r.blockHash) || head - r.blockNumber + 1n < BigInt(this.policy.confirmations)) return null;
    if ((await this.client.getBlock({ blockNumber: r.blockNumber })).hash !== r.blockHash) throw Error("receipt_reorganization");
    return r;
  }
}
export class BaseSepoliaAdapter extends EvmAdapter { constructor() { super(84532); } }
export class EthereumSepoliaAdapter extends EvmAdapter { constructor() { super(11155111); } }
export class RobinhoodTestnetAdapter extends EvmAdapter { constructor() { super(46630); } }
export function adapterFor(id: number): EvmAdapter {
  switch(network(id).id) { case 84532: return new BaseSepoliaAdapter(); case 11155111: return new EthereumSepoliaAdapter(); case 46630: return new RobinhoodTestnetAdapter(); }
}
