// EVM delivery shares the existing order, payment and execution worker. It adds
// no second journal and no generic calldata surface: only native sends and
// allowlisted ERC-20 transfers can be represented.
import { getAddress, type Address, type Hex } from "viem";
import { Store } from "../execution/store.ts";
import { executeOne, type Executor } from "../execution/worker.ts";
import { EvmAdapter } from "../evm/adapter.ts";
import { quoteTransfer, transferCall } from "../evm/transfers.ts";
import {
  DEFAULT_TRANSFER_POLICY,
  DEMO_ZATOSHIS,
  nonce,
  transferOrderId,
  transferOrderKey,
  validateTransfer,
  type Erc20Asset,
  type EvmTransferIntent,
  type TransferPolicy,
} from "./transfers.ts";
export const clock = () => Math.floor(Date.now() / 1000);
export type EvmTransferRequest = {
  profileId: string;
  requestId: string;
  recipient: Address;
  relayer: Address;
  amount: string;
  asset: EvmTransferIntent["asset"];
  feeCapWei: string;
  account: string;
  paymentAddress: string;
};
export class EvmTransferSettlement {
  constructor(
    readonly store: Store,
    readonly adapter: EvmAdapter,
    readonly now = clock,
    readonly policy: TransferPolicy = DEFAULT_TRANSFER_POLICY,
  ) {}
  private async priced(
    input: EvmTransferRequest,
    policy?: TransferPolicy,
    ttl = 7200,
  ) {
    if (
      !/^[a-f0-9]{64}$/.test(input.account) ||
      !input.paymentAddress.startsWith("utest1")
    )
      throw Error("ISOLATED_SHIELDED_PROFILE_REQUIRED");
    const p = policy ?? this.policy,
      draft = {
        family: "evm" as const,
        action:
          input.asset.kind === "native"
            ? ("EVM_NATIVE_TRANSFER" as const)
            : ("EVM_ERC20_TRANSFER" as const),
        version: 1 as const,
        chainId: this.adapter.chainId as EvmTransferIntent["chainId"],
        relayer: input.relayer,
        recipient: input.recipient,
        amount: input.amount,
        asset: input.asset,
        feeCapWei: input.feeCapWei,
        quotation: {
          block: "0",
          calldataHash: `0x${"0".repeat(64)}` as Hex,
          gas: "1",
          feeCapWei: "0",
          at: this.now(),
          expires: this.now() + 1,
        },
        zatoshis: DEMO_ZATOSHIS,
        nonce: nonce(),
        expiry: this.now() + ttl,
        pricing: "FIXED_TESTNET_DEMO_NOT_EXCHANGE_RATE" as const,
        profileId: input.profileId,
        requestId: input.requestId,
      };
    validateTransfer(draft, p, this.now());
    const quote = await quoteTransfer(
        this.adapter,
        draft,
        input.relayer,
        p,
        this.now(),
      ),
      intent: EvmTransferIntent = {
        ...draft,
        feeCapWei: quote.feeCapWei,
        quotation: {
          block: quote.block,
          calldataHash: quote.calldataHash,
          gas: quote.gas,
          feeCapWei: quote.feeCapWei,
          at: quote.simulatedAt,
          expires: quote.expires,
        },
      };
    validateTransfer(intent, p, this.now());
    return { intent, quote };
  }
  async preview(input: EvmTransferRequest, policy?: TransferPolicy) {
    const { intent, quote } = await this.priced(input, policy),
      call = transferCall(intent);
    return {
      id: transferOrderId(intent),
      intent,
      quote,
      call: { ...call, value: call.value.toString() },
      paymentAddress: input.paymentAddress,
      financialOrderCreated: false,
      executionAuthorized: false,
    };
  }
  async quote(input: EvmTransferRequest, policy?: TransferPolicy, ttl = 7200) {
    const id = transferOrderKey("evm", input.profileId, input.requestId),
      old = this.store.get(id);
    if (old) {
      const previous = JSON.parse(old.intent) as EvmTransferIntent;
      if (
        getAddress(previous.recipient) !== getAddress(input.recipient) ||
        getAddress(previous.relayer) !== getAddress(input.relayer) ||
        previous.amount !== input.amount ||
        JSON.stringify(previous.asset) !== JSON.stringify(input.asset)
      )
        throw Error("IDEMPOTENCY_CONFLICT");
      return this.view(id);
    }
    const { intent } = await this.priced(input, policy, ttl);
    this.store.create(
      id,
      intent,
      input.account,
      input.paymentAddress,
      this.now(),
    );
    return this.view(id);
  }
  intent(id: string) {
    const order = this.store.get(id);
    if (!order) throw Error("UNKNOWN_ORDER");
    const intent = JSON.parse(order.intent) as EvmTransferIntent;
    if (intent.family !== "evm" || intent.chainId !== this.adapter.chainId)
      throw Error("WRONG_NETWORK");
    validateTransfer(intent, this.policy, this.now());
    return intent;
  }
  execute(id: string, executor: Executor) {
    return executeOne(this.store, id, executor, this.now);
  }
  async reconcile(id: string, executor: Executor) {
    if (!this.store.get(id)?.tx_hash) return this.view(id);
    return executeOne(this.store, id, executor, this.now);
  }
  view(id: string) {
    const order = this.store.get(id);
    if (!order) throw Error("UNKNOWN_ORDER");
    const intent = this.intent(id),
      totals = this.store.totals(id),
      call = transferCall(intent);
    return {
      id,
      kind: "evm-transfer",
      action: intent.action,
      chainId: intent.chainId,
      recipient: intent.recipient,
      relayer: intent.relayer,
      amount: intent.amount,
      asset: intent.asset,
      call: { ...call, value: call.value.toString() },
      quotation: intent.quotation,
      zatoshis: intent.zatoshis,
      pricing: intent.pricing,
      feeCapWei: intent.feeCapWei,
      expires: intent.expiry,
      orderState: order.state,
      receivedZatoshis: totals.received.toString(),
      confirmedZatoshis: totals.confirmed.toString(),
      requiredConfirmations: this.store.confirmations,
      paymentTxs: [
        ...new Set(
          (
            this.store.db
              .prepare("SELECT key FROM payments WHERE order_id=? AND active=1")
              .all(id) as { key: string }[]
          ).map((p) => String(p.key).split(":")[0]),
        ),
      ],
      paymentAddress: order.address,
      txHash: order.tx_hash,
      liveRefundsEnabled: false,
    };
  }
}
export const erc20Asset = (address: Address, decimals: number): Erc20Asset => ({
  kind: "ERC20",
  address,
  decimals,
});
