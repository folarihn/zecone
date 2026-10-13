// Read-only canonical deployment receipt evidence, including actual fees.
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { network } from "../services/evm/networks.ts";
import {
  PurchaseBase,
  type MarketConfig,
} from "../services/marketplace/purchase.ts";
import { readJson } from "../services/execution/io.ts";
const chainId = Number(process.argv[2]),
  n = network(chainId);
if (chainId === 84532) throw Error("Preserve Phase 3 Base evidence");
const c = readJson<MarketConfig>(n.deploymentFile),
  b = new PurchaseBase(c);
await b.check();
const steps = [];
let total = 0n;
for (const file of readdirSync(`.state/phase4a-setup/${chainId}`).filter((f) =>
  f.endsWith(".confirmed.json"),
)) {
  const saved = readJson<any>(`.state/phase4a-setup/${chainId}/${file}`),
    r = await b.public.getTransactionReceipt({ hash: saved.hash });
  const [canonical, head] = await Promise.all([
    b.public.getBlock({ blockNumber: r.blockNumber }),
    b.public.getBlockNumber(),
  ]);
  assert.equal(r.status, "success");
  assert.equal(saved.blockHash, r.blockHash);
  assert.equal(canonical.hash, r.blockHash);
  assert.ok(head - r.blockNumber + 1n >= BigInt(n.confirmations));
  const actualFee = r.gasUsed * r.effectiveGasPrice;
  total += actualFee;
  steps.push({
    step: file.replace(".confirmed.json", ""),
    ...saved,
    actualFeeWei: actualFee.toString(),
    confirmations: (head - r.blockNumber + 1n).toString(),
  });
}
assert.equal(steps.length, 8);
const result = {
  at: new Date().toISOString(),
  verified: true,
  chainId,
  contracts: c,
  steps,
  totalSetupFeesWei: total.toString(),
  sellerFundingWei: "1000000000000000",
  notice:
    "Seller funding is a transfer between project accounts; it is not a gas fee.",
};
mkdirSync(`docs/phase4a-evidence/${chainId}`, { recursive: true });
writeFileSync(
  `docs/phase4a-evidence/${chainId}/deployment.json`,
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result));
