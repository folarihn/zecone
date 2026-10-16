import type { Hex } from "viem";
export type SolanaDeliveryIntent = {
  family: "solana";
  action: "SOLANA_DEVNET_SOL_DELIVERY";
  network: "solana:devnet";
  genesis: string;
  recipient: string;
  relayer: string;
  lamports: string;
  feeCap: string;
  zatoshis: string;
  nonce: Hex;
  expiry: number;
  pricing: "FIXED_TESTNET_DEMO_NOT_EXCHANGE_RATE";
  profileId: string;
  requestId: string;
};
