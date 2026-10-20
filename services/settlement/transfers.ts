import { createHash, randomBytes } from "node:crypto";
import { getAddress, zeroAddress, type Address, type Hex } from "viem";
import { network, type NetworkId } from "../evm/networks.ts";
import { GENESIS, publicKey, SolanaError } from "../solana/network.ts";
export const DEMO_ZATOSHIS = "100000";
export const TRANSFER_ACTIONS = Object.freeze({
  EVM_NATIVE: "EVM_NATIVE_TRANSFER",
  EVM_ERC20: "EVM_ERC20_TRANSFER",
  SOLANA_SOL: "SOLANA_DEVNET_SOL_DELIVERY",
  SOLANA_SPL: "SOLANA_DEVNET_SPL_DELIVERY",
} as const);
export type TransferAction =
  (typeof TRANSFER_ACTIONS)[keyof typeof TRANSFER_ACTIONS];
export type Erc20Asset = {
  kind: "ERC20";
  address: Address;
  decimals: number;
};
export type SplAsset = {
  kind: "SPL";
  mint: string;
  decimals: number;
};
export type EvmTransferIntent = {
  family: "evm";
  action:
    typeof TRANSFER_ACTIONS.EVM_NATIVE | typeof TRANSFER_ACTIONS.EVM_ERC20;
  version: 1;
  chainId: NetworkId;
  relayer: Address;
  recipient: Address;
  amount: string;
  asset: { kind: "native" } | Erc20Asset;
  feeCapWei: string;
  quotation: {
    block: string;
    calldataHash: Hex;
    gas: string;
    feeCapWei: string;
    at: number;
    expires: number;
  };
  zatoshis: string;
  nonce: Hex;
  expiry: number;
  pricing: "FIXED_TESTNET_DEMO_NOT_EXCHANGE_RATE";
  profileId: string;
  requestId: string;
};
export type SolanaTransferIntent = {
  family: "solana";
  action:
    typeof TRANSFER_ACTIONS.SOLANA_SOL | typeof TRANSFER_ACTIONS.SOLANA_SPL;
  version: 1;
  network: "solana:devnet";
  genesis: typeof GENESIS;
  relayer: string;
  recipient: string;
  amount: string;
  asset: { kind: "SOL" } | SplAsset;
  feeCap: string;
  zatoshis: string;
  nonce: Hex;
  expiry: number;
  pricing: "FIXED_TESTNET_DEMO_NOT_EXCHANGE_RATE";
  profileId: string;
  requestId: string;
};
export type TransferIntent = EvmTransferIntent | SolanaTransferIntent;
export type TransferPolicy = {
  erc20: Partial<Record<NetworkId, readonly Erc20Asset[]>>;
  spl: readonly SplAsset[];
  // Value caps are deliberately small and independent of the demo ZEC price.
  evmNativeCapWei: bigint;
  erc20Cap: bigint;
  solLamportsCap: bigint;
  splCap: bigint;
};
export const DEFAULT_TRANSFER_POLICY: TransferPolicy = Object.freeze({
  erc20: Object.freeze({}),
  spl: Object.freeze([]),
  evmNativeCapWei: 10_000_000_000_000_000n,
  erc20Cap: 1_000_000_000_000_000_000_000_000n,
  solLamportsCap: 10_000_000n,
  splCap: 1_000_000_000_000n,
});
const uint = (value: unknown, label: string) => {
  if (typeof value !== "string" || !/^[1-9]\d{0,77}$/.test(value))
    throw Error(`INVALID_${label}`);
  return BigInt(value);
};
const eq = (a: string, b: string) => getAddress(a) === getAddress(b);
const sameAsset = (a: Erc20Asset | SplAsset, b: Erc20Asset | SplAsset) =>
  a.kind === b.kind &&
  a.decimals === b.decimals &&
  (a.kind === "ERC20"
    ? eq(a.address, (b as Erc20Asset).address)
    : a.mint === (b as SplAsset).mint);
export function validateTransfer(
  intent: TransferIntent,
  policy: TransferPolicy = DEFAULT_TRANSFER_POLICY,
  now = Math.floor(Date.now() / 1000),
): TransferIntent {
  if (
    !intent ||
    intent.version !== 1 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      intent.profileId,
    ) ||
    typeof intent.requestId !== "string" ||
    !intent.requestId ||
    intent.requestId.length > 200 ||
    !/^0x[0-9a-f]{64}$/.test(intent.nonce) ||
    intent.zatoshis !== DEMO_ZATOSHIS ||
    !Number.isSafeInteger(intent.expiry) ||
    intent.expiry <= now ||
    intent.expiry > now + 86400
  )
    throw Error("INVALID_TRANSFER_INTENT");
  if (intent.family === "evm") {
    network(intent.chainId);
    const native = intent.asset.kind === "native";
    if (
      intent.action !==
      (native ? TRANSFER_ACTIONS.EVM_NATIVE : TRANSFER_ACTIONS.EVM_ERC20)
    )
      throw Error("ASSET_ACTION_MISMATCH");
    const amount = uint(intent.amount, "AMOUNT");
    uint(intent.feeCapWei, "FEE_CAP");
    if (BigInt(intent.feeCapWei) > network(intent.chainId).gasBudget)
      throw Error("FEE_CAP");
    if (amount > (native ? policy.evmNativeCapWei : policy.erc20Cap))
      throw Error("AMOUNT_CAP");
    if (
      eq(intent.recipient, zeroAddress) ||
      eq(intent.recipient, intent.relayer)
    )
      throw Error("INVALID_RECIPIENT");
    if (
      !intent.quotation ||
      !/^\d+$/.test(intent.quotation.block) ||
      !/^0x[0-9a-f]{64}$/.test(intent.quotation.calldataHash) ||
      uint(intent.quotation.gas, "GAS") === 0n ||
      BigInt(intent.quotation.feeCapWei) > BigInt(intent.feeCapWei) ||
      !Number.isSafeInteger(intent.quotation.at) ||
      !Number.isSafeInteger(intent.quotation.expires) ||
      intent.quotation.expires <= intent.quotation.at
    )
      throw Error("INVALID_QUOTATION");
    if (intent.asset.kind === "ERC20") {
      const asset = intent.asset,
        allowed = policy.erc20[intent.chainId] ?? [];
      if (!allowed.some((a) => sameAsset(a, asset)))
        throw Error("TOKEN_NOT_ALLOWLISTED");
    }
    return intent;
  }
  if (
    intent.network !== "solana:devnet" ||
    intent.genesis !== GENESIS ||
    intent.action !==
      (intent.asset.kind === "SOL"
        ? TRANSFER_ACTIONS.SOLANA_SOL
        : TRANSFER_ACTIONS.SOLANA_SPL)
  )
    throw Error("WRONG_NETWORK");
  try {
    publicKey(intent.relayer);
    publicKey(intent.recipient);
  } catch {
    throw new SolanaError("INVALID_RECIPIENT");
  }
  if (intent.recipient === intent.relayer)
    throw new SolanaError("INVALID_RECIPIENT");
  const amount = uint(intent.amount, "AMOUNT");
  if (BigInt(intent.feeCap) > 100000n) throw new SolanaError("FEE_CAP");
  if (
    amount >
    (intent.asset.kind === "SOL" ? policy.solLamportsCap : policy.splCap)
  )
    throw new SolanaError("AMOUNT_CAP");
  if (intent.asset.kind === "SPL") {
    try {
      publicKey(intent.asset.mint);
    } catch {
      throw new SolanaError("INVALID_TOKEN");
    }
    const allowed = policy.spl.find(
      (a) => a.mint === (intent.asset as SplAsset).mint,
    );
    if (!allowed || !sameAsset(allowed, intent.asset as SplAsset))
      throw new SolanaError("TOKEN_NOT_ALLOWLISTED");
  }
  return intent;
}
export function transferDigest(intent: TransferIntent) {
  return createHash("sha256").update(JSON.stringify(intent)).digest("hex");
}
export function transferOrderId(intent: TransferIntent): Hex {
  return `0x${createHash("sha256")
    .update(`transfer:${intent.family}:${intent.profileId}:${intent.requestId}`)
    .digest("hex")}`;
}
export function nonce() {
  return `0x${randomBytes(32).toString("hex")}` as Hex;
}
export function transferCapabilities(policy = DEFAULT_TRANSFER_POLICY) {
  return [
    {
      action: TRANSFER_ACTIONS.EVM_NATIVE,
      status: "implemented-testnet-read-only",
      reason:
        "Strict native EVM transfer quoting and receipt verification; execution requires separately provisioned testnet relayer credentials.",
    },
    {
      action: TRANSFER_ACTIONS.EVM_ERC20,
      status: Object.values(policy.erc20).some((v) => v?.length)
        ? "implemented-testnet-read-only"
        : "blocked-configuration",
      reason: Object.values(policy.erc20).some((v) => v?.length)
        ? "Allowlisted ERC-20 transfer quoting and receipt verification."
        : "No ERC-20 contract allowlist is configured.",
    },
    {
      action: TRANSFER_ACTIONS.SOLANA_SOL,
      status: "implemented-testnet",
      reason:
        "Existing bounded devnet SOL delivery adapter with completed settlement evidence.",
    },
    {
      action: TRANSFER_ACTIONS.SOLANA_SPL,
      status: policy.spl.length
        ? "implemented-testnet"
        : "blocked-configuration",
      reason: policy.spl.length
        ? "Existing SPL transaction builder and canonical inspection; delivery policy is allowlisted."
        : "No SPL mint allowlist is configured.",
    },
  ] as const;
}
