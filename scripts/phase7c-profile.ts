// Creates only fresh disposable credentials; no broadcasts and no legacy imports.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EncryptedAccounts } from "../services/solana/encrypted-accounts.ts";
import { WindowsUnlock } from "../services/solana/windows-unlock.ts";
import { json } from "../services/solana/network.ts";
const exec = promisify(execFile),
  file = ".state/phase7c/profile.json";
mkdirSync(".state/phase7c", { recursive: true });
if (existsSync(file))
  throw Error(
    "Phase 7C profile already reserved; inspect, never overwrite or retry provisioning",
  );
const id = randomUUID(),
  orderId = randomUUID(),
  recipientLabel = `recipient-${randomUUID()}`;
writeFileSync(
  file,
  json({
    id,
    orderId,
    network: "zcash-testnet",
    liveRefundsEnabled: false,
    status: "PROVISIONING",
  }),
  { flag: "wx", mode: 0o600 },
);
const accounts = new EncryptedAccounts(),
  unlock = new WindowsUnlock();
const relayer = await accounts.generate(
  "relayer",
  await unlock.create("relayer"),
);
const recipient = await accounts.generate(
  recipientLabel,
  await unlock.create(recipientLabel),
);
const root = resolve(".state/phase7c", id),
  secret = resolve(".secrets/phase7c", id);
mkdirSync(root, { recursive: true });
mkdirSync(secret, { recursive: true });
const addresses: Record<string, string> = {};
for (const role of ["payer", "settlement"]) {
  const keys = join(secret, role),
    watch = join(root, `${role}-watch`);
  await exec(resolve("target/debug/provision-watch-test.exe"), [keys], {
    windowsHide: true,
    timeout: 30000,
  });
  await exec(
    resolve("target/debug/zecone-zcash-watch.exe"),
    ["--wallet", watch, "import", "--ufvk-file", join(keys, "viewing-key.txt")],
    { windowsHide: true, timeout: 180000, maxBuffer: 1048576 },
  );
  const m = JSON.parse(readFileSync(join(watch, "watch-only.json"), "utf8"));
  const { stdout } = await exec(
    resolve("target/debug/zecone-zcash.exe"),
    [
      "--wallet",
      join(root, "unused"),
      "validate-address",
      "--address",
      m.address,
    ],
    { windowsHide: true },
  );
  const d = JSON.parse(stdout);
  if (
    d.network !== "zcash-testnet" ||
    d.shielded !== true ||
    d.receivers?.orchard !== true
  )
    throw Error("Fresh shielded address validation failed");
  addresses[role] = m.address;
}
writeFileSync(
  file,
  json({
    id,
    orderId,
    recipientLabel,
    relayer,
    recipient,
    addresses,
    network: "zcash-testnet",
    status: "READY",
    liveRefundsEnabled: false,
  }),
  { mode: 0o600 },
);
console.log(
  json({
    status: "READY",
    credentials:
      "age-v1 with Windows CurrentUser DPAPI unlock; existing keys untouched",
    next: "Review public funding addresses via Phase 7C operator funding command; no broadcast authorized",
  }),
);
