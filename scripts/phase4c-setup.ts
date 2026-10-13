// Explicit Base Sepolia setup. Existing seller/provider keys only; no user spending key.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  keccak256,
  parseTransaction,
  encodeFunctionData,
  parseAbi,
  zeroAddress,
  type Hex,
  type Address,
  type TransactionReceipt,
} from "viem";
import { Base } from "../services/execution/base.ts";
import { exclusiveJson, readJson, locked } from "../services/execution/io.ts";
import { providerReserved } from "../services/marketplace/journal.ts";
import { infrastructure, unsignedListing } from "../services/seaport/setup.ts";
import { protocolCheck, verifyListing } from "../services/seaport/adapter.ts";
import {
  PROTOCOL,
  orderTyped,
  type SeaportConfig,
  type Listing,
} from "../services/seaport/protocol.ts";
const root = ".state/phase4c-setup",
  configFile = ".state/seaport-84532-confirmed.json",
  listingFile = ".state/seaport-controlled-listing.json";
let checkpoint = "preflight";
async function main() {
  if (!process.argv.includes("--allow-testnet-broadcast"))
    throw Error("explicit_testnet_flag_required");
  if (providerReserved()) throw Error("provider_reserved");
  for (const file of [".state/orders.sqlite", ".state/purchases.sqlite"]) {
    if (!existsSync(file)) continue;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      if (
        db
          .prepare(
            "SELECT id FROM orders WHERE tx_hash IS NOT NULL AND state NOT IN ('settled','failed') LIMIT 1",
          )
          .get()
      )
        throw Error("unresolved_provider_nonce");
    } finally {
      db.close();
    }
  }
  if (existsSync(configFile) && existsSync(listingFile)) {
    await protocolCheck(readJson<SeaportConfig>(configFile));
    console.log(
      "Existing Seaport setup verified. No replacement listing or transaction created.",
    );
    return;
  }
  const b = new Base(zeroAddress),
    seller = new Base(
      zeroAddress,
      3,
      undefined,
      ".secrets/marketplace-seller/base-sepolia.json",
    );
  await b.chain();
  const user = readJson<{ base: { user: Address } }>("docs/PUBLIC_WALLETS.json")
    .base.user;
  if ([user, b.account.address].includes(seller.account.address))
    throw Error("seller_not_separate");
  const providerBefore = await b.public.getBalance({
      address: b.account.address,
    }),
    sellerBefore = await b.public.getBalance({
      address: seller.account.address,
    });
  if (providerBefore < 3300000000000000n)
    throw Error("setup_budget_insufficient");
  if (!existsSync(root + "/start.json"))
    exclusiveJson(root + "/start.json", {
      at: new Date().toISOString(),
      providerBefore: providerBefore.toString(),
      sellerBefore: sellerBefore.toString(),
    });
  const receipts: any[] = [];
  async function step(
    name: string,
    data: Hex,
    to?: Address,
    value = 0n,
    w = b,
  ): Promise<TransactionReceipt> {
    await w.chain();
    const path = `${root}/${name}.json`,
      done = `${root}/${name}.confirmed.json`;
    checkpoint = `${name}:reconcile`;
    if (existsSync(done)) {
      const saved = readJson<any>(done),
        r = await w.public.getTransactionReceipt({ hash: saved.hash });
      if (
        r.status !== "success" ||
        r.blockHash !== saved.blockHash ||
        (await w.public.getBlock({ blockNumber: r.blockNumber })).hash !==
          r.blockHash
      )
        throw Error("setup_receipt_changed");
      receipts.push(saved);
      return r;
    }
    let saved: { raw: Hex; hash: Hex };
    const prior = existsSync(path);
    if (prior) saved = readJson(path);
    else {
      checkpoint = `${name}:prepare`;
      const fees = await w.public.estimateFeesPerGas(),
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
      const maxFee = gas * fees.maxFeePerGas + 40000000000000n;
      if (
        fees.maxFeePerGas > 100000000n ||
        maxFee > 1000000000000000n ||
        value > 100000000000000n
      )
        throw Error("setup_fee_cap");
      if (
        (await w.public.getBalance({
          address: w.account.address,
          blockTag: "pending",
        })) <
        value + maxFee + 200000000000000n
      )
        throw Error("insufficient_provider_liquidity");
      const nonce = await w.public.getTransactionCount({
        address: w.account.address,
        blockTag: "pending",
      });
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
      saved = { raw, hash: keccak256(raw) };
      exclusiveJson(path, saved);
      console.log(
        JSON.stringify({
          step: name,
          hash: saved.hash,
          estimatedMaximumFeeWei: maxFee.toString(),
          valueWei: value.toString(),
        }),
      );
    }
    if (parseTransaction(saved.raw).chainId !== 84532)
      throw Error("wrong_chain");
    checkpoint = `${name}:receipt`;
    let r = await w.public
      .getTransactionReceipt({ hash: saved.hash })
      .catch(() => null);
    if (!r) {
      if (prior) throw Error("previous_submission_unresolved_preserve_journal");
      checkpoint = `${name}:broadcast`;
      await w.broadcast(saved.raw);
    }
    checkpoint = `${name}:confirm`;
    let stable = 0,
      lastBlock = "";
    for (let attempt = 0; attempt < 60; attempt++) {
      const fresh = await w.public
        .getTransactionReceipt({ hash: saved.hash })
        .catch(() => null);
      if (fresh?.status === "reverted") throw Error("setup_reverted");
      if (fresh) {
        const checked = await Promise.all([
          w.public.getBlockNumber({ cacheTime: 0 }),
          w.public.getBlock({ blockNumber: fresh.blockNumber }),
        ]).catch(() => null);
        if (
          checked &&
          checked[0] - fresh.blockNumber + 1n >= 3n &&
          checked[1].hash === fresh.blockHash &&
          !/^0x0+$/.test(fresh.blockHash)
        ) {
          stable = lastBlock === fresh.blockHash ? stable + 1 : 1;
          lastBlock = fresh.blockHash;
          r = fresh;
          if (stable >= 2) break;
        } else stable = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (!r || stable < 2) throw Error("setup_confirmation_unresolved");
    const publicReceipt = {
      step: name,
      hash: r.transactionHash,
      block: r.blockNumber.toString(),
      blockHash: r.blockHash,
      contract: r.contractAddress,
      gasUsed: r.gasUsed.toString(),
      effectiveGasPrice: r.effectiveGasPrice.toString(),
      l1Fee: (r as any).l1Fee?.toString() ?? null,
    };
    exclusiveJson(done, publicReceipt);
    receipts.push(publicReceipt);
    console.log(
      JSON.stringify({ step: name, confirmed: true, hash: r.transactionHash }),
    );
    return r;
  }

  const c = await infrastructure(
    step,
    b.account.address,
    user,
    seller.account.address,
    b.public,
  );
  const approveData = encodeFunctionData({
    abi: parseAbi(["function approve(address,uint256)"]),
    functionName: "approve",
    args: [PROTOCOL, 1n],
  });
  const approvalGas =
    ((await seller.public.estimateGas({
      account: seller.account.address,
      to: c.nft,
      data: approveData,
    })) *
      12n) /
      10n +
    1n;
  const approvalFees = await seller.public.estimateFeesPerGas();
  if (
    existsSync(root + "/fund-seller.json") ||
    (await seller.public.getBalance({ address: c.seller })) <
      approvalGas * approvalFees.maxFeePerGas + 40000000000000n
  )
    await step("fund-seller", "0x", c.seller, 50000000000000n);
  await step("seller-approval", approveData, c.nft, 0n, seller);
  await protocolCheck(c, b.public);
  if (!existsSync(configFile)) exclusiveJson(configFile, c);
  const unsignedFile = root + "/listing-unsigned.json";
  if (!existsSync(unsignedFile))
    exclusiveJson(unsignedFile, await unsignedListing(c, b.public));
  const listing = readJson<Listing>(unsignedFile);
  if (!existsSync(listingFile))
    exclusiveJson(listingFile, {
      ...listing,
      signature: await seller.account.signTypedData(orderTyped(listing)),
    });
  const signed = readJson<Listing>(listingFile),
    checked = await verifyListing(signed, c, b.public);
  const start = readJson<any>(root + "/start.json");
  mkdirSync("docs/phase4c-evidence/base", { recursive: true });
  writeFileSync(
    "docs/phase4c-evidence/base/deployment.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        live: true,
        config: c,
        receipts,
        listing: {
          source: signed.source,
          orderHash: signed.orderHash,
          parameters: signed.parameters,
          signatureVerified: true,
        },
        providerBefore: start.providerBefore,
        providerAfter: String(
          await b.public.getBalance({ address: c.provider }),
        ),
        sellerBefore: start.sellerBefore,
        sellerAfter: String(await b.public.getBalance({ address: c.seller })),
        estimatedFulfillmentFee: checked.estimatedFee.toString(),
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      setupVerified: true,
      protocol: PROTOCOL,
      collection: c.nft,
      executor: c.executor,
      orderHash: signed.orderHash,
      totalConsideration: checked.total.toString(),
      fee: checked.fee,
    }),
  );
}
locked(".state/service.lock", main).catch((e) => {
  console.error(
    `Seaport setup stopped at ${checkpoint} (${e instanceof Error ? e.name : "error"}). Reconcile original journals; no success assumed.`,
  );
  process.exitCode = 1;
});
