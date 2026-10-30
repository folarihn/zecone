import type { Address, Hex } from "viem";
export type TransferIntentAction =
  | "EVM_NATIVE_TRANSFER"
  | "EVM_ERC20_TRANSFER"
  | "SOLANA_DEVNET_SOL_DELIVERY"
  | "SOLANA_DEVNET_SPL_DELIVERY";
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
  fundingBinding?: string;
  source?: {
    id: string;
    origin: string;
    account: string;
    digest: string;
    scope: string;
  };
  family: "evm";
  action: "EVM_NATIVE_TRANSFER" | "EVM_ERC20_TRANSFER";
  version: 1;
  chainId: 84532 | 11155111 | 46630;
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
  action: "SOLANA_DEVNET_SOL_DELIVERY" | "SOLANA_DEVNET_SPL_DELIVERY";
  version: 1;
  network: "solana:devnet";
  genesis: string;
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
  erc20: Partial<Record<84532 | 11155111 | 46630, readonly Erc20Asset[]>>;
  spl: readonly SplAsset[];
  evmNativeCapWei: bigint;
  erc20Cap: bigint;
  solLamportsCap: bigint;
  splCap: bigint;
};
