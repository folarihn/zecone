// Real devnet reads and unsigned simulation only. Not payment authorization.
import { createSolanaRpc } from "@solana/kit";
import { readFileSync, writeFileSync } from "node:fs";
import { Devnet, GENESIS, DEVNET, json } from "../services/solana/network.ts";
import { CpmmPolicy, POOL, OUTPUT, WSOL } from "../services/solana/cpmm.ts";
const counts: Record<string, number> = {};
const base = createSolanaRpc(DEVNET);
const rpc = new Proxy(base, {
  get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => {
      counts[String(key)] = (counts[String(key)] ?? 0) + 1;
      return value(...args);
    };
  },
});
const net = new Devnet(rpc),
  policy = new CpmmPolicy(net),
  p = JSON.parse(readFileSync(".state/phase7c/profile.json", "utf8"));
// Use the previously funded relayer only for this UNSIGNED route rehearsal.
// Fresh encrypted relayer remains the immutable checkout's source.
const prior = JSON.parse(readFileSync(".state/phase7b/profile.json", "utf8"));
const terms = await policy.terms();
const prepared = await policy.prepare({
  family: "solana",
  action: "SOLANA_DEVNET_SPL_SWAP",
  swap: terms,
  network: "solana:devnet",
  genesis: GENESIS,
  relayer: prior.relayer,
  recipient: p.recipient,
  lamports: "1000000",
  feeCap: "10000",
  zatoshis: "100000",
  nonce: `0x${"0".repeat(64)}`,
  expiry: Math.floor(Date.now() / 1000) + 90,
  pricing: "FIXED_TESTNET_DEMO_NOT_EXCHANGE_RATE",
  profileId: "unsigned-rehearsal-only",
  requestId: "not-payment-evidence",
});
writeFileSync(".state/phase7c/unsigned-rehearsal.json", json(prepared), {
  mode: 0o600,
});
const report = {
  at: new Date().toISOString(),
  network: "solana:devnet",
  genesis: GENESIS,
  pool: POOL,
  inputMint: WSOL,
  outputMint: OUTPUT,
  amountIn: terms.amountIn,
  expectedOut: terms.expectedOut,
  minimumOut: terms.minimumOut,
  slippageBps: terms.slippageBps,
  estimatedFeeLamports: prepared.fee,
  simulation: prepared.simulation,
  rpcMethodCounts: counts,
  providerObserves: [
    "client IP and timing",
    "fixed public pool/mint/program accounts",
    "selected relayer and selected recipient ATA",
    "full unsigned public transaction instructions",
  ],
  sentToDexAPI: false,
  viewingOrSpendingKeysSent: false,
  zcashIdentifiersSent: false,
  signatureGenerated: false,
  broadcast: false,
  isPaymentAuthorization: false,
  state: prepared.simulation.err
    ? "SIMULATION_FAILED"
    : "UNSIGNED_SIMULATION_SUCCEEDED",
};
writeFileSync("docs/phase7c-evidence/real-route-rehearsal.json", json(report));
console.log(json(report));
if (prepared.simulation.err) process.exitCode = 1;
