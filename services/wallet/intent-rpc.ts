// Read-only simulator; receives destination request facts only. No source payment.
import { createPublicClient, http, keccak256, type Hex } from "viem";
import { network } from "../evm/networks.ts";
import { transaction } from "./dapp-policy.ts";
import {
  IntentReviews,
  type EvmRoute,
  type Simulation,
} from "./transaction-intents.ts";
import type { Address } from "viem";

export function readOnlyIntentReviews(
  account: Address,
  routes: readonly EvmRoute[],
) {
  return new IntentReviews(
    routes,
    async (intent, params): Promise<Simulation> => {
      const id = Number(intent.destination.chainId.split(":")[1]),
        n = network(id);
      const client = createPublicClient({
        transport: http(n.rpc, { timeout: 10000, retryCount: 0 }),
      });
      if ((await client.getChainId()) !== id)
        throw Error("RPC_NETWORK_MISMATCH");
      const tx = transaction(params, account, id),
        block = await client.getBlockNumber();
      const code = await client.getBytecode({
        address: tx.to,
        blockNumber: block,
      });
      if (!code || code === "0x") throw Error("NO_CONTRACT_CODE");
      const call = {
        account,
        to: tx.to,
        data: tx.data as Hex,
        value: BigInt(tx.value),
        blockNumber: block,
      };
      await client.call(call);
      const gas = ((await client.estimateGas(call)) * 12n) / 10n + 1n;
      const fees = await client.estimateFeesPerGas();
      if (gas > n.maxGas || fees.maxFeePerGas > n.maxFee)
        throw Error("FEE_CAP");
      return {
        chainId: id,
        requestDigest: intent.requestDigest,
        codeHash: keccak256(code),
        success: true,
        fee: (gas * fees.maxFeePerGas + n.dataReserve).toString(),
        gas: gas.toString(),
        at: Date.now(),
      };
    },
  );
}
