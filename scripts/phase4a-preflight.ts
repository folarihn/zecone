// Read-only balance and RPC check for the configured testnets. Never signs or broadcasts.
import { mkdirSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { adapterFor } from "../services/evm/adapter.ts";
import { NETWORK_IDS, network } from "../services/evm/networks.ts";
import { readJson } from "../services/execution/io.ts";
import type { Address } from "viem";

const manifest = readJson<{ base: { user: Address; relayer: Address }; marketplace: { seller: Address } }>("docs/PUBLIC_WALLETS.json");
const exec = promisify(execFile);
const checks = await Promise.all(NETWORK_IDS.map(async id => {
  const config = network(id), adapter = adapterFor(id);
  try {
    const head = await adapter.health();
    const [user, provider, seller, gasPrice] = await Promise.all([
      adapter.client.getBalance({ address: manifest.base.user }),
      adapter.client.getBalance({ address: manifest.base.relayer }),
      adapter.client.getBalance({ address: manifest.marketplace.seller }),
      adapter.client.getGasPrice(),
    ]);
    return { name: config.name, chainId: id, rpc: config.rpc, explorer: config.explorer, checkedAt: new Date().toISOString(), head, gasPrice: gasPrice.toString(), user: { address: manifest.base.user, wei: user.toString() }, provider: { address: manifest.base.relayer, wei: provider.toString() }, seller: { address: manifest.marketplace.seller, wei: seller.toString() }, status: "available" as const };
  } catch (error) {
    return { name: config.name, chainId: id, rpc: config.rpc, explorer: config.explorer, checkedAt: new Date().toISOString(), status: "unavailable" as const, error: error instanceof Error ? error.message : "rpc_check_failed" };
  }
}));
let zcash: unknown;
try {
  const { stdout } = await exec(resolve("target/debug/zecone-zcash.exe"), ["--wallet", resolve(".secrets/user/zcash"), "summary"], { windowsHide: true, timeout: 600000, maxBuffer: 16000000 });
  const summary = JSON.parse(stdout);
  zcash = { checkedAt: new Date().toISOString(), network: "Zcash Testnet", tip: summary.tip, scanned: summary.scanned, spendableZatoshis: summary.spendableZatoshis, totalZatoshis: summary.totalZatoshis };
} catch {
  zcash = { checkedAt: new Date().toISOString(), status: "unavailable" };
}
mkdirSync("docs/phase4a-evidence", { recursive: true });
const evidence = { checkedAt: new Date().toISOString(), zcash, networks: checks };
writeFileSync("docs/phase4a-evidence/network-preflight.json", JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
if (checks.some(c => c.status !== "available")) process.exitCode = 2;
