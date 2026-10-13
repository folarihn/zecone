import type { Address, Hex } from "viem";
import type { PurchaseIntent } from "../marketplace/purchase.ts";
import type { SwapIntent } from "../swaps/intent.ts";
export type SignedExecutionIntent = PurchaseIntent | SwapIntent;
export type UnsignedExecutionIntent = Omit<PurchaseIntent, "signature"> | Omit<SwapIntent, "signature">;

// Read-only adapter view. Never rewrite a previously signed/persisted legacy intent.
export type ExecutionIntent =
  | { action: "NFT_PURCHASE"; version: 1 | 2; signed: PurchaseIntent }
  | { action: "TOKEN_SWAP"; version: 1; signed: SwapIntent }
  | {
      action: "FUTURE_MARKETPLACE_ORDER";
      version: 1;
      executable: false;
      proposal: FutureMarketplaceOrder;
    };
export type FutureMarketplaceOrder = {
  externalOrderId: string;
  orderHash: Hex;
  chainId: number;
  marketplace: Address;
  recipient: Address;
  expiry: number;
  calldata: Hex;
  calldataHash: Hex;
  offer: readonly { token: Address; identifier: string; amount: string }[];
  consideration: readonly {
    token: Address;
    identifier: string;
    amount: string;
    recipient: Address;
  }[];
  fees: readonly { recipient: Address; amount: string }[];
  simulationAdapter: string;
};
export function classifyIntent(
  value: PurchaseIntent | SwapIntent,
): ExecutionIntent {
  if (value.kind === "purchase")
    return {
      action: "NFT_PURCHASE",
      version: value.chainId === 84532 ? 1 : 2,
      signed: value,
    };
  if (value.kind === "swap" && value.version === 1)
    return { action: "TOKEN_SWAP", version: 1, signed: value };
  throw Error("unsupported_execution_intent");
}
