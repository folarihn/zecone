// Explicit user-selected disposable Phase 7B source inventory, never old authorization.
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { WatchOnlyZcash } from "../services/signer/watch-evidence.ts";
import { json } from "../services/solana/network.ts";
if (!process.argv.includes("--use-funded-phase7b-wallets"))
  throw Error("Explicit funded test-wallet selection required");
const file = ".state/phase7c/profile.json",
  p = JSON.parse(readFileSync(file, "utf8")),
  old = JSON.parse(readFileSync(".state/phase7b/profile.json", "utf8")),
  root = resolve(".state/phase7c", p.id);
if (p.payerSourceProfileId)
  throw Error("Source already selected; do not rewrite");
const db = new DatabaseSync(join(root, "settlement.sqlite"), {
  readOnly: true,
});
const count = db.prepare("SELECT COUNT(*) AS n FROM orders").get()!.n;
db.close();
if (Number(count) !== 0) throw Error("Immutable checkout already exists");
const exec = promisify(execFile),
  watch = join(root, "payment-source-watch");
const birthday = JSON.parse(
  readFileSync(
    resolve(".state/phase7b", old.id, "payer-watch/watch-only.json"),
    "utf8",
  ),
).birthday;
if (!existsSync(watch))
  await exec(
    resolve("target/debug/zecone-zcash-watch.exe"),
    [
      "--wallet",
      watch,
      "import",
      "--ufvk-file",
      resolve(".secrets/phase7b", old.id, "payer/viewing-key.txt"),
      "--birthday",
      String(birthday),
    ],
    { windowsHide: true, timeout: 180000, maxBuffer: 1048576 },
  );
const scan = await new WatchOnlyZcash(watch).observe();
const claims = [];
for (const name of readdirSync(".state/phase7c-funding")) {
  const wallet = join(".state/phase7c-funding", name, "payer-native");
  if (!existsSync(wallet)) continue;
  const pid = Number(readFileSync(join(wallet, "process.lock"), "utf8"));
  try {
    process.kill(pid, 0);
    throw Error("A funding constructor still runs or PID was reused");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
  for (const f of readdirSync(wallet).filter(
    (f) =>
      f.endsWith(".started.json") && !f.endsWith(".broadcast.started.json"),
  )) {
    const claim = JSON.parse(readFileSync(join(wallet, f), "utf8"));
    if (
      !Number.isSafeInteger(claim.plannedExpiryHeight) ||
      scan.tip < claim.plannedExpiryHeight + 10
    )
      throw Error(
        "Prior funding construction has not passed known expiry plus ten blocks",
      );
    if (existsSync(join(wallet, f.replace(".started.json", ".raw"))))
      throw Error("Saved funding bytes require explicit reconciliation");
    claims.push({ expiryHeight: claim.plannedExpiryHeight, tip: scan.tip });
  }
}
writeFileSync(
  join(root, "funded-source-selection.json"),
  json({
    at: new Date().toISOString(),
    previousRelayer: p.relayer,
    sourceProfileId: old.id,
    expiryReviews: claims,
    sourceWatch: watch,
    historicalFilesMutated: false,
    priorAuthorizationReused: false,
  }),
  { flag: "wx", mode: 0o600 },
);
p.payerSourceProfileId = old.id;
p.relayerSource = "phase7b";
p.relayer = old.relayer;
writeFileSync(file, json(p), { mode: 0o600 });
console.log(
  json({
    source: "user-selected funded Phase 7B test wallets",
    freshReceivingAccount: true,
    freshEncryptedRecipient: true,
    previousAuthorizationsReused: false,
    newBroadcastApproved: false,
    expiredFundingClaimsPreserved: claims.length,
  }),
);
