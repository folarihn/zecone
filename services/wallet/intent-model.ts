// Shared presentation types only; no backend imports or authority.
export type Operation =
  | "erc20-transfer"
  | "erc20-approval"
  | "nft-mint"
  | "nft-purchase"
  | "token-swap"
  | "sol-delivery"
  | "raydium-swap"
  | "unknown";
export type Intent = {
  version: 1;
  id: string;
  requestDigest: string;
  origin: string;
  destination: { family: "evm" | "solana"; chainId: string };
  operation: Operation;
  target: string;
  recipient: string | null;
  input: { asset: string; amount: string; decimals: number | null };
  output: {
    asset: string | null;
    expected: string | null;
    minimum: string | null;
  };
  maximumCost: { input: string; networkFee: string | null; rent: string };
  networkRequirements: {
    simulation: "required";
    status: "passed" | "unavailable";
    gas: string | null;
  };
  expires: number;
  risk: "unsupported" | "review-required";
  approval: "pending" | "consented-preview-only" | "cancelled";
  support: {
    adapter: string | null;
    recognized: boolean;
    executionMode: "preview-only";
    executable: false;
    reason: string;
  };
  disclosures: readonly string[];
};
