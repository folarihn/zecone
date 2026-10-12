import { existsSync } from "node:fs";
import { encodeDeployData, zeroAddress, type Address, type Hex } from "viem";
import { Base } from "../services/execution/base.ts";
import {
  ActionBase,
  verifyAction,
  type ActionIntent,
} from "../services/execution/action.ts";
import {
  exclusiveJson,
  readJson,
  loadAccount,
  locked,
} from "../services/execution/io.ts";
import { Zcash } from "../services/execution/zcash.ts";
import { Store } from "../services/execution/store.ts";
import { providerReserved } from "../services/marketplace/journal.ts";
async function main() {
  const command = process.argv[2];
  if (command === "deploy") {
    if (providerReserved())
      throw Error("Provider funds are reserved for a marketplace purchase");
    if (!process.argv.includes("--allow-testnet-broadcast"))
      throw Error("Explicit testnet deployment flag required");
    if (existsSync(".state/actions-confirmed.json")) {
      console.log(JSON.stringify(readJson(".state/actions-confirmed.json")));
      return;
    }
    const b = new Base(zeroAddress);
    await b.chain();
    let tx: { raw: Hex; hash: Hex };
    if (existsSync(".state/actions-pending.json"))
      tx = readJson(".state/actions-pending.json");
    else {
      const artifact = readJson<any>(
        "out/ZecOneActions.sol/ZecOneActions.json",
      );
      tx = await b.signed(
        encodeDeployData({
          abi: artifact.abi,
          bytecode: artifact.bytecode.object,
          args: [b.account.address],
        }),
      );
      exclusiveJson(".state/actions-pending.json", tx);
    }
    const old = await b.public
      .getTransactionReceipt({ hash: tx.hash })
      .catch(() => null);
    if (!old) await b.broadcast(tx.raw);
    const receipt = await b.public.waitForTransactionReceipt({
      hash: tx.hash,
      confirmations: 3,
      timeout: 180000,
    });
    if (receipt.status !== "success" || !receipt.contractAddress)
      throw Error("Deployment failed");
    const config = {
      contract: receipt.contractAddress,
      deploymentHash: tx.hash,
    };
    await new ActionBase(config.contract).check();
    exclusiveJson(".state/actions-confirmed.json", config);
    console.log(JSON.stringify(config));
    return;
  }
  if (command === "create") {
    const i = readJson<ActionIntent>(process.argv[3]),
      config = readJson<{ contract: Address }>(".state/actions-confirmed.json");
    const id = await verifyAction(
      i,
      config.contract,
      loadAccount(".secrets/relayer/base-sepolia.json").address,
      Math.floor(Date.now() / 1000),
    );
    const store = new Store(".state/orders.sqlite");
    try {
      const old = store.get(id);
      if (old) {
        console.log(JSON.stringify({ id: old.id }));
        return;
      }
      const receiver = await new Zcash().allocate(id);
      const o = store.create(
        id,
        i,
        receiver.account,
        receiver.address,
        Math.floor(Date.now() / 1000),
      );
      console.log(JSON.stringify({ id: o.id }));
    } finally {
      store.close();
    }
    return;
  }
  throw Error("Use deploy or create");
}
locked(".state/service.lock", main).catch(() => {
  console.error(
    "Action operation failed; preserve state and inspect recovery before retry.",
  );
  process.exitCode = 1;
});
