// Explicit Base Sepolia deployment only. No user key is read. Signed bytes persist before any broadcast.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  keccak256,
  parseTransaction,
  zeroAddress,
  type Hex,
  type Address,
  type TransactionReceipt,
} from "viem";
import { Base } from "../services/execution/base.ts";
import { exclusiveJson, readJson, locked } from "../services/execution/io.ts";
import { providerReserved } from "../services/marketplace/journal.ts";
import { infrastructure, SEED_ETH } from "../services/swaps/setup.ts";
import { SwapBase, inspect } from "../services/swaps/adapter.ts";
import { type SwapConfig, tokenAbi } from "../services/swaps/intent.ts";
const root = ".state/phase4b-setup",
  configFile = ".state/swap-84532-confirmed.json";
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
  if (existsSync(configFile)) {
    await new SwapBase(readJson<SwapConfig>(configFile)).check();
    console.log(
      "Existing swap infrastructure verified; no setup transactions sent.",
    );
    return;
  }
  const b = new Base(zeroAddress);
  await b.chain();
  const user = readJson<{ base: { user: Address } }>("docs/PUBLIC_WALLETS.json")
    .base.user;
  const balance = await b.public.getBalance({ address: b.account.address });
  const startFile = `${root}/start.json`;
  if (!existsSync(startFile)) {
    let before = balance,
      source = "pre-deployment RPC balance";
    if (existsSync(`${root}/WETH9.json`)) {
      const saved = readJson<{ hash: Hex }>(`${root}/WETH9.json`),
        r = await b.public.getTransactionReceipt({ hash: saved.hash });
      before = await b.public.getBalance({
        address: b.account.address,
        blockNumber: r.blockNumber - 1n,
      });
      source = `historical RPC balance at block ${r.blockNumber - 1n}, before persisted first deployment`;
    }
    exclusiveJson(startFile, {
      at: new Date().toISOString(),
      providerBefore: before.toString(),
      source,
    });
  }
  // Seven setup transactions, each capped at 0.001 ETH including a conservative L1 reserve;
  // 0.005 ETH seed plus 0.0002 ETH reserved for one purchase. This is a ceiling, not an estimate.
  if (balance < 7200000000000000n + SEED_ETH)
    throw Error(
      "setup_budget_insufficient: need at most 0.0122 Base Sepolia ETH before starting",
    );
  const receipts: any[] = [];
  async function step(
    name: string,
    data: Hex,
    to?: Address,
    value = 0n,
  ): Promise<TransactionReceipt> {
    await b.chain();
    const path = `${root}/${name}.json`,
      done = `${root}/${name}.confirmed.json`;
    checkpoint = `${name}:reconcile`;
    if (existsSync(done)) {
      const saved = readJson<any>(done),
        r = await b.public.getTransactionReceipt({ hash: saved.hash });
      if (
        r.status !== "success" ||
        r.blockHash !== saved.blockHash ||
        (await b.public.getBlock({ blockNumber: r.blockNumber })).hash !==
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
      const fees = await b.public.estimateFeesPerGas(),
        gas =
          ((await b.public.estimateGas({
            account: b.account.address,
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
        value > SEED_ETH
      )
        throw Error("setup_fee_cap");
      if (
        (await b.public.getBalance({
          address: b.account.address,
          blockTag: "pending",
        })) <
        value + maxFee + 200000000000000n
      )
        throw Error("insufficient_provider_liquidity");
      const nonce = await b.public.getTransactionCount({
        address: b.account.address,
        blockTag: "pending",
      });
      const raw = await b.wallet.signTransaction({
        account: b.account,
        chain: b.wallet.chain,
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
    let r = await b.public
      .getTransactionReceipt({ hash: saved.hash })
      .catch(() => null);
    if (!r) {
      if (prior) throw Error("previous_submission_unresolved_preserve_journal");
      checkpoint = `${name}:broadcast`;
      await b.broadcast(saved.raw);
    }
    checkpoint = `${name}:confirm`;
    let stable = 0,
      lastBlock = "";
    for (let attempt = 0; attempt < 60; attempt++) {
      const fresh = await b.public
        .getTransactionReceipt({ hash: saved.hash })
        .catch(() => null);
      if (fresh?.status === "reverted") throw Error("setup_reverted");
      if (fresh) {
        const checked = await Promise.all([
          b.public.getBlockNumber({ cacheTime: 0 }),
          b.public.getBlock({ blockNumber: fresh.blockNumber }),
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
  const c = await infrastructure(step, b.account.address, user, b.public);
  checkpoint = "infrastructure:verify";
  await new SwapBase(c).check();
  exclusiveJson(configFile, c);
  const s = await inspect(c, b.public),
    after = await b.public.getBalance({ address: c.provider });
  mkdirSync("docs/phase4b-evidence/base", { recursive: true });
  const start = readJson<{ providerBefore: string; source: string }>(startFile);
  writeFileSync(
    "docs/phase4b-evidence/base/deployment.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        live: true,
        config: c,
        receipts,
        initialReserves: {
          native: s.reserveIn.toString(),
          token: s.reserveOut.toString(),
        },
        providerBefore: start.providerBefore,
        startingBalanceSource: start.source,
        providerAfter: after.toString(),
        providerSpent: (BigInt(start.providerBefore) - after).toString(),
        seedNative: SEED_ETH.toString(),
        userTokenBalance: (
          await b.public.readContract({
            address: c.token,
            abi: tokenAbi,
            functionName: "balanceOf",
            args: [user],
          })
        ).toString(),
      },
      null,
      2,
    ),
  );
  console.log(
    "Verified Base Sepolia AMM setup complete. No user Zcash payment sent.",
  );
}
locked(".state/service.lock", main).catch((e) => {
  console.error(
    `Swap setup stopped at ${checkpoint} (${e instanceof Error ? e.name : "error"}). No success assumed; inspect persisted hashes and balances. Never delete the setup journal.`,
  );
  process.exitCode = 1;
});
