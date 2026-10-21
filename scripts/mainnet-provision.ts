// Offline operator provisioning. Generates new Base/Solana credentials and
// either a new Zcash seed or imports an approved UFVK. Nothing is signed,
// broadcast or connected to a network.
import { spawn } from "node:child_process";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { randomBytes } from "node:crypto";
import {
  assertDistinctMainnetCredentials,
  generateBaseMainnetKey,
  generateSolanaMainnetKey,
  sealMainnetCredential,
  writeMainnetKeystore,
  type MainnetCredentialPurpose,
} from "../services/provisioning/mainnet-keystore.ts";
import { exclusiveJson } from "../services/execution/io.ts";

function args() {
  const values = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const flag = process.argv[i];
    if (!flag.startsWith("--") || !process.argv[i + 1])
      throw Error("INVALID_ARGUMENTS");
    values.set(flag.slice(2), process.argv[i + 1]);
  }
  return values;
}

function runWithInput(
  executable: string,
  input: Buffer | string,
): Promise<string> {
  return new Promise((yes, no) => {
    const child = spawn(executable, [], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      }),
      out: Buffer[] = [],
      err: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill();
      no(Error("PROVISION_HELPER_TIMEOUT"));
    }, 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 64 * 1024) out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (err.reduce((a, b) => a + b.length, 0) < 4096) err.push(chunk);
    });
    child.on("error", () => {
      clearTimeout(timer);
      no(Error("PROVISION_HELPER_UNAVAILABLE"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || size > 64 * 1024) no(Error("PROVISION_HELPER_FAILED"));
      else yes(Buffer.concat(out).toString("utf8"));
    });
    child.stdin.end(input);
  });
}

function writeExclusive(path: string, value: string) {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

let passphrase: Buffer = Buffer.alloc(0);
const secrets: Buffer[] = [];
function remember<T extends { secret: Buffer }>(key: T) {
  secrets.push(key.secret);
  return key;
}
async function provision() {
  const values = args(),
    out = resolve(values.get("out") ?? "");
  if (
    !values.get("out") ||
    values.get("confirm") !== "CREATE_MAINNET_KEYS" ||
    !values.get("passphrase-file")
  )
    throw Error("OFFLINE_PROVISION_CONFIRMATION_REQUIRED");
  const outside = (file: string) => {
    const rel = relative(realpathSync("."), file);
    return rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel);
  };
  const passFile = realpathSync(values.get("passphrase-file")!);
  if (
    !outside(passFile) ||
    !outside(out) ||
    statSync(passFile).size < 24 ||
    statSync(passFile).size > 1024
  )
    throw Error("EXTERNAL_PRIVATE_PATHS_REQUIRED");
  passphrase = readFileSync(passFile);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  if (!outside(realpathSync(out)))
    throw Error("EXTERNAL_PRIVATE_PATHS_REQUIRED");
  if (readdirSync(out).length) throw Error("OUTPUT_DIRECTORY_MUST_BE_EMPTY");

  const baseRecipient = remember(await generateBaseMainnetKey()),
    solanaRecipient = remember(await generateSolanaMainnetKey()),
    baseRelayer = remember(await generateBaseMainnetKey()),
    solanaRelayer = remember(await generateSolanaMainnetKey()),
    all = [
      ["mainnet:base:recipient", baseRecipient],
      ["mainnet:solana:recipient", solanaRecipient],
      ["mainnet:base:relayer", baseRelayer],
      ["mainnet:solana:relayer", solanaRelayer],
    ] as const;
  assertDistinctMainnetCredentials(
    all.map(([purpose, value]) => ({ purpose, address: value.address })),
  );

  for (const [purpose, value] of all) {
    const file = `${purpose.split(":")[1]}-${purpose.split(":")[2]}.keystore.json`,
      sealed = await sealMainnetCredential(
        value.secret,
        passphrase,
        purpose as MainnetCredentialPurpose,
      );
    writeMainnetKeystore(resolve(out, file), sealed);
    value.secret.fill(0);
  }

  const seedFile = values.get("zcash-seed"),
    ufvkFile = values.get("zcash-ufvk");
  if (seedFile && ufvkFile) throw Error("ZCASH_SEED_AND_UFVK_ARE_EXCLUSIVE");
  const helper = (name: string) =>
    resolve(
      `target/debug/${name}${process.platform === "win32" ? ".exe" : ""}`,
    );
  let zcash: {
    address: string;
    account: string;
    ufvk: string;
    mode: "seed-keystore" | "ufvk";
    keystore: string | null;
  };
  if (ufvkFile) {
    const ufvk = readFileSync(resolve(ufvkFile), "utf8").trim(),
      result = JSON.parse(
        await runWithInput(helper("inspect-mainnet-ufvk"), ufvk),
      ) as { network: string; address: string; account: string; ufvk: string };
    if (
      result.network !== "zcash-mainnet" ||
      result.ufvk !== ufvk ||
      !/^u1[0-9a-z]{20,220}$/.test(result.address) ||
      !/^[a-f0-9]{64}$/.test(result.account)
    )
      throw Error("INVALID_MAINNET_UFVK");
    writeExclusive(resolve(out, "zcash-receiver.ufvk"), ufvk + "\n");
    zcash = {
      address: result.address,
      account: result.account,
      ufvk: result.ufvk,
      mode: "ufvk",
      keystore: null,
    };
  } else {
    const seed = seedFile ? readFileSync(resolve(seedFile)) : randomBytes(32);
    secrets.push(seed);
    if (seed.length !== 32) throw Error("ZCASH_SEED_MUST_BE_32_BYTES");
    const result = JSON.parse(
      await runWithInput(helper("derive-mainnet-ufvk"), seed),
    ) as { network: string; address: string; account: string; ufvk: string };
    if (
      result.network !== "zcash-mainnet" ||
      !/^u1[0-9a-z]{20,220}$/.test(result.address) ||
      !/^[a-f0-9]{64}$/.test(result.account)
    )
      throw Error("MAINNET_UFVK_DERIVATION_FAILED");
    const sealed = await sealMainnetCredential(
      seed,
      passphrase,
      "mainnet:zcash:receiver",
    );
    writeMainnetKeystore(resolve(out, "zcash-receiver.keystore.json"), sealed);
    writeExclusive(resolve(out, "zcash-receiver.ufvk"), result.ufvk + "\n");
    zcash = {
      address: result.address,
      account: result.account,
      ufvk: result.ufvk,
      mode: "seed-keystore",
      keystore: "zcash-receiver.keystore.json",
    };
    seed.fill(0);
  }

  if (
    new Set([baseRecipient.address, solanaRecipient.address, zcash.address])
      .size !== 3
  )
    throw Error("RECIPIENT_CREDENTIALS_MUST_BE_DISTINCT");
  if (
    baseRecipient.address === baseRelayer.address ||
    solanaRecipient.address === solanaRelayer.address
  )
    throw Error("RELAYER_MUST_BE_SEPARATE_FROM_RECIPIENT");

  exclusiveJson(resolve(out, "provisioning.json"), {
    version: 1,
    network: "mainnet",
    createdAt: new Date().toISOString(),
    signing: false,
    broadcast: false,
    credentials: [
      {
        role: "base-recipient",
        network: "base",
        purpose: "mainnet:base:recipient",
        address: baseRecipient.address,
        publicKey: baseRecipient.publicKey,
        keystore: "base-recipient.keystore.json",
      },
      {
        role: "solana-recipient",
        network: "solana",
        purpose: "mainnet:solana:recipient",
        address: solanaRecipient.address,
        publicKey: solanaRecipient.publicKey,
        keystore: "solana-recipient.keystore.json",
      },
      {
        role: "base-relayer",
        network: "base",
        purpose: "mainnet:base:relayer",
        address: baseRelayer.address,
        publicKey: baseRelayer.publicKey,
        keystore: "base-relayer.keystore.json",
      },
      {
        role: "solana-relayer",
        network: "solana",
        purpose: "mainnet:solana:relayer",
        address: solanaRelayer.address,
        publicKey: solanaRelayer.publicKey,
        keystore: "solana-relayer.keystore.json",
      },
      {
        role: "zcash-receiver",
        network: "zcash",
        purpose: "mainnet:zcash:receiver",
        address: zcash.address,
        account: zcash.account,
        mode: zcash.mode,
        ufvkFile: "zcash-receiver.ufvk",
        keystore: zcash.keystore,
      },
    ],
  });

  baseRecipient.secret.fill(0);
  baseRelayer.secret.fill(0);
  solanaRecipient.secret.fill(0);
  solanaRelayer.secret.fill(0);
  passphrase.fill(0);
  console.log(
    JSON.stringify({
      status: "PROVISIONED",
      out,
      signing: false,
      broadcast: false,
      credentials: 5,
    }),
  );
}
try {
  await provision();
} catch {
  console.error(
    "Offline mainnet provisioning failed. No secrets are printed; inspect local files before any retry.",
  );
  process.exitCode = 1;
} finally {
  passphrase.fill(0);
  for (const secret of secrets) secret.fill(0);
}
