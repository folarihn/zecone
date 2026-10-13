import { network } from "../services/evm/networks.ts";
// Explicit testnet setup. Every signed transaction is durable before submission.
// Separate seller, provider, and recipient keys; no user key is loaded here.
import { existsSync } from "node:fs";
import {
  encodeDeployData,
  encodeFunctionData,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { exclusiveJson, readJson, locked } from "../services/execution/io.ts";
import { providerReserved } from "../services/marketplace/journal.ts";
import {
  marketAbi,
  nftAbi,
  PurchaseBase,
  type MarketConfig,
} from "../services/marketplace/purchase.ts";
async function main() {
  const chainId = Number(process.argv[2]), policy = network(chainId);
  if (chainId === 84532) throw Error("Use preserved Phase 3 setup for Base");
  const root = `.state/phase4a-setup/${chainId}`;
  const configFile = policy.deploymentFile;
  if (!process.argv.includes("--allow-testnet-broadcast"))
    throw Error("Explicit testnet setup flag required");
  if (providerReserved())
    throw Error("Existing purchase reservation must be reconciled first");
  if (existsSync(configFile)) {
    await new PurchaseBase(
      readJson<MarketConfig>(configFile),
    ).check();
    console.log(
      "Existing marketplace deployment verified; no setup transactions sent.",
    );
    return;
  }
  const key = ".secrets/marketplace-seller/base-sepolia.json";
  if (!existsSync(key)) throw Error("Existing separate seller key required");
  const placeholder = { chainId, executor: zeroAddress, marketplace: zeroAddress, nft: zeroAddress, origin: "http://127.0.0.1:4322" };
  const provider = new PurchaseBase(placeholder), seller = new PurchaseBase(placeholder, policy.confirmations, policy.rpc, key);
  await provider.chain();
  const user = readJson<{ base: { user: Address } }>("docs/PUBLIC_WALLETS.json")
    .base.user;
  if ([provider.account.address, user].includes(seller.account.address))
    throw Error("Seller must be separate");
  async function step(
    name: string,
    w: PurchaseBase,
    data: Hex,
    to?: Address,
    value = 0n,
  ) {
    const path = `${root}/${name}.json`,
      done = `${root}/${name}.confirmed.json`;
    if (existsSync(done)) {
      const saved = readJson<{ hash: Hex; blockHash: Hex }>(done),
        r = await w.public.getTransactionReceipt({ hash: saved.hash });
      if (
        r.status !== "success" ||
        r.blockHash !== saved.blockHash ||
        (await w.public.getBlock({ blockNumber: r.blockNumber })).hash !==
          r.blockHash
      )
        throw Error("Setup receipt changed");
      return r;
    }
    let saved: { raw: Hex; hash: Hex };
    const previous = existsSync(path);
    if (previous) saved = readJson(path);
    else {
      const nonce = await w.public.getTransactionCount({
          address: w.account.address,
          blockTag: "pending",
        }),
        fees = await w.public.estimateFeesPerGas(),
        gas =
          ((await w.public.estimateGas({
            account: w.account.address,
            to,
            data,
            value,
          })) *
            12n) /
            10n +
          1n;
      if (
        gas * fees.maxFeePerGas > 5000000000000000n || fees.maxFeePerGas > policy.maxFee ||
        value > 1000000000000000n
      )
        throw Error("Setup transaction exceeds test budget");
      const balance = await w.public.getBalance({address:w.account.address,blockTag:"pending"});
      const purchaseReserve = w === provider ? policy.gasBudget + 100000000000000n : 0n;
      if (balance < value + gas * fees.maxFeePerGas + purchaseReserve)
        throw Error("Insufficient balance for estimated setup cost and purchase reserve");
      console.log(JSON.stringify({step:name,chainId,estimatedGasLimit:gas.toString(),maxFeePerGas:fees.maxFeePerGas.toString(),maximumFeeWei:(gas*fees.maxFeePerGas).toString(),valueWei:value.toString(),balanceWei:balance.toString()}));
      const raw = await w.wallet.signTransaction({
        account: w.account,
        chain: w.wallet.chain,
        to,
        data,
        value,
        nonce,
        gas,
        ...fees,
      });
      saved = { raw, hash: (await import("viem")).keccak256(raw) };
      exclusiveJson(path, {
        ...saved,
        from: w.account.address,
        to: to ?? null,
        value: value.toString(),
        created: Date.now(),
      });
    }
    let receipt = await w.public
      .getTransactionReceipt({ hash: saved.hash })
      .catch(() => null);
    if (!receipt) {
      // An interrupted previous submission is never replaced or blindly rebroadcast.
      if (previous) {
        const pending = await w.public
          .getTransaction({ hash: saved.hash })
          .catch(() => null);
        if (!pending)
          throw Error(
            "Unknown prior submission; operator reconciliation required",
          );
      } else if ((await w.broadcast(saved.raw)) !== saved.hash)
        throw Error("Submission hash mismatch");
      receipt = await w.public.waitForTransactionReceipt({
        hash: saved.hash,
        confirmations: policy.confirmations,
        timeout: 600000,
      });
    } else
      receipt = await w.public.waitForTransactionReceipt({
        hash: saved.hash,
        confirmations: policy.confirmations,
        timeout: 600000,
      });
    // Some sequencer responses carry a placeholder block hash. Always refetch
    // and compare with the canonical block before persisting confirmation.
    receipt = await w.public.getTransactionReceipt({ hash: saved.hash });
    const [head, canonical] = await Promise.all([
      w.public.getBlockNumber(),
      w.public.getBlock({ blockNumber: receipt.blockNumber }),
    ]);
    if (
      head - receipt.blockNumber + 1n < BigInt(policy.confirmations) ||
      receipt.blockHash === `0x${"0".repeat(64)}` ||
      canonical.hash !== receipt.blockHash
    )
      throw Error(
        "Setup confirmation is not canonical yet; preserve exact hash",
      );
    if (receipt.status !== "success")
      throw Error("Setup reverted; preserve evidence");
    exclusiveJson(done, {
      hash: saved.hash,
      block: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
      contract: receipt.contractAddress,
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.effectiveGasPrice.toString(),
    });
    console.log(
      JSON.stringify({
        step: name,
        hash: saved.hash,
        block: receipt.blockNumber.toString(),
      }),
    );
    return receipt;
  }
  async function deploy(name: string, args: unknown[] = []) {
    const a = readJson<any>(`out/${name}.sol/${name}.json`);
    return step(
      name,
      provider,
      encodeDeployData({ abi: a.abi, bytecode: a.bytecode.object, args }),
    );
  }
  const m = await deploy("TestMarketplace"),
    marketplace = m.contractAddress!,
    nft = (await deploy("MarketTestNFT", [seller.account.address]))
      .contractAddress!,
    executor = (
      await deploy("ZecOneMultichainExecutor", [
        provider.account.address,
        marketplace,
      ])
    ).contractAddress!;
  await step(
    "seller-gas",
    provider,
    "0x",
    seller.account.address,
    1000000000000000n,
  );
  await step(
    "seller-approval",
    seller,
    encodeFunctionData({
      abi: nftAbi,
      functionName: "setApprovalForAll",
      args: [marketplace, true],
    }),
    nft,
  );
  const expiryPath = `${root}/listing-expiry.json`;
  if (!existsSync(expiryPath))
    exclusiveJson(expiryPath, {
      expiry: Math.floor(Date.now() / 1000) + 86400,
    });
  const { expiry } = readJson<{ expiry: number }>(expiryPath);
  for (const id of [1n, 2n, 3n])
    await step(
      `listing-${id}`,
      seller,
      encodeFunctionData({
        abi: marketAbi,
        functionName: "list",
        args: [nft, id, 100000000000000n * id, BigInt(expiry)],
      }),
      marketplace,
    );
  const c = {
    chainId,
    marketplace,
    nft,
    executor,
    origin: "http://127.0.0.1:4322",
    deploymentBlock: m.blockNumber.toString(),
    seller: seller.account.address,
    provider: provider.account.address,
    user,
    listingExpiry: expiry,
  };
  await new PurchaseBase(c).check();
  exclusiveJson(configFile, c);
  console.log(JSON.stringify(c));
}
locked(".state/service.lock", main).catch(() => {
  console.error(
    "Marketplace setup stopped. No success is assumed. Preserve .state/phase4a-setup and reconcile its exact hashes before retrying.",
  );
  process.exitCode = 1;
});
