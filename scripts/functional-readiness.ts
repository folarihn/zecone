// Public chain reads only. Never instantiates a wallet, order store or signer.
import { mkdirSync, writeFileSync } from "node:fs";
import { mainnetIdentity } from "../services/wallet/mainnet-readiness.ts";
import { Devnet } from "../services/solana/network.ts";
import { CpmmPolicy } from "../services/solana/cpmm.ts";
const out: Record<string, unknown> = {
  at: new Date().toISOString(),
  newPayment: false,
  signerAccess: false,
  broadcast: false,
};
const devnet = new Devnet();
try {
  await devnet.health();
  const t = await new CpmmPolicy(devnet).terms();
  out.solana = {
    network: "devnet",
    poolValidated: true,
    input: t.amountIn,
    expectedOut: t.expectedOut,
    minimumOut: t.minimumOut,
    slippageBps: t.slippageBps,
    confidence: "PRIMARY_ONLY",
    scope: "PUBLIC_POOL_ONLY",
    transactionSimulated: false,
  };
} catch {
  out.solana = {
    network: "devnet",
    poolValidated: false,
    error: "PUBLIC_READ_UNAVAILABLE",
  };
}
out.base = await mainnetIdentity("base", {
  endpoint: "https://mainnet.base.org",
  operator: "base-public",
});
out.solanaMainnet = await mainnetIdentity("solana", {
  endpoint: "https://api.mainnet-beta.solana.com",
  operator: "solana-public",
});
// Ethereum requires operator configuration; no third-party service is invented.
out.ethereum = { status: "NOT_CONFIGURED", spendingEnabled: false };
out.zcash = {
  status: "MAINNET_WATCH_BACKEND_NOT_IMPLEMENTED",
  spendingEnabled: false,
};
mkdirSync("docs/functional-evidence", { recursive: true });
writeFileSync(
  "docs/functional-evidence/public-readiness.json",
  JSON.stringify(out, null, 2),
);
console.log(JSON.stringify(out));
