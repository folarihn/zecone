import { createHash } from "node:crypto";
import type { ProductionProfile } from "./production-safety.ts";
// A blocked planning package is not a payment request or execution capability.
export function mainnetApprovalPackage(
  profile: ProductionProfile,
  pricing?: { zatoshis: string; expires: number },
  now = Math.floor(Date.now() / 1000),
) {
  if (!["base", "solana"].includes(profile.network))
    throw Error("DESTINATION_NETWORK_REQUIRED");
  const amount = BigInt(profile.perTransaction) - BigInt(profile.feeCap);
  if (amount <= 0n) throw Error("INVALID_LIMIT");
  const terms = {
    version: 1,
    sourceNetwork: "zcash-mainnet",
    destinationNetwork:
      profile.network === "base" ? "eip155:8453" : "solana:mainnet",
    asset: profile.network === "base" ? "ETH" : "SOL",
    recipient: profile.recipients.length === 1 ? profile.recipients[0] : null,
    destinationBinding: null,
    addressOwnershipProof: null,
    amount: amount.toString(),
    maximumDestinationDebit: profile.perTransaction,
    feeCap: profile.feeCap,
    relayer: profile.relayer ?? null,
    signerIdentity: profile.signer?.identity ?? null,
    sourceZatoshis: pricing && pricing.expires > now ? pricing.zatoshis : null,
    priceExpires: pricing && pricing.expires > now ? pricing.expires : null,
    sourcePaymentAddress: null,
    sourceSendingFee: null,
  };
  return {
    status: "BLOCKED" as const,
    authorizationGranted: false,
    terms,
    digest: createHash("sha256").update(JSON.stringify(terms)).digest("hex"),
    requires: [
      "Exact dedicated mainnet relayer and authorized recipient; never inherit testnet keys or addresses",
      "Recipient-signed destination ownership challenge bound into the exact transfer terms",
      "Fresh independently signed production pricing covering destination amount, fees and approved margin",
      "Mainnet shielded receiving profile, source sending fee and independently corroborated owned-note evidence",
      "Separate-device signer identity and policy validation; configuration alone is insufficient",
      "Fail-closed single-writer deployment on one local durable database with no competing signer",
      "Network-specific executor mainnet activation review and a separately approved exact bounded live plan",
      ...(profile.network === "base"
        ? [
            "Fresh full Base execution, L1 data and operator fee bound accepted explicitly",
          ]
        : []),
    ],
    verificationPlan:
      profile.network === "base"
        ? "Two independent providers agree on canonical finalized block, exact signed transaction, receipt success, destination value and total relayer fee/debit."
        : "Two independent providers agree on genesis, finalized signature/message, exact recipient SOL delta and relayer amount plus fee delta.",
    recovery:
      "Persist signed bytes and transaction identity before the sole submission. If any result is uncertain, pause and reconcile that identity only. Never release its reservation, replace it automatically or initiate a refund.",
    emergencyStop:
      "Persist emergency pause before further execution claims; stop wallet worker and independently lock the external signer. A pause cannot revoke already signed or submitted bytes.",
    signing: false,
    broadcast: false,
  };
}
