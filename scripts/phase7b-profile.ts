// Fresh testnet profile only. No historical wallet import or broadcasts.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { Accounts } from "../services/solana/accounts.ts";
import { Devnet, json } from "../services/solana/network.ts";
const exec = promisify(execFile);
const profileFile = ".state/phase7b/profile.json";
mkdirSync(".state/phase7b", { recursive: true });
mkdirSync(".secrets/phase7b", { recursive: true });
mkdirSync("docs/phase7b-evidence", { recursive: true });
if (existsSync(profileFile))
  throw Error(
    "Profile already exists. Inspect existing profile; do not reprovision.",
  );
const id = randomUUID(),
  orderId = randomUUID();
const secret = resolve(".secrets/phase7b", id),
  state = resolve(".state/phase7b", id);
mkdirSync(secret);
mkdirSync(state);
// Reserve before any keys: an interrupted setup cannot silently replace identities.
writeFileSync(
  profileFile,
  json({
    id,
    orderId,
    network: "zcash-testnet",
    status: "PROVISIONING",
    liveRefundsEnabled: false,
  }),
  { flag: "wx", mode: 0o600 },
);
const addresses: Record<string, string> = {};
for (const role of ["payer", "settlement"]) {
  const keys = join(secret, role),
    watch = join(state, `${role}-watch`);
  await exec(resolve("target/debug/provision-watch-test.exe"), [keys], {
    windowsHide: true,
    timeout: 30000,
  });
  await exec(
    resolve("target/debug/zecone-zcash-watch.exe"),
    ["--wallet", watch, "import", "--ufvk-file", join(keys, "viewing-key.txt")],
    { windowsHide: true, timeout: 180000, maxBuffer: 1048576 },
  );
  const manifest = JSON.parse(
    readFileSync(join(watch, "watch-only.json"), "utf8"),
  );
  const { stdout } = await exec(
    resolve("target/debug/zecone-zcash.exe"),
    [
      "--wallet",
      join(state, "unused"),
      "validate-address",
      "--address",
      manifest.address,
    ],
    { windowsHide: true },
  );
  const decoded = JSON.parse(stdout);
  if (
    decoded.network !== "zcash-testnet" ||
    decoded.shielded !== true ||
    decoded.receivers?.orchard !== true
  )
    throw Error("Shielded address validation failed");
  addresses[role] = manifest.address;
}
const accounts = Accounts.list(),
  relayer = accounts.find((a) => a.label === "payer")?.address,
  recipient = accounts.find((a) => a.label === "recipient")?.address;
if (!relayer || !recipient)
  throw Error("Phase 7A disposable Solana accounts required");
const profile = {
  id,
  orderId,
  network: "zcash-testnet",
  status: "READY",
  liveRefundsEnabled: false,
  addresses,
  relayer,
  recipient,
  createdAt: new Date().toISOString(),
};
writeFileSync(profileFile, json(profile), { mode: 0o600 });
const net = new Devnet();
const balance = (await net.balance(relayer)).toString();
const report = {
  ...profile,
  relayerLamports: balance,
  minimumConfirmations: 10,
  fundPayerTAZ: "0.002",
  expectedPaymentZatoshis: "100000",
  feeCapZatoshis: "10000",
  fundingIsNotBroadcastApproval: true,
};
writeFileSync("docs/phase7b-evidence/profile.json", json(report));
console.log(json(report));
