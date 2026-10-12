// Explicit testnet setup. Every signed transaction is durable before submission.
// Separate seller, provider, and recipient keys; no user key is loaded here.
import { existsSync } from "node:fs";
import { generatePrivateKey } from "viem/accounts";
import {
  encodeDeployData,
  encodeFunctionData,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { Base } from "../services/execution/base.ts";
import { exclusiveJson, readJson, locked } from "../services/execution/io.ts";
import { providerReserved } from "../services/marketplace/journal.ts";
import {
  marketAbi,
  nftAbi,
  PurchaseBase,
  type MarketConfig,
} from "../services/marketplace/purchase.ts";
async function main() {
  if (!process.argv.includes("--allow-testnet-broadcast"))
    throw Error("Explicit testnet setup flag required");
  if (providerReserved())
    throw Error("Existing purchase reservation must be reconciled first");
  if (existsSync(".state/marketplace-confirmed.json")) {
    await new PurchaseBase(
      readJson<MarketConfig>(".state/marketplace-confirmed.json"),
    ).check();
    console.log(
      "Existing marketplace deployment verified; no setup transactions sent.",
    );
    return;
  }
  const key = ".secrets/marketplace-seller/base-sepolia.json";
  if (!existsSync(key))
    exclusiveJson(key, {
      network: "base-sepolia",
      privateKey: generatePrivateKey(),
    });
  const provider = new Base(zeroAddress),
    seller = new Base(zeroAddress, 3, undefined, key);
  await provider.chain();
  const user = readJson<{ base: { user: Address } }>("docs/PUBLIC_WALLETS.json")
    .base.user;
  if ([provider.account.address, user].includes(seller.account.address))
    throw Error("Seller must be separate");
  async function step(
    name: string,
    w: Base,
    data: Hex,
    to?: Address,
    value = 0n,
  ) {
    const path = `.state/phase3-setup/${name}.json`,
      done = `.state/phase3-setup/${name}.confirmed.json`;
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
        gas * fees.maxFeePerGas > 500000000000000n ||
        value > 1000000000000000n
      )
        throw Error("Setup transaction exceeds test budget");
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
        confirmations: 3,
        timeout: 180000,
      });
    } else
      receipt = await w.public.waitForTransactionReceipt({
        hash: saved.hash,
        confirmations: 3,
        timeout: 180000,
      });
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
      await deploy("ZecOnePurchaseExecutor", [
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
  const expiryPath = ".state/phase3-setup/listing-expiry.json";
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
  exclusiveJson(".state/marketplace-confirmed.json", c);
  console.log(JSON.stringify(c));
}
locked(".state/service.lock", main).catch(() => {
  console.error(
    "Marketplace setup stopped. No success is assumed. Preserve .state/phase3-setup and reconcile its exact hashes before retrying.",
  );
  process.exitCode = 1;
});
