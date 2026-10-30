// Read-only RPC estimates. The state override models constructor dependency code;
// it is not a deployment and never substitutes for a real receipt.
import { mkdirSync, writeFileSync } from "node:fs";
import {
  createPublicClient,
  encodeDeployData,
  getContractAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import { chainFor, network } from "../services/evm/networks.ts";
import { readJson } from "../services/execution/io.ts";
const m = readJson<{
  base: { relayer: Address };
  marketplace: { seller: Address };
}>("docs/PUBLIC_WALLETS.json");
for (const id of [11155111, 46630]) {
  const n = network(id),
    c = createPublicClient({ chain: chainFor(id), transport: http(n.rpc) });
  if ((await c.getChainId()) !== id) throw Error("Wrong testnet");
  const [balance, nonce, fees] = await Promise.all([
    c.getBalance({ address: m.base.relayer }),
    c.getTransactionCount({ address: m.base.relayer, blockTag: "pending" }),
    c.estimateFeesPerGas(),
  ]);
  const market = getContractAddress({
    from: m.base.relayer,
    nonce: BigInt(nonce),
  });
  const marketArtifact = readJson<any>(
    "out/TestMarketplace.sol/TestMarketplace.json",
  );
  const estimates = [];
  for (const [name, args] of [
    ["TestMarketplace", []],
    ["MarketTestNFT", [m.marketplace.seller]],
    ["ZecOneMultichainExecutor", [m.base.relayer, market]],
  ] as const) {
    const a = readJson<any>(`out/${name}.sol/${name}.json`);
    const gas = await c.estimateGas({
      account: m.base.relayer,
      nonce: nonce + estimates.length,
      data: encodeDeployData({ abi: a.abi, bytecode: a.bytecode.object, args }),
      ...(name === "ZecOneMultichainExecutor"
        ? {
            stateOverride: [
              { address: m.base.relayer, nonce: nonce + 2 },
              {
                address: market,
                code: marketArtifact.deployedBytecode.object as Hex,
              },
            ],
          }
        : {}),
    });
    estimates.push({
      step: name,
      gas: gas.toString(),
      gasLimit: ((gas * 12n) / 10n + 1n).toString(),
    });
  }
  // Reserve seller funding, one approved purchase budget+price, and 100k gas for funding.
  // Seller's four calls must fit its separate 0.001 ETH funding; each is estimated before signing.
  const deploymentCeiling = estimates.reduce(
    (s, x) => s + BigInt(x.gasLimit) * fees.maxFeePerGas,
    0n,
  );
  const required =
    deploymentCeiling +
    100000n * fees.maxFeePerGas +
    1000000000000000n +
    n.gasBudget +
    100000000000000n;
  const result = {
    at: new Date().toISOString(),
    chainId: id,
    balanceWei: balance.toString(),
    maxFeePerGas: fees.maxFeePerGas.toString(),
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
    estimates,
    deploymentCeilingWei: deploymentCeiling.toString(),
    requiredWithReservesWei: required.toString(),
    sufficient: balance >= required,
    method:
      "RPC eth_estimateGas; executor constructor dependency uses explicit code state override; live follow-up calls are estimated separately before signing",
  };
  mkdirSync("docs/phase4a-evidence", { recursive: true });
  writeFileSync(
    `docs/phase4a-evidence/costs-${id}.json`,
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
  if (!result.sufficient || fees.maxFeePerGas > n.maxFee) process.exitCode = 1;
}
