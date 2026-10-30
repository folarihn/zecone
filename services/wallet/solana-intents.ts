// Local restricted inspection only. Not advertised through Wallet Standard.
import {
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  blockhash,
} from "@solana/kit";
import { inspect, type Action } from "../solana/transactions.ts";
import {
  inspectSwap,
  validateTerms,
  type SwapPrepared,
} from "../solana/cpmm.ts";
import { GENESIS, publicKey } from "../solana/network.ts";
import type {
  SolanaDeliveryIntent,
  SwapTerms,
} from "../solana/settlement-model.ts";
import {
  disclosures,
  intentId,
  fingerprint,
  type Intent,
} from "./transaction-intents.ts";
import { originOf } from "./dapp-policy.ts";

export type SolanaInspection = {
  id: string;
  origin: string;
  genesis: string;
  wire: string;
  owner: string;
  recipient: string;
  amount: string;
  fee: string;
  rent: string;
  expires: number;
  lifetime: { blockhash: string; lastValidBlockHeight: string };
  swap?: SwapTerms;
};
export type SolanaReadChecks = {
  genesis(): Promise<string>;
  valid(hash: string, lastValidHeight: string): Promise<boolean>;
  // A trusted local read-only implementation must verify the pool/program hash,
  // mint ownership/decimals and account facts, not trust caller assertions.
  route(
    input: Readonly<
      Pick<SolanaInspection, "owner" | "recipient" | "amount" | "swap">
    >,
  ): Promise<boolean>;
  simulate(wire: string): Promise<{ err: unknown; fee: string; units: string }>;
};
export async function inspectSolanaIntent(
  input: SolanaInspection,
  net: SolanaReadChecks,
  now = Date.now,
): Promise<{
  intent: Intent;
  inspection: {
    feePayer: string;
    computeBudget: "default";
    programs: string[];
    accounts: string[];
    instructions: { program: string; accounts: string[] }[];
    units: string;
  };
}> {
  const allowed = [
    "id",
    "origin",
    "genesis",
    "wire",
    "owner",
    "recipient",
    "amount",
    "fee",
    "rent",
    "expires",
    "lifetime",
    "swap",
  ];
  if (Object.keys(input).some((k) => !allowed.includes(k)))
    throw Error("UNKNOWN_INSPECTION_FIELD");
  if (
    Object.keys(input.lifetime).some(
      (k) => !["blockhash", "lastValidBlockHeight"].includes(k),
    )
  )
    throw Error("UNKNOWN_LIFETIME_FIELD");
  if (
    input.swap &&
    Object.keys(input.swap).some(
      (k) =>
        ![
          "program",
          "pool",
          "inputMint",
          "outputMint",
          "inputDecimals",
          "outputDecimals",
          "amountIn",
          "slippageBps",
          "expectedOut",
          "minimumOut",
          "programHash",
        ].includes(k),
    )
  )
    throw Error("UNKNOWN_SWAP_FIELD");
  input = structuredClone(input);
  originOf(input.origin);
  if (
    !intentId(input.id) ||
    input.genesis !== GENESIS ||
    (await net.genesis()) !== GENESIS
  )
    throw Error("WRONG_NETWORK_OR_ID");
  publicKey(input.owner);
  publicKey(input.recipient);
  if (
    input.owner === input.recipient ||
    !Number.isSafeInteger(input.expires) ||
    input.expires <= now() ||
    input.expires > now() + 300000
  )
    throw Error("INVALID_INTENT");
  const integer = (s: string) => {
    if (!/^(0|[1-9]\d{0,19})$/.test(s)) throw Error("INVALID_INTEGER");
    return BigInt(s);
  };
  if (
    integer(input.fee) > 10000n ||
    integer(input.rent) > 6000000n ||
    integer(input.amount) + integer(input.fee) + integer(input.rent) > 7010000n
  )
    throw Error("COST_CAP");
  const lifetime = {
    blockhash: blockhash(input.lifetime.blockhash),
    lastValidBlockHeight: integer(input.lifetime.lastValidBlockHeight),
  };
  if (input.swap) {
    validateTerms(input.swap);
    if (input.amount !== input.swap.amountIn) throw Error("AMOUNT_MISMATCH");
    const i: SolanaDeliveryIntent = {
      family: "solana",
      action: "SOLANA_DEVNET_SPL_SWAP",
      network: "solana:devnet",
      genesis: GENESIS,
      relayer: input.owner,
      recipient: input.recipient,
      lamports: input.amount,
      feeCap: "10000",
      swap: input.swap,
      // Reconstruction needs no payment, nonce or journal. These are local placeholders.
      zatoshis: "0",
      nonce: `0x${"0".repeat(64)}`,
      expiry: Math.floor(input.expires / 1000),
      pricing: "FIXED_TESTNET_DEMO_NOT_EXCHANGE_RATE",
      profileId: "intent-inspection",
      requestId: input.id,
    };
    const prepared: SwapPrepared = {
      wire: input.wire,
      digest: fingerprintWire(input.wire),
      fee: input.fee,
      lifetime: input.lifetime,
      swap: input.swap,
      expiresAt: Math.floor(input.expires / 1000),
      simulation: { err: null, unitsConsumed: null },
    };
    await inspectSwap(i, prepared);
  } else {
    if (
      !["1000000", "2000000", "5000000"].includes(input.amount) ||
      input.rent !== "0"
    )
      throw Error("UNSUPPORTED_DELIVERY");
    const action: Action = {
      family: "solana",
      network: "solana:devnet",
      genesis: GENESIS,
      owner: input.owner,
      recipient: input.recipient,
      amount: input.amount,
      feeCap: "10000",
      asset: { kind: "SOL" },
    };
    await inspect(input.wire, action, lifetime, [input.owner, input.recipient]);
  }
  const tx = getTransactionDecoder().decode(Buffer.from(input.wire, "base64"));
  if (
    Object.values(tx.signatures).some(
      (s) => s !== null && s.some((b) => b !== 0),
    )
  )
    throw Error("UNSIGNED_ONLY");
  if (
    !(await net.valid(
      input.lifetime.blockhash,
      input.lifetime.lastValidBlockHeight,
    )) ||
    !(await net.route(
      structuredClone({
        owner: input.owner,
        recipient: input.recipient,
        amount: input.amount,
        swap: input.swap,
      }),
    ))
  )
    throw Error("UNVERIFIED_ROUTE_OR_BLOCKHASH");
  const sim = await net.simulate(input.wire);
  if (
    sim.err !== null ||
    integer(sim.fee) !== integer(input.fee) ||
    integer(sim.units) <= 0n ||
    now() >= input.expires ||
    !(await net.valid(
      input.lifetime.blockhash,
      input.lifetime.lastValidBlockHeight,
    ))
  )
    throw Error("SIMULATION_FAILED_OR_EXPIRED");
  const message = getCompiledTransactionMessageDecoder().decode(
    tx.messageBytes,
  );
  if (message.version !== "legacy") throw Error("LOOKUP_TABLES_UNSUPPORTED");
  const accounts = [...message.staticAccounts];
  const instructions = message.instructions.map((ix) => ({
    program: accounts[ix.programAddressIndex]!,
    accounts: [...(ix.accountIndices ?? [])].map((n) => accounts[n]!),
  }));
  const intent: Intent = {
    version: 1,
    id: input.id,
    requestDigest: fingerprint({
      version: 1,
      origin: input.origin,
      wire: input.wire,
      fee: input.fee,
      rent: input.rent,
      expires: input.expires,
      lifetime: input.lifetime,
    }),
    origin: input.origin,
    destination: { family: "solana", chainId: "solana:devnet" },
    operation: input.swap ? "raydium-swap" : "sol-delivery",
    target: input.swap?.program ?? "11111111111111111111111111111111",
    recipient: input.recipient,
    input: {
      asset: input.swap?.inputMint ?? "SOL",
      amount: input.amount,
      decimals: 9,
    },
    output: {
      asset: input.swap?.outputMint ?? "SOL",
      expected: input.swap?.expectedOut ?? input.amount,
      minimum: input.swap?.minimumOut ?? input.amount,
    },
    maximumCost: {
      input: input.amount,
      networkFee: input.fee,
      rent: input.rent,
    },
    networkRequirements: {
      simulation: "required",
      status: "passed",
      gas: sim.units,
    },
    expires: input.expires,
    risk: "review-required",
    approval: "pending",
    support: {
      adapter: input.swap ? "existing:raydium-cpmm" : "existing:sol-delivery",
      recognized: true,
      executionMode: "preview-only",
      executable: false,
      reason:
        "Canonical unsigned instructions and read-only simulation verified; separate settlement authorization required",
    },
    disclosures,
  };
  return {
    intent,
    inspection: {
      feePayer: input.owner,
      computeBudget: "default",
      programs: [...new Set(instructions.map((i) => i.program))],
      accounts,
      instructions,
      units: sim.units,
    },
  };
}
import { digest as fingerprintWire } from "../solana/transactions.ts";
