import type { Hex } from "viem";
export type SolanaDeliveryIntent = {
  family: "solana";
  action: "SOLANA_DEVNET_SOL_DELIVERY" | "SOLANA_DEVNET_SPL_SWAP";
  swap?: SwapTerms;
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

export type SwapTerms = {
  program: "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb";
  pool: "12aukygfT6qr5KH9MeeVYb4Y9rsmTzAVzUn633BRCfd";
  inputMint: "So11111111111111111111111111111111111111112";
  outputMint: "2j76mnkJEBxbYv8T9c76PbsGzf5XuhpRoK1kwwTg9MpY";
  inputDecimals: 9;
  outputDecimals: 6;
  amountIn: "1000000";
  slippageBps: 100;
  expectedOut: string;
  minimumOut: string;
  programHash: "180aa094c9dc9895f134cb3949097ac3d9a3bb0480b069f7f2859e6ef97fc336";
};
