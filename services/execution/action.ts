import {
  encodeFunctionData,
  getAddress,
  hashTypedData,
  keccak256,
  toHex,
  recoverTypedDataAddress,
  parseAbi,
  decodeEventLog,
  parseTransaction,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
} from "viem";
import { Base } from "./base.ts";
import { PRICE, type Intent } from "./intent.ts";
import type { Order } from "./store.ts";
import type { Result } from "./worker.ts";
export const ACTION_BUDGET = "5000000000000000";
export const NOTE = keccak256(toHex("ZecOne Phase 2 shielded sponsorship"));
export const actionAbi = parseAbi([
  "function execute((bytes32 orderId,uint256 chainId,address recipient,address target,bytes data,uint256 maxValue,uint256 maxGasBudget,uint256 zatoshis,uint64 expiry) intent,bytes signature)",
  "function record(bytes32 note)",
  "function recordFor(address account,bytes32 note)",
  "function records(address) view returns(uint256)",
  "function consumed(bytes32) view returns(bool)",
  "function relayer() view returns(address)",
  "function PRICE() view returns(uint256)",
  "event ActionExecuted(bytes32 indexed digest,bytes32 indexed orderId,address indexed recipient)",
  "event Recorded(address indexed account,bytes32 note,uint256 count)",
]);
export const actionTypes = {
  ActionIntent: [
    { name: "orderId", type: "bytes32" },
    { name: "chainId", type: "uint256" },
    { name: "recipient", type: "address" },
    { name: "target", type: "address" },
    { name: "data", type: "bytes" },
    { name: "maxValue", type: "uint256" },
    { name: "maxGasBudget", type: "uint256" },
    { name: "zatoshis", type: "uint256" },
    { name: "expiry", type: "uint64" },
  ],
} as const;
export type ActionIntent = Intent & {
  kind: "action";
  orderId: Hex;
  chainId: 84532;
  target: Address;
  data: Hex;
  maxValue: "0";
  maxGasBudget: string;
};
export function actionTyped(i: Omit<ActionIntent, "signature">) {
  return {
    domain: {
      name: "ZecOnePhase2",
      version: "1",
      chainId: 84532,
      verifyingContract: i.contract,
    },
    types: actionTypes,
    primaryType: "ActionIntent" as const,
    message: {
      orderId: i.orderId,
      chainId: BigInt(i.chainId),
      recipient: i.recipient,
      target: i.target,
      data: i.data,
      maxValue: BigInt(i.maxValue),
      maxGasBudget: BigInt(i.maxGasBudget),
      zatoshis: BigInt(i.zatoshis),
      expiry: BigInt(i.expiry),
    },
  };
}
export function actionTerms(
  i: Omit<ActionIntent, "signature">,
  contract: Address,
  user: Address,
  now: number,
) {
  if (
    i.kind !== "action" ||
    i.chainId !== 84532 ||
    getAddress(i.contract) !== getAddress(contract) ||
    getAddress(i.target) !== getAddress(contract) ||
    getAddress(i.recipient) !== getAddress(user) ||
    i.nonce !== i.orderId ||
    !/^0x[0-9a-f]{64}$/.test(i.orderId) ||
    BigInt(i.orderId) === 0n ||
    i.maxValue !== "0" ||
    i.maxGasBudget !== ACTION_BUDGET ||
    i.zatoshis !== PRICE.toString() ||
    !Number.isSafeInteger(i.expiry) ||
    i.expiry <= now ||
    i.expiry > now + 86400 ||
    i.data !==
      encodeFunctionData({
        abi: actionAbi,
        functionName: "recordFor",
        args: [user, NOTE],
      })
  )
    throw Error("Restricted action terms mismatch");
  return hashTypedData(actionTyped(i));
}
export async function verifyAction(
  i: ActionIntent,
  contract: Address,
  relayer: Address,
  now: number,
) {
  const id = actionTerms(i, contract, i.recipient, now);
  if (
    getAddress(i.recipient) === getAddress(relayer) ||
    getAddress(i.recipient) === "0x0000000000000000000000000000000000000000" ||
    getAddress(
      await recoverTypedDataAddress({
        ...actionTyped(i),
        signature: i.signature,
      }),
    ) !== getAddress(i.recipient)
  )
    throw Error("User signature required");
  return id;
}
export class ActionBase extends Base {
  override async prepare(o: Order) {
    await this.check();
    const i = JSON.parse(o.intent) as ActionIntent;
    if (
      (await verifyAction(
        i,
        this.contract,
        this.account.address,
        Math.floor(Date.now() / 1000),
      )) !== o.id
    )
      throw Error("Action identity mismatch");
    const args = [actionTyped(i).message, i.signature] as const;
    await this.public.simulateContract({
      address: this.contract,
      abi: actionAbi,
      functionName: "execute",
      args,
      account: this.account.address,
    });
    const tx = await this.signed(
        encodeFunctionData({ abi: actionAbi, functionName: "execute", args }),
        this.contract,
      ),
      decoded = parseTransaction(tx.raw);
    if (
      !decoded.gas ||
      !decoded.maxFeePerGas ||
      decoded.gas * decoded.maxFeePerGas > BigInt(i.maxGasBudget)
    )
      throw Error("Signed execution exceeds approved budget");
    return tx;
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
    const i = JSON.parse(o.intent) as ActionIntent;
    const actionTopic = keccak256(
      toHex("ActionExecuted(bytes32,bytes32,address)"),
    );
    const events = r.logs
      .filter(
        (l) =>
          getAddress(l.address) === getAddress(this.contract) &&
          l.topics[0] === actionTopic,
      )
      .flatMap((l) => {
        try {
          return [
            decodeEventLog({
              abi: actionAbi,
              eventName: "ActionExecuted",
              data: l.data,
              topics: l.topics,
            }).args,
          ];
        } catch {
          return [];
        }
      });
    const consumed = await this.public.readContract({
      address: this.contract,
      abi: actionAbi,
      functionName: "consumed",
      args: [o.id],
    });
    if (
      events.length !== 1 ||
      events[0].digest !== o.id ||
      events[0].orderId !== i.orderId ||
      getAddress(events[0].recipient) !== getAddress(i.recipient) ||
      !consumed
    )
      throw Error(
        `Missing exact action receipt (events=${events.length},digest=${String(events[0]?.digest)},order=${String(events[0]?.orderId)},recipient=${String(events[0]?.recipient)},consumed=${consumed})`,
      );
    return {
      status: "success",
      hash: r.transactionHash,
      block: r.blockNumber.toString(),
      recipient: i.recipient,
      actionId: i.orderId,
    };
  }
}
