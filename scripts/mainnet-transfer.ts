import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { exclusiveJson } from "../services/execution/io.ts";
import {
  addressBinding,
  ownershipMessage,
  verifyDestinationOwnership,
  type DestinationNetwork,
} from "../services/settlement/mainnet-address.ts";
import {
  productionPrice,
  type ProductionProfile,
  type SignedPrice,
} from "../services/settlement/production-safety.ts";
import {
  mainnetTransferTerms,
  prepareMainnetTransfer,
  preparedDigest,
  termsDigest,
  verifyMainnetSignedBundle,
  verifiedMainnetSummary,
  type MainnetPrepared,
  type MainnetSignedBundle,
  type MainnetTransferRequest,
  type MainnetTransferTerms,
} from "../services/settlement/mainnet-transfer.ts";
import { mainnetApprovalPackage } from "../services/settlement/mainnet-approval-package.ts";
import {
  assertMainnetQuote,
  type MainnetQuote,
  type MainnetQuoteInput,
} from "../services/settlement/mainnet-quote.ts";

type RequestFile = {
  recipient: string;
  amount: string;
  feeCap: string;
  l1DataFeeBound?: string;
  sourcePaymentCommitment: string;
  expires: number;
};
type PricingFile = {
  feeds: { price: SignedPrice; publicKey: string }[];
  pair: "ETH/ZEC" | "SOL/ZEC";
  maximumSpreadBps?: number;
  networkFee: string;
  l1DataFee: string;
  serviceFee: string;
  ttlSeconds?: number;
};
type Plan = {
  version: 1;
  createdAt: string;
  network: DestinationNetwork;
  profile: ProductionProfile;
  terms: MainnetTransferTerms;
  termsDigest: string;
  approvalPackage: ReturnType<typeof mainnetApprovalPackage>;
  prepared?: MainnetPrepared;
};

function args() {
  const [command, ...rest] = process.argv.slice(2),
    values = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith("--") || !rest[i + 1])
      throw Error("INVALID_ARGUMENTS");
    values.set(rest[i].slice(2), rest[++i]);
  }
  return { command, values };
}
function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}
function writeJson(file: string, value: unknown) {
  exclusiveJson(file, value);
}
function network(value: string | undefined): DestinationNetwork {
  if (value !== "base" && value !== "solana") throw Error("NETWORK_REQUIRED");
  return value;
}
function profile(file: string, net: DestinationNetwork) {
  const profiles = readJson<ProductionProfile[]>(file);
  if (!Array.isArray(profiles)) throw Error("PROFILE_FILE_INVALID");
  const found = profiles.find((p) => p.network === net);
  if (!found) throw Error("PROFILE_NOT_FOUND");
  return found;
}

async function main() {
  const { command, values } = args();
  if (command === "address") {
    const net = network(values.get("network")),
      value = values.get("address") ?? "",
      expires =
        Number(values.get("expires")) || Math.floor(Date.now() / 1000) + 600,
      nonce = values.get("nonce") ?? `0x${randomBytes(32).toString("hex")}`;
    console.log(
      JSON.stringify(
        {
          network: net,
          address: value,
          binding: addressBinding(net, value),
          expires,
          nonce,
          message: ownershipMessage(net, value, nonce, expires),
          signing: false,
          broadcast: false,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "plan") {
    const net = network(values.get("network")),
      profiles = values.get("profiles"),
      requestFile = values.get("request"),
      pricingFile = values.get("pricing"),
      quoteFile = values.get("quote"),
      proofFile = values.get("ownership-proof"),
      out = values.get("out");
    if (
      !profiles ||
      !requestFile ||
      !pricingFile ||
      !quoteFile ||
      !proofFile ||
      !out
    )
      throw Error("ARGUMENTS_REQUIRED");
    const p = profile(profiles, net),
      request = readJson<RequestFile>(requestFile),
      pricing = readJson<PricingFile>(pricingFile),
      quoted = readJson<MainnetQuote>(quoteFile),
      proof = readJson<{
        nonce: string;
        expires: number;
        signature: string;
      }>(proofFile),
      now = Math.floor(Date.now() / 1000),
      price = productionPrice(
        pricing.feeds,
        pricing.pair,
        BigInt(request.amount),
        net === "base" ? 18 : 9,
        now,
        pricing.maximumSpreadBps,
      ),
      expires = Math.min(request.expires, price.expires, quoted.expires),
      quoteInput: MainnetQuoteInput = {
        network: net,
        profile: p,
        pair: pricing.pair,
        feeds: pricing.feeds,
        destinationUnits: BigInt(request.amount),
        networkFee: BigInt(pricing.networkFee),
        l1DataFee: BigInt(pricing.l1DataFee),
        serviceFee: BigInt(pricing.serviceFee),
        now,
        ttlSeconds: pricing.ttlSeconds,
        maximumSpreadBps: pricing.maximumSpreadBps,
      },
      quote = assertMainnetQuote(quoted, quoteInput, now),
      ownership = await verifyDestinationOwnership({
        network: net,
        address: request.recipient,
        nonce: proof.nonce,
        expires: proof.expires,
        signature: proof.signature,
        now,
      });
    if (ownership.binding !== addressBinding(net, request.recipient))
      throw Error("DESTINATION_OWNERSHIP_REQUIRED");
    if (
      quote.sourceZatoshis !== price.zatoshis ||
      quote.expires > price.expires
    )
      throw Error("QUOTE_PRICE_MISMATCH");
    const terms = mainnetTransferTerms(
      p,
      {
        recipient: request.recipient,
        amount: request.amount,
        feeCap: request.feeCap,
        l1DataFeeBound: request.l1DataFeeBound,
        sourceZatoshis: quote.sourceZatoshis,
        sourcePaymentCommitment: request.sourcePaymentCommitment,
        destinationBinding: ownership.binding,
        quoteDigest: quote.quoteDigest,
        expires,
      },
      now,
    );
    const plan: Plan = {
      version: 1,
      createdAt: new Date(now * 1000).toISOString(),
      network: net,
      profile: p,
      terms,
      termsDigest: termsDigest(terms),
      approvalPackage: mainnetApprovalPackage(
        p,
        { zatoshis: price.zatoshis, expires: price.expires },
        now,
      ),
    };
    writeJson(out, plan);
    console.log(
      JSON.stringify({
        status: "AWAITING_OFFLINE_SIGNATURE",
        network: net,
        termsDigest: plan.termsDigest,
        sourceZatoshis: terms.sourceZatoshis,
        maximumDestinationDebit: terms.maximumDestinationDebit,
        quoteDigest: terms.quoteDigest,
        expires: terms.expires,
        plan: out,
        signing: false,
        broadcast: false,
      }),
    );
    return;
  }
  if (command === "prepare") {
    const planFile = values.get("plan");
    if (!planFile) throw Error("PLAN_REQUIRED");
    const out = values.get("out");
    if (!out || resolve(out) === resolve(planFile))
      throw Error("NEW_PREPARED_OUTPUT_REQUIRED");
    const plan = readJson<Plan>(planFile),
      prepared = await prepareMainnetTransfer(plan.profile, plan.terms);
    writeJson(out, { ...plan, prepared });
    console.log(
      JSON.stringify({
        status: "AWAITING_OFFLINE_SIGNATURE",
        network: prepared.kind,
        preparedDigest: preparedDigest(prepared),
        prepared,
        signing: false,
        broadcast: false,
      }),
    );
    return;
  }
  if (command === "verify") {
    const planFile = values.get("plan"),
      bundleFile = values.get("bundle"),
      out = values.get("out");
    if (!planFile || !bundleFile) throw Error("PLAN_AND_BUNDLE_REQUIRED");
    const plan = readJson<Plan>(planFile),
      bundle = readJson<MainnetSignedBundle>(bundleFile);
    if (!plan.prepared) throw Error("PREPARED_TRANSFER_REQUIRED");
    const verified = await verifyMainnetSignedBundle(
      plan.profile,
      plan.terms,
      plan.prepared,
      bundle,
    );
    if (out) writeJson(out, verified);
    console.log(JSON.stringify(verifiedMainnetSummary(verified)));
    return;
  }
  throw Error("UNKNOWN_COMMAND");
}

void main().catch((e) => {
  console.error(
    `Mainnet planning unavailable: ${
      e instanceof Error && /^[A-Z0-9_]{1,96}$/.test(e.message)
        ? e.message
        : "INVALID_OPERATION"
    }. No signing or broadcast occurred.`,
  );
  process.exitCode = 1;
});
