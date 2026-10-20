// No signing credentials, source-chain identifiers, or history queries.
import { CpmmPolicy } from "../solana/cpmm.ts";
import { Devnet } from "../solana/network.ts";
import type { ReviewReads } from "./settlement-review.ts";
export function settlementReads(net = new Devnet()): ReviewReads {
  const policy = new CpmmPolicy(net);
  return {
    check: async () => {
      await net.health();
    },
    balance: (address) => net.balance(address),
    terms: () => policy.terms(),
  };
}
