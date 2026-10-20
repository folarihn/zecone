// No signing credentials, source-chain identifiers, or history queries.
import { CpmmPolicy } from "../solana/cpmm.ts";
import { Devnet } from "../solana/network.ts";
import { ata } from "../solana/transactions.ts";
import type { ReviewReads } from "./settlement-review.ts";
export function settlementReads(net = new Devnet()): ReviewReads {
  const policy = new CpmmPolicy(net);
  return {
    check: async () => {
      await net.health();
    },
    balance: (address) => net.balance(address),
    tokenBalance: async (address, mint) => {
      const account: any = await net.account(await ata(address, mint));
      return BigInt(account?.data?.parsed?.info?.tokenAmount?.amount ?? 0);
    },
    terms: () => policy.terms(),
  };
}
