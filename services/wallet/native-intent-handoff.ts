// Explicit alternate checkout, never a successful eth_sendTransaction response.
import { getAddress } from "viem";
import { transaction, originOf } from "./dapp-policy.ts";
import { evmIntent, fingerprint } from "./transaction-intents.ts";
import type { IntentContext } from "./intent-checkout.ts";
export function nativeIntentHandoff(
  context: IntentContext,
  origins: readonly string[],
) {
  const { scope, intent, params } = context();
  if (intent.expires <= Date.now()) throw Error("INTENT_EXPIRED");
  if (
    !origins.map(originOf).includes(scope.origin) ||
    intent.approval !== "consented-preview-only"
  )
    throw Error("NATIVE_HANDOFF_PERMISSION_REQUIRED");
  const canonical = evmIntent(scope, intent.id, params, []);
  const tx = transaction(params, scope.account, scope.chainId);
  if (
    canonical.requestDigest !== intent.requestDigest ||
    tx.data !== "0x" ||
    BigInt(tx.value) <= 0n
  )
    throw Error("NATIVE_HANDOFF_ONLY");
  return {
    recipient: getAddress(tx.to),
    amount: tx.value,
    chainId: scope.chainId,
    source: {
      id: intent.id,
      origin: scope.origin,
      account: scope.account,
      digest: intent.requestDigest,
      scope: fingerprint(scope),
    },
    standardTransactionExecuted: false,
  };
}
