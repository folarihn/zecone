import {
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  type Account,
  type Address,
  type Hex,
} from "viem";
import type { EvmAdapter } from "./adapter.ts";
import type { Order } from "../execution/store.ts";
import type { Executor, Result } from "../execution/worker.ts";
import {
  validateTransfer,
  type EvmTransferIntent,
  type TransferPolicy,
} from "../settlement/transfers.ts";
export const erc20Abi = parseAbi([
  "function transfer(address to,uint256 amount) returns(bool)",
  "function balanceOf(address) view returns(uint256)",
  "function decimals() view returns(uint8)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
export type TransferCall = {
  to: Address;
  data: Hex;
  value: bigint;
};
export function transferCall(intent: EvmTransferIntent): TransferCall {
  if (intent.asset.kind === "native")
    return { to: intent.recipient, data: "0x", value: BigInt(intent.amount) };
  return {
    to: intent.asset.address,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [intent.recipient, BigInt(intent.amount)],
    }),
    value: 0n,
  };
}
export type TransferQuote = {
  chainId: number;
  block: string;
  relayer: Address;
  recipient: Address;
  asset: EvmTransferIntent["asset"];
  amount: string;
  call: { to: Address; data: Hex; value: string };
  calldataHash: Hex;
  gas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  feeCapWei: string;
  balance: string;
  simulatedAt: number;
  expires: number;
};
// Read-only. The adapter holds no key and performs only chain reads and eth_call.
export async function quoteTransfer(
  adapter: EvmAdapter,
  intent: EvmTransferIntent,
  relayer: Address,
  policy?: TransferPolicy,
  now = Math.floor(Date.now() / 1000),
): Promise<TransferQuote> {
  validateTransfer(intent, policy, now);
  if (getAddress(intent.relayer) !== getAddress(relayer))
    throw Error("RELAYER_MISMATCH");
  const head = await adapter.health();
  const call = transferCall(intent);
  if (intent.asset.kind === "ERC20") {
    const code = await adapter.client.getBytecode({
      address: intent.asset.address,
    });
    if (!code || code === "0x") throw Error("TOKEN_NOT_DEPLOYED");
    const decimals = await adapter.client.readContract({
      address: intent.asset.address,
      abi: erc20Abi,
      functionName: "decimals",
    });
    if (decimals !== intent.asset.decimals) throw Error("TOKEN_DECIMALS");
  }
  const prepared = await adapter.prepare(
    { account: relayer, ...call },
    BigInt(intent.feeCapWei),
  );
  if (prepared.feeCap > BigInt(intent.feeCapWei))
    throw Error("GAS_BUDGET_EXCEEDED");
  const balance =
    intent.asset.kind === "native"
      ? await adapter.client.getBalance({ address: relayer })
      : await adapter.client.readContract({
          address: intent.asset.address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [relayer],
        });
  if (
    balance <
    BigInt(intent.amount) +
      (intent.asset.kind === "native" ? prepared.feeCap : 0n)
  )
    throw Error("INSUFFICIENT_RELAYER_LIQUIDITY");
  return {
    chainId: intent.chainId,
    block: head.block,
    relayer,
    recipient: intent.recipient,
    asset: intent.asset,
    amount: intent.amount,
    call: { ...call, value: call.value.toString() },
    calldataHash: keccak256(call.data),
    gas: prepared.gas.toString(),
    maxFeePerGas: prepared.maxFeePerGas.toString(),
    maxPriorityFeePerGas: prepared.maxPriorityFeePerGas.toString(),
    feeCapWei: prepared.feeCap.toString(),
    balance: balance.toString(),
    simulatedAt: now,
    expires: now + 90,
  };
}
// Signing is injected explicitly; this module never loads a key file.
export class EvmTransferExecutor implements Executor {
  constructor(
    readonly adapter: EvmAdapter,
    readonly account: Account,
    readonly confirmations = 3,
    readonly now = () => Math.floor(Date.now() / 1000),
  ) {}
  private intent(order: Order, receiptOnly = false) {
    const i = JSON.parse(order.intent) as EvmTransferIntent;
    if (
      i.family !== "evm" ||
      i.chainId !== this.adapter.chainId ||
      getAddress(i.relayer) !== getAddress(this.account.address)
    )
      throw Error("TRANSFER_INTENT_MISMATCH");
    validateTransfer(
      i,
      undefined,
      receiptOnly ? Math.min(this.now(), i.expiry - 1) : this.now(),
    );
    return i;
  }
  async prepare(order: Order) {
    const i = this.intent(order),
      quote = await quoteTransfer(
        this.adapter,
        i,
        this.account.address,
        undefined,
        this.now(),
      );
    if (BigInt(quote.feeCapWei) > BigInt(i.feeCapWei))
      throw Error("GAS_BUDGET_EXCEEDED");
    const nonce = await this.adapter.client.getTransactionCount({
      address: this.account.address,
      blockTag: "pending",
    });
    if (i.asset.kind === "native") {
      const code = await this.adapter.client.getBytecode({
        address: i.recipient,
      });
      if (code && code !== "0x") throw Error("EOA_RECIPIENT_REQUIRED");
    }
    if (quote.expires <= this.now()) throw Error("QUOTE_EXPIRED");
    if (!this.account.signTransaction) throw Error("LOCAL_SIGNER_REQUIRED");
    const raw = await this.account.signTransaction({
      type: "eip1559",
      chainId: this.adapter.chainId,
      to: quote.call.to,
      data: quote.call.data,
      value: BigInt(quote.call.value),
      nonce,
      gas: BigInt(quote.gas),
      maxFeePerGas: BigInt(quote.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(quote.maxPriorityFeePerGas),
    });
    const tx = parseTransaction(raw);
    if (
      tx.chainId !== this.adapter.chainId ||
      tx.type !== "eip1559" ||
      !tx.to ||
      getAddress(tx.to) !== getAddress(quote.call.to) ||
      (tx.data ?? "0x").toLowerCase() !== quote.call.data.toLowerCase() ||
      tx.value !== BigInt(quote.call.value) ||
      tx.nonce !== nonce ||
      tx.gas !== BigInt(quote.gas) ||
      tx.maxFeePerGas !== BigInt(quote.maxFeePerGas) ||
      tx.maxPriorityFeePerGas !== BigInt(quote.maxPriorityFeePerGas) ||
      (tx.accessList?.length ?? 0) !== 0 ||
      getAddress(
        await recoverTransactionAddress({
          serializedTransaction: raw as `0x02${string}`,
        }),
      ) !== getAddress(this.account.address)
    )
      throw Error("SIGNED_TRANSFER_POLICY_MISMATCH");
    return { raw, hash: keccak256(raw) };
  }
  async broadcast(raw: Hex) {
    if (parseTransaction(raw).chainId !== this.adapter.chainId)
      throw Error("SIGNED_TRANSACTION_WRONG_CHAIN");
    return this.adapter.submit(raw);
  }
  async receipt(order: Order): Promise<Result> {
    const receipt = await this.adapter.receipt(order.tx_hash!);
    if (!receipt) return { status: "pending" };
    if (receipt.status !== "success") return { status: "reverted" };
    const i = this.intent(order, true),
      call = transferCall(i),
      tx = await this.adapter.client.getTransaction({ hash: order.tx_hash! });
    if (
      getAddress(tx.from) !== getAddress(this.account.address) ||
      getAddress(tx.to!) !== getAddress(call.to) ||
      tx.value !== call.value ||
      tx.input.toLowerCase() !== call.data.toLowerCase()
    )
      throw Error("TRANSFER_RECEIPT_MISMATCH");
    if (i.asset.kind === "ERC20") {
      const token = i.asset.address;
      const transfers = receipt.logs
        .filter((log) => getAddress(log.address) === getAddress(token))
        .flatMap((log) => {
          try {
            const event = decodeEventLog({
              abi: erc20Abi,
              data: log.data,
              topics: log.topics,
            });
            return event.eventName === "Transfer"
              ? [event.args as { from: Address; to: Address; value: bigint }]
              : [];
          } catch {
            return [];
          }
        });
      if (
        transfers.length !== 1 ||
        getAddress(transfers[0].from) !== getAddress(this.account.address) ||
        getAddress(transfers[0].to) !== getAddress(i.recipient) ||
        transfers[0].value !== BigInt(i.amount)
      )
        throw Error("TOKEN_TRANSFER_RECEIPT_MISMATCH");
    }
    return {
      status: "success",
      hash: receipt.transactionHash,
      block: receipt.blockNumber.toString(),
      recipient: i.recipient,
      ...(i.asset.kind === "ERC20"
        ? { token: i.asset.address, amountOut: i.amount }
        : { amountOut: i.amount }),
    };
  }
}
