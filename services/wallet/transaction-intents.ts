import type { Intent, Operation } from "./intent-model.ts";
export type { Intent, Operation } from "./intent-model.ts";
// Preview-only policy. No keys, payment journals, signing or execution adapters.
import { createHash } from "node:crypto";
import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { originOf, transaction } from "./dapp-policy.ts";
import { network } from "../evm/networks.ts";

export const intentAbi = parseAbi([
  "function transfer(address to,uint256 amount)",
  "function approve(address spender,uint256 amount)",
  "function mint((address recipient,uint256 zatoshis,bytes32 nonce,uint64 expiry) intent,bytes signature)",
  "function buy(uint256 id,address recipient) payable",
  "function swapExactETHForTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline) payable",
]);
export type Scope = {
  session: string;
  channel: string;
  origin: string;
  account: Address;
  chainId: number;
  permitted: boolean;
  expires: number;
};
export type EvmRoute = {
  chainId: 84532 | 11155111 | 46630;
  target: Address;
  operation: "nft-mint" | "nft-purchase" | "token-swap";
  codeHash: Hex;
  maxInput: string;
  feeCap: string;
  // Pin token route for swaps; NFT listing facts still require adapter validation.
  inputMint?: Address;
  outputMint?: Address;
};
export type Simulation = {
  chainId: number;
  requestDigest: string;
  codeHash: Hex;
  success: boolean;
  fee: string;
  gas: string;
  at: number;
};
export const disclosures = [
  "Preview consent is not a transaction signature or settlement authorization.",
  "Supported settlement uses a trusted prefunded testnet relayer; separate payment and financial authorization are required.",
  "Destination transactions and recipients are public. This preview does not provide destination anonymity.",
] as const;
export const fingerprint = (v: unknown): string =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export const intentId = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    id,
  );
const eq = (a: string, b: string) => getAddress(a) === getAddress(b);
const uint = (v: string) => {
  if (!/^(0|[1-9]\d{0,77})$/.test(v) || BigInt(v) >= 1n << 256n)
    throw Error("INVALID_INTEGER");
  return BigInt(v);
};
export function validateRegistry(
  routes: readonly EvmRoute[],
): readonly EvmRoute[] {
  const seen = new Set<string>();
  for (const r of routes) {
    network(r.chainId);
    getAddress(r.target);
    if (
      !/^0x[0-9a-f]{64}$/.test(r.codeHash) ||
      BigInt(r.codeHash) === 0n ||
      uint(r.feeCap) <= 0n ||
      uint(r.feeCap) > 5000000000000000n
    )
      throw Error("INVALID_ROUTE");
    if (!["nft-mint", "nft-purchase", "token-swap"].includes(r.operation))
      throw Error("INVALID_ROUTE");
    if (r.operation === "nft-mint" && r.chainId !== 84532)
      throw Error("INVALID_MINT_NETWORK");
    if (
      uint(r.maxInput) >
      (r.operation === "token-swap"
        ? 200000000000000n
        : r.operation === "nft-purchase"
          ? 1000000000000000n
          : 0n)
    )
      throw Error("INPUT_CAP");
    if (
      r.operation === "token-swap" &&
      (r.chainId !== 84532 ||
        !r.inputMint ||
        !r.outputMint ||
        eq(r.inputMint, r.outputMint))
    )
      throw Error("INVALID_ROUTE");
    if (r.inputMint) getAddress(r.inputMint);
    if (r.outputMint) getAddress(r.outputMint);
    const key = `${r.chainId}:${r.target.toLowerCase()}:${r.operation}`;
    if (seen.has(key)) throw Error("DUPLICATE_ROUTE");
    seen.add(key);
  }
  return Object.freeze(routes.map((r) => Object.freeze(structuredClone(r))));
}
export function evmIntent(
  scope: Scope,
  id: string,
  params: unknown[],
  routes: readonly EvmRoute[],
  at = Date.now(),
): Intent {
  originOf(scope.origin);
  if (
    !scope.permitted ||
    !scope.session ||
    !scope.channel ||
    scope.expires <= at
  )
    throw Error("UNAUTHORIZED_SCOPE");
  if (!intentId(id)) throw Error("INVALID_REQUEST_ID");
  network(scope.chainId);
  const tx = transaction(params, scope.account, scope.chainId);
  const value = BigInt(tx.value);
  const requestDigest = fingerprint({
    version: 1,
    origin: scope.origin,
    chainId: scope.chainId,
    account: scope.account,
    tx,
  });
  let operation: Operation = "unknown",
    recipient: string | null = null,
    amount = value.toString(),
    asset = "ETH",
    outputAsset: string | null = null,
    minimum: string | null = null;
  let expires = Math.min(scope.expires, at + 300000),
    reason = "Unknown contract or unsupported method",
    decoded:
      ReturnType<typeof decodeFunctionData<typeof intentAbi>> | undefined;
  if (tx.data !== "0x") {
    try {
      decoded = decodeFunctionData({ abi: intentAbi, data: tx.data as Hex });
      const encoded = encodeFunctionData({
        abi: intentAbi,
        functionName: decoded.functionName,
        args: decoded.args,
      } as any);
      if (encoded.toLowerCase() !== tx.data.toLowerCase()) throw Error();
    } catch {
      throw Error("MALFORMED_OR_UNSUPPORTED_CALLDATA");
    }
    switch (decoded.functionName) {
      case "transfer":
        operation = "erc20-transfer";
        recipient = decoded.args[0];
        amount = decoded.args[1].toString();
        asset = tx.to;
        reason = "Direct token transfer has no approved ZEC-funded adapter";
        break;
      case "approve":
        operation = "erc20-approval";
        recipient = decoded.args[0];
        amount = decoded.args[1].toString();
        asset = tx.to;
        reason =
          decoded.args[1] === (1n << 256n) - 1n
            ? "Unlimited approval prohibited"
            : "Token spending approvals are unsupported";
        break;
      case "mint": {
        operation = "nft-mint";
        recipient = decoded.args[0].recipient;
        outputAsset = tx.to;
        if (decoded.args[0].zatoshis !== 1000000n || value !== 0n)
          throw Error("MINT_TERMS");
        expires = Math.min(expires, Number(decoded.args[0].expiry) * 1000);
        break;
      }
      case "buy":
        operation = "nft-purchase";
        recipient = decoded.args[1];
        outputAsset = `${tx.to}:listing:${decoded.args[0]}`;
        break;
      case "swapExactETHForTokens": {
        operation = "token-swap";
        recipient = decoded.args[2];
        minimum = decoded.args[0].toString();
        const path = decoded.args[1];
        if (path.length !== 2 || decoded.args[0] <= 0n || value <= 0n)
          throw Error("SWAP_TERMS");
        outputAsset = path[1];
        expires = Math.min(expires, Number(decoded.args[3]) * 1000);
        break;
      }
    }
  }
  if (!Number.isSafeInteger(expires) || expires <= at)
    throw Error("REQUEST_EXPIRED");
  if (
    recipient &&
    ["nft-mint", "nft-purchase", "token-swap"].includes(operation) &&
    !eq(recipient, scope.account)
  )
    throw Error("RECIPIENT_MISMATCH");
  const route = validateRegistry(routes).find(
    (r) =>
      r.chainId === scope.chainId &&
      eq(r.target, tx.to) &&
      r.operation === operation,
  );
  let recognized = !!route;
  if (route) {
    if (value > uint(route.maxInput)) throw Error("INPUT_CAP");
    if (
      decoded?.functionName === "swapExactETHForTokens" &&
      (!eq(decoded.args[1][0], route.inputMint!) ||
        !eq(decoded.args[1][1], route.outputMint!))
    )
      throw Error("TOKEN_ROUTE_MISMATCH");
    reason =
      "Pinned adapter shape recognized; simulation, current contract facts, adapter quote and separate financial authorization remain required";
  } else recognized = false;
  return {
    version: 1,
    id,
    requestDigest,
    origin: scope.origin,
    destination: { family: "evm", chainId: `eip155:${scope.chainId}` },
    operation,
    target: tx.to,
    recipient,
    input: { asset, amount, decimals: asset === "ETH" ? 18 : null },
    output: { asset: outputAsset, expected: null, minimum },
    maximumCost: {
      input: value.toString(),
      networkFee: route?.feeCap ?? null,
      rent: "0",
    },
    networkRequirements: {
      simulation: "required",
      status: "unavailable",
      gas: null,
    },
    expires,
    risk: recognized ? "review-required" : "unsupported",
    approval: "pending",
    support: {
      adapter: route ? `existing:${operation}` : null,
      recognized,
      executionMode: "preview-only",
      executable: false,
      reason,
    },
    disclosures,
  };
}
// State is separate from financial journals. Scope is server-supplied, never dApp params.
export class IntentReviews {
  private readonly rows = new Map<
    string,
    { scope: Scope; intent: Intent; fingerprint: string; ready: boolean }
  >();
  readonly routes: readonly EvmRoute[];
  constructor(
    routes: readonly EvmRoute[] = [],
    readonly simulate?: (
      intent: Readonly<Intent>,
      params: unknown[],
    ) => Promise<Simulation>,
    readonly now = Date.now,
  ) {
    this.routes = validateRegistry(routes);
  }
  private access(scope: Scope, id: string) {
    const row = this.rows.get(id);
    if (
      !row ||
      !scope.permitted ||
      scope.expires <= this.now() ||
      row.scope.session !== scope.session ||
      row.scope.channel !== scope.channel ||
      row.scope.origin !== scope.origin ||
      row.scope.chainId !== scope.chainId ||
      !eq(row.scope.account, scope.account)
    )
      throw Error("INTENT_SCOPE_MISMATCH");
    return row;
  }
  async prepare(scope: Scope, id: string, params: unknown[]): Promise<Intent> {
    const intent = evmIntent(scope, id, params, this.routes, this.now()),
      fp = fingerprint(params);
    if (this.rows.has(id)) {
      const old = this.access(scope, id);
      if (old.fingerprint !== fp) throw Error("REQUEST_ID_REUSE");
      if (!old.ready) throw Error("REQUEST_PREPARING");
      return structuredClone(old.intent);
    }
    if (this.rows.size >= 512) throw Error("PREVIEW_CAPACITY_REACHED");
    const row = {
      scope: structuredClone(scope),
      intent,
      fingerprint: fp,
      ready: false,
    };
    this.rows.set(id, row); // Reserve before async work: duplicate requests cannot race.
    if (intent.support.recognized && this.simulate) {
      try {
        const result = await this.simulate(
          structuredClone(intent),
          structuredClone(params),
        );
        const route = this.routes.find(
          (r) =>
            r.chainId === scope.chainId &&
            eq(r.target, intent.target) &&
            r.operation === intent.operation,
        )!;
        if (
          !result.success ||
          result.requestDigest !== intent.requestDigest ||
          result.chainId !== scope.chainId ||
          result.codeHash !== route.codeHash ||
          result.at > this.now() ||
          result.at < this.now() - 30000 ||
          uint(result.fee) > uint(route.feeCap) ||
          uint(result.gas) <= 0n ||
          this.now() >= intent.expires
        )
          throw Error();
        intent.networkRequirements = {
          simulation: "required",
          status: "passed",
          gas: result.gas,
        };
      } catch {
        intent.support.reason =
          "Simulation unavailable, failed or mismatched; execution prohibited";
        intent.risk = "unsupported";
      }
    }
    row.ready = true;
    return structuredClone(row.intent);
  }
  consent(
    scope: Scope,
    id: string,
    exactDigest: string,
    approved: boolean,
  ): Intent {
    if (typeof approved !== "boolean") throw Error("EXPLICIT_CONSENT_REQUIRED");
    const { intent, ready } = this.access(scope, id);
    if (!ready) throw Error("REQUEST_PREPARING");
    if (
      intent.expires <= this.now() ||
      intent.requestDigest !== exactDigest ||
      intent.approval !== "pending"
    )
      throw Error("EXACT_FRESH_CONSENT_REQUIRED");
    intent.approval = approved ? "consented-preview-only" : "cancelled";
    return structuredClone(intent);
  }
  get(scope: Scope, id: string): Intent {
    return structuredClone(this.access(scope, id).intent);
  }
}
