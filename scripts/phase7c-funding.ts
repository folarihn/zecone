// Explicit operator-only top-ups from the user-authorized funded Phase 7B wallets.
// Opens only new Phase 7C scan/construction/journal files; historical records stay intact.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { Devnet, GENESIS, json } from "../services/solana/network.ts";
import { prepare, type Prepared } from "../services/solana/transactions.ts";
import { Accounts } from "../services/solana/accounts.ts";
import { SolanaJournal } from "../services/solana/journal.ts";
import { signReviewed } from "../services/solana/signing.ts";
import {
  SolanaSettlementNetwork,
  getCompiledMessage,
} from "../services/solana/settlement.ts";
import { WatchOnlyZcash } from "../services/signer/watch-evidence.ts";
const exec = promisify(execFile),
  command = process.argv[2];
const old = JSON.parse(readFileSync(".state/phase7b/profile.json", "utf8")),
  fresh = JSON.parse(readFileSync(".state/phase7c/profile.json", "utf8"));
if (
  old.status !== "READY" ||
  fresh.status !== "READY" ||
  old.network !== "zcash-testnet" ||
  fresh.network !== "zcash-testnet"
)
  throw Error("Profile mismatch");
const root = resolve(".state/phase7c-funding"),
  config = join(root, "profile.json");
mkdirSync(root, { recursive: true });
if (command === "recover-expired-zcash") {
  if (!process.argv.includes("--acknowledge-expired-construction"))
    throw Error("Explicit expired-construction recovery review required");
  const previous = JSON.parse(readFileSync(config, "utf8")),
    state = join(root, previous.id),
    wallet = join(state, "payer-native");
  const started = JSON.parse(
    readFileSync(
      join(wallet, `request-${previous.orderId}.started.json`),
      "utf8",
    ),
  );
  if (
    !Number.isSafeInteger(started.plannedExpiryHeight) ||
    started.plannedExpiryHeight <= 0
  )
    throw Error("Known bounded transaction expiry required");
  const pid = Number(readFileSync(join(wallet, "process.lock"), "utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw Error("Invalid process claim");
  try {
    process.kill(pid, 0);
    throw Error("Construction process or reused PID still active");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
  const snap = await new WatchOnlyZcash(join(state, "source-watch")).observe();
  if (snap.tip < started.plannedExpiryHeight + 10)
    throw Error("Wait for transaction expiry plus ten blocks");
  if (
    existsSync(join(wallet, `request-${previous.orderId}.raw`)) ||
    existsSync(join(wallet, `request-${previous.orderId}.json`))
  )
    throw Error(
      "Saved transaction must be reconciled, not replaced by this recovery path",
    );
  const db = new DatabaseSync(join(wallet, "wallet.sqlite"), {
    readOnly: true,
  });
  const count = db
    .prepare(
      "SELECT COUNT(*) AS n FROM transactions WHERE mined_height IS NULL AND raw IS NOT NULL",
    )
    .get()!.n;
  db.close();
  if (Number(count) !== 0)
    throw Error("Saved unmined transaction requires recovery export");
  writeFileSync(
    join(state, "expired-construction-review.json"),
    json({
      at: new Date().toISOString(),
      previous,
      started,
      tip: snap.tip,
      blockHash: snap.blockHash,
      rawSaved: false,
      replacementBroadcastAuthorized: false,
    }),
    { flag: "wx", mode: 0o600 },
  );
  writeFileSync(join(state, "profile-preserved.json"), json(previous), {
    flag: "wx",
    mode: 0o600,
  });
  const id = randomUUID(),
    orderId = randomUUID(),
    next = join(root, id),
    keys = resolve(".secrets/phase7c-funding", id, "payer");
  mkdirSync(next);
  mkdirSync(keys, { recursive: true });
  writeFileSync(
    config,
    json({
      ...previous,
      id,
      orderId,
      status: "PROVISIONING",
      replacesExpiredProfileId: previous.id,
    }),
    { mode: 0o600 },
  );
  const sourceKey = resolve(
    ".secrets/phase7b",
    old.id,
    "payer/viewing-key.txt",
  );
  writeFileSync(join(keys, "viewing-key.txt"), readFileSync(sourceKey), {
    flag: "wx",
    mode: 0o600,
  });
  for (const [watch, key, birthday] of [
    ["source-watch", sourceKey, snap.birthday],
    [
      "settlement-watch",
      resolve(".secrets/phase7c", fresh.id, "payer/viewing-key.txt"),
      undefined,
    ],
  ] as const) {
    const args = ["--wallet", join(next, watch), "import", "--ufvk-file", key];
    if (birthday) args.push("--birthday", String(birthday));
    await exec(resolve("target/debug/zecone-zcash-watch.exe"), args, {
      windowsHide: true,
      timeout: 180000,
      maxBuffer: 1048576,
    });
  }
  const nextConfig = JSON.parse(readFileSync(config, "utf8"));
  nextConfig.status = "READY";
  writeFileSync(config, json(nextConfig), { mode: 0o600 });
  console.log(
    json({
      status: "EXPIRED_CONSTRUCTION_PRESERVED",
      expiryHeight: started.plannedExpiryHeight,
      verifiedTip: snap.tip,
      next: "Prepare new bounded bytes for a separate exact user review; no broadcast authorized",
    }),
  );
} else if (command === "init") {
  if (existsSync(config))
    throw Error("Funding profile already reserved; no reprovisioning");
  const id = randomUUID(),
    orderId = randomUUID(),
    state = join(root, id),
    keys = resolve(".secrets/phase7c-funding", id, "payer");
  mkdirSync(state);
  mkdirSync(keys, { recursive: true });
  writeFileSync(
    config,
    json({
      id,
      orderId,
      network: "zcash-testnet",
      liveRefundsEnabled: false,
      sourceProfileId: old.id,
      destinationProfileId: fresh.id,
      addresses: { settlement: fresh.addresses.payer },
      status: "PROVISIONING",
    }),
    { flag: "wx", mode: 0o600 },
  );
  const sourceKey = resolve(
    ".secrets/phase7b",
    old.id,
    "payer/viewing-key.txt",
  );
  writeFileSync(join(keys, "viewing-key.txt"), readFileSync(sourceKey), {
    flag: "wx",
    mode: 0o600,
  });
  const birthday = JSON.parse(
    readFileSync(
      resolve(".state/phase7b", old.id, "payer-watch/watch-only.json"),
      "utf8",
    ),
  ).birthday;
  await exec(
    resolve("target/debug/zecone-zcash-watch.exe"),
    [
      "--wallet",
      join(state, "source-watch"),
      "import",
      "--ufvk-file",
      sourceKey,
      "--birthday",
      String(birthday),
    ],
    { windowsHide: true, timeout: 180000, maxBuffer: 1048576 },
  );
  await exec(
    resolve("target/debug/zecone-zcash-watch.exe"),
    [
      "--wallet",
      join(state, "settlement-watch"),
      "import",
      "--ufvk-file",
      resolve(".secrets/phase7c", fresh.id, "payer/viewing-key.txt"),
    ],
    { windowsHide: true, timeout: 180000, maxBuffer: 1048576 },
  );
  const p = JSON.parse(readFileSync(config, "utf8"));
  p.status = "READY";
  writeFileSync(config, json(p), { mode: 0o600 });
  console.log(
    json({ status: "READY", historicalWalletOpened: false, noBroadcast: true }),
  );
} else if (command?.endsWith("zcash")) {
  const p = JSON.parse(readFileSync(config, "utf8"));
  if (
    p.status !== "READY" ||
    p.sourceProfileId !== old.id ||
    p.destinationProfileId !== fresh.id
  )
    throw Error("Funding identity conflict");
  const state = join(root, p.id),
    args = ["--wallet", join(state, "payer-native")];
  let seed: Buffer | undefined;
  if (command === "prepare-zcash") {
    const snap = await new WatchOnlyZcash(
      join(state, "source-watch"),
    ).observe();
    // The payment/refund evidence projection deliberately excludes change.
    // Funding inventory must include mature change, from this NEW freshly scanned
    // source database only; never loosen the settlement evidence verifier.
    const sourceDb = new DatabaseSync(
      join(state, "source-watch/wallet.sqlite"),
      { readOnly: true },
    );
    const owned = sourceDb
      .prepare(
        "SELECT n.value FROM ironwood_received_notes n JOIN transactions t ON t.id_tx=n.transaction_id JOIN blocks b ON b.height=t.mined_height WHERE n.value>0 AND t.mined_height<=? AND n.nf IS NOT NULL AND n.commitment_tree_position IS NOT NULL AND n.lock_owner IS NULL AND NOT EXISTS(SELECT 1 FROM ironwood_received_note_spends s WHERE s.ironwood_received_note_id=n.id)",
      )
      .all(snap.tip - 9);
    sourceDb.close();
    const total = owned.reduce((n, i) => n + BigInt(String(i.value)), 0n);
    if (total < 210000n)
      throw Error(
        "Source needs fresh mature unspent notes for 0.002 TAZ plus fee",
      );
    args.push(
      "prepare-phase7c-funding-payment",
      "--birthday",
      String(snap.birthday),
    );
    seed = readFileSync(
      resolve(".secrets/phase7b", old.id, "payer/isolated-seed.bin"),
    );
  } else if (command === "broadcast-zcash") {
    if (
      !/^[a-f0-9]{64}$/.test(process.argv[3] ?? "") ||
      !process.argv.includes("--allow-testnet-broadcast")
    )
      throw Error("Exact approved testnet transaction ID required");
    args.push(
      "broadcast-phase7c-funding-payment",
      "--approved-txid",
      process.argv[3],
      "--allow-testnet-broadcast",
    );
  } else if (command === "inspect-zcash")
    args.push("inspect-phase7c-funding-payment");
  else throw Error("Unsupported funding command");
  args.push("--profile-id", p.id, "--request-id", p.orderId);
  const result = await new Promise<any>((yes, no) => {
    const child = spawn(resolve("target/debug/zecone-zcash.exe"), args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let data = "";
    const timer = setTimeout(() => {
      child.kill();
      no(Error("Funding helper timeout; preserve records"));
    }, 600000);
    child.stdout.on("data", (b) => {
      data += b;
      if (data.length > 65536) child.kill();
    });
    child.on("error", () => {
      clearTimeout(timer);
      seed?.fill(0);
      no(Error("Funding helper unavailable"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      seed?.fill(0);
      if (code !== 0)
        return no(Error("Funding helper failed; do not retry construction"));
      try {
        yes(JSON.parse(data));
      } catch {
        no(Error("Invalid native result"));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(seed, () => seed?.fill(0));
  });
  writeFileSync(join(state, `${command}-${Date.now()}.json`), json(result), {
    flag: "wx",
    mode: 0o600,
  });
  console.log(json(result));
} else {
  const net = new Devnet(),
    db = new DatabaseSync(join(root, "solana.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
  const journal = new SolanaJournal(db),
    id = process.argv.includes("--replacement")
      ? "phase7c-topup-2"
      : "phase7c-topup",
    network = new SolanaSettlementNetwork(net);
  try {
    if (command === "prepare-solana") {
      if (id === "phase7c-topup-2") {
        if (!process.argv.includes("--acknowledge-expired-topup"))
          throw Error("Explicit expired-top-up review required");
        const prior = journal.get("phase7c-topup");
        if (!prior?.signature) throw Error("Original signature required");
        const original = JSON.parse(prior.payload);
        const height = await net.read((s) =>
          net.rpc
            .getBlockHeight({ commitment: "finalized" })
            .send({ abortSignal: s }),
        );
        if (
          height <= BigInt(original.lifetime.lastValidBlockHeight) + 32n ||
          (await net.status(prior.signature)) !== "UNKNOWN" ||
          (await network.receipt(prior.signature))
        )
          throw Error(
            "Original signature not independently expired/absent under current RPC view",
          );
        writeFileSync(
          join(root, "solana-expired-original-review.json"),
          json({
            at: new Date().toISOString(),
            signature: prior.signature,
            finalizedHeight: height,
            lastValidBlockHeight: original.lifetime.lastValidBlockHeight,
            acceptedReceipt: false,
            newBroadcastAuthorized: false,
          }),
          { flag: "wx", mode: 0o600 },
        );
      }
      if (journal.get(id))
        throw Error(
          "Top-up already prepared; never replace an existing blockhash",
        );
      if ((await net.balance(old.relayer)) < 10010000n)
        throw Error("Insufficient prior relayer balance");
      const p = await prepare(
        net,
        {
          family: "solana",
          network: "solana:devnet",
          genesis: GENESIS,
          owner: old.relayer,
          recipient: fresh.relayer,
          amount: "10000000",
          asset: { kind: "SOL" },
          feeCap: "10000",
        },
        [old.relayer, fresh.relayer],
      );
      if (p.simulation.err) throw Error("Top-up simulation failed");
      journal.save(id, p);
      console.log(
        json({
          source: old.relayer,
          recipient: fresh.relayer,
          amountLamports: p.action.amount,
          fee: p.fee,
          digest: p.digest,
          lifetime: p.lifetime,
          simulation: p.simulation,
          approvalRequired: true,
        }),
      );
    } else if (command === "broadcast-solana") {
      const hash = process.argv[3];
      if (
        !/^[a-f0-9]{64}$/.test(hash ?? "") ||
        !process.argv.includes("--allow-devnet-broadcast")
      )
        throw Error("Exact digest approval required");
      const row = journal.get(id);
      if (row?.state !== "AWAITING_EXPLICIT_APPROVAL")
        throw Error("No new signing or submission authorized");
      const a = new Accounts();
      try {
        await a.unlock("payer", true);
        const signed = await signReviewed(journal, net, a, id, hash, true, [
          old.relayer,
          fresh.relayer,
        ]);
        if (
          !db
            .prepare(
              "UPDATE solana_actions SET state='SUBMITTING' WHERE id=? AND state='SIGNED_NOT_SUBMITTED'",
            )
            .run(id).changes
        )
          throw Error("Submission veto");
        try {
          const returned = await network.send(signed.wire);
          if (returned !== signed.signature)
            throw Error("Signature disagreement");
          db.prepare(
            "UPDATE solana_actions SET state='SUBMITTED' WHERE id=?",
          ).run(id);
        } catch {
          db.prepare(
            "UPDATE solana_actions SET state='SUBMISSION_UNCERTAIN' WHERE id=?",
          ).run(id);
        }
        console.log(
          json({
            signature: signed.signature,
            state: journal.get(id)?.state,
            replacementAuthorized: false,
          }),
        );
      } finally {
        a.lock();
      }
    } else if (command === "reconcile-solana") {
      const row = journal.get(id);
      if (!row?.signature) throw Error("No submitted top-up");
      const receipt = await network.receipt(row.signature);
      if (!receipt) throw Error("Original signature not finalized yet");
      const p = JSON.parse(row.payload) as Prepared,
        m = receipt.meta,
        message = receipt.transaction.message,
        expected = getCompiledMessage(p.wire);
      const actual = {
        accountKeys: message.accountKeys,
        header: message.header,
        recentBlockhash: message.recentBlockhash,
        instructions: message.instructions.map((x: any) => ({
          accounts: x.accounts,
          data: x.data,
          programIdIndex: x.programIdIndex,
        })),
      };
      if (
        !m ||
        m.err ||
        receipt.version !== "legacy" ||
        receipt.transaction.signatures[0] !== row.signature ||
        json(actual) !== json(expected) ||
        BigInt(m.fee) !== BigInt(p.fee) ||
        BigInt(m.postBalances[1]) - BigInt(m.preBalances[1]) !== 10000000n ||
        BigInt(m.preBalances[0]) - BigInt(m.postBalances[0]) !==
          10000000n + BigInt(m.fee)
      )
        throw Error("Top-up effects mismatch; preserve and investigate");
      db.prepare("UPDATE solana_actions SET state='FINALIZED' WHERE id=?").run(
        id,
      );
      writeFileSync(join(root, "solana-finalized.json"), json(receipt), {
        mode: 0o600,
      });
      console.log(
        json({
          signature: row.signature,
          state: "FINALIZED",
          deliveredLamports: "10000000",
          fee: m.fee,
        }),
      );
    } else
      throw Error(
        "Use init, prepare-zcash, inspect-zcash, broadcast-zcash, prepare-solana, broadcast-solana or reconcile-solana",
      );
  } finally {
    db.close();
  }
}
