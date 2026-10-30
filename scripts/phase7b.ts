// Manual operator CLI only. Never start this from a web endpoint or automatic worker.
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";
import { phase7bRuntime } from "../services/solana/phase7b-runtime.ts";
import { WatchOnlyZcash } from "../services/signer/watch-evidence.ts";
import { json } from "../services/solana/network.ts";
const x = phase7bRuntime(),
  { p, root, service, store } = x;
const id = `0x${(await import("../services/solana/transactions.ts")).digest(`phase7b:${p.id}:${p.orderId}`)}`;
async function native(args: string[], seed?: Buffer): Promise<any> {
  return new Promise((yes, no) => {
    const child = spawn(
      resolve("target/debug/zecone-zcash.exe"),
      ["--wallet", join(root, "payer-native"), ...args],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let data = "";
    const timer = setTimeout(() => {
      child.kill();
      no(Error("Native timeout; preserve all claims"));
    }, 600000);
    child.stderr.resume();
    child.stdout.on("data", (b) => {
      data += b;
      if (data.length > 65536) {
        child.kill();
        no(Error("Native output limit"));
      }
    });
    child.on("error", () => {
      clearTimeout(timer);
      seed?.fill(0);
      no(Error("Native payment helper unavailable"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      seed?.fill(0);
      if (code !== 0)
        return no(Error("Native payment failed; no automatic retry"));
      try {
        yes(JSON.parse(data));
      } catch {
        no(Error("Invalid native result"));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(seed, () => seed?.fill(0));
  });
}
try {
  const command = process.argv[2];
  let result: unknown;
  const quote = () =>
    service.quote({
      profileId: p.id,
      requestId: p.orderId,
      recipient: process.argv[3] ?? p.recipient,
      relayer: p.relayer,
      lamports: process.argv[4] ?? "1000000",
      account: x.manifest.keyId,
      paymentAddress: x.manifest.address,
    });
  if (command === "quote") result = quote();
  else if (command === "status") result = service.view(id);
  else if (command === "funding") {
    const s = await new WatchOnlyZcash(join(root, "payer-watch")).observe();
    result = {
      network: s.network,
      address: s.address,
      tip: s.tip,
      scanned: s.scanned,
      confirmedUnspentZatoshis: s.native.inputs
        .filter((i) => s.tip - i.minedHeight + 1 >= 10)
        .reduce((n, i) => n + BigInt(i.zatoshis), 0n)
        .toString(),
      source: s.source,
    };
  } else if (command === "prepare-payment") {
    const view = service.view(id);
    if (
      view.expires <= Math.floor(Date.now() / 1000) ||
      view.receivedZatoshis !== "0"
    )
      throw Error("Expired or paid order; no new payment");
    const snap = await new WatchOnlyZcash(join(root, "payer-watch")).observe();
    if (
      snap.native.inputs
        .filter((i) => snap.tip - i.minedHeight + 1 >= 10)
        .reduce((n, i) => n + BigInt(i.zatoshis), 0n) < 110000n
    )
      throw Error(
        "Fresh payer requires 110000 zatoshis in owned notes with ten confirmations",
      );
    const birthday = JSON.parse(
      readFileSync(join(root, "payer-watch/watch-only.json"), "utf8"),
    ).birthday;
    result = await native(
      [
        "prepare-phase7b-payment",
        "--profile-id",
        p.id,
        "--request-id",
        p.orderId,
        "--birthday",
        String(birthday),
      ],
      readFileSync(
        resolve(".secrets/phase7b", p.id, "payer/isolated-seed.bin"),
      ),
    );
  } else if (command === "broadcast-payment") {
    const approved = process.argv[3];
    if (
      !/^[a-f0-9]{64}$/.test(approved ?? "") ||
      !process.argv.includes("--allow-testnet-broadcast")
    )
      throw Error("Explicit exact transaction approval required");
    const view = service.view(id);
    if (
      view.expires <= Math.floor(Date.now() / 1000) ||
      view.receivedZatoshis !== "0"
    )
      throw Error("Order expired or already paid");
    result = await native([
      "broadcast-phase7b-payment",
      "--profile-id",
      p.id,
      "--request-id",
      p.orderId,
      "--approved-txid",
      approved,
      "--allow-testnet-broadcast",
    ]);
  } else if (command === "observe")
    result = service.authorize(id, await new WatchOnlyZcash(x.watch).observe());
  else if (command === "prepare-solana") {
    service.authorize(id, await new WatchOnlyZcash(x.watch).observe());
    result = await service.prepare(id);
    const prepared = result as any;
    result = {
      ...service.view(id),
      simulation: prepared.simulation,
      approvalDigest: prepared.digest,
    };
  } else if (command === "broadcast-solana") {
    const hash = process.argv[3];
    if (
      !/^[a-f0-9]{64}$/.test(hash ?? "") ||
      !process.argv.includes("--allow-devnet-broadcast")
    )
      throw Error("Explicit exact Solana digest approval required");
    service.authorize(id, await new WatchOnlyZcash(x.watch).observe());
    const file = JSON.parse(
        readFileSync(".secrets/phase7a-solana/payer.json", "utf8"),
      ),
      seed = Uint8Array.from(file.seed as number[]);
    try {
      const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
      if (signer.address !== p.relayer)
        throw Error("Relayer identity mismatch");
      result = await service.execute(
        id,
        { orderId: id, digest: hash, approved: true },
        signer,
      );
    } finally {
      seed.fill(0);
    }
  } else if (command === "reconcile") result = await service.reconcile(id);
  else
    throw Error(
      "Use quote, status, funding, prepare-payment, broadcast-payment, observe, prepare-solana, broadcast-solana or reconcile",
    );
  console.log(json(result));
  if (
    ["broadcast-payment", "broadcast-solana", "reconcile"].includes(
      command ?? "",
    )
  )
    writeFileSync(
      `docs/phase7b-evidence/${command}-${Date.now()}.json`,
      json({ at: new Date().toISOString(), result }),
    );
} finally {
  store.close();
}
