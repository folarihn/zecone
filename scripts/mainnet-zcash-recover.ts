import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openMainnetCredential,
  readMainnetKeystore,
} from "../services/provisioning/mainnet-keystore.ts";
import { assertExternalPath } from "../services/provisioning/mainnet-watch-backup.ts";

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

function required(values: Map<string, string>, key: string) {
  const value = values.get(key);
  if (!value || value.startsWith("--"))
    throw Error(`${key.toUpperCase()}_REQUIRED`);
  return value;
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function helper(name: string) {
  return resolve(
    projectRoot,
    `target/debug/${name}${process.platform === "win32" ? ".exe" : ""}`,
  );
}

function runWithInput(input: Buffer, extra: string[]): Promise<string> {
  return new Promise((yes, no) => {
    const child = spawn(helper("derive-mainnet-ufvk"), extra, {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      }),
      out: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill();
      no(Error("RECOVERY_HELPER_TIMEOUT"));
    }, 120_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 64 * 1024) out.push(chunk);
    });
    child.stderr.on("data", () => undefined);
    child.on("error", () => {
      clearTimeout(timer);
      no(Error("RECOVERY_HELPER_UNAVAILABLE"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || size > 64 * 1024) no(Error("RECOVERY_HELPER_FAILED"));
      else yes(Buffer.concat(out).toString("utf8"));
    });
    child.stdin.end(input);
  });
}

async function main() {
  const values = args();
  if (values.get("confirm") !== "RECOVER_MAINNET_UFVK")
    throw Error("RECOVERY_CONFIRMATION_REQUIRED");
  const keystore = resolve(required(values, "keystore")),
    passphraseFile = resolve(required(values, "passphrase-file")),
    provisioningFile = resolve(required(values, "provisioning")),
    out = resolve(required(values, "out"));
  for (const path of [keystore, passphraseFile, provisioningFile, out])
    assertExternalPath(path);
  if (new Set([keystore, passphraseFile, provisioningFile, out]).size !== 4)
    throw Error("RECOVERY_PATHS_MUST_BE_DISTINCT");
  for (const path of [keystore, provisioningFile]) {
    const size = statSync(path).size;
    if (size < 1 || size > 64 * 1024)
      throw Error("INVALID_RECOVERY_FILE");
  }
  const provisioning = JSON.parse(readFileSync(provisioningFile, "utf8")) as {
    credentials?: {
      role?: string;
      mode?: string;
      account?: string;
      address?: string;
      birthday?: number;
      keystore?: string | null;
    }[];
  };
  const zcash = provisioning.credentials?.find(
    (credential) => credential.role === "zcash-receiver",
  );
  if (
    zcash?.mode !== "seed-keystore" ||
    zcash.keystore !== "zcash-receiver.keystore.json" ||
    !/^[a-f0-9]{64}$/.test(zcash.account ?? "") ||
    !/^u1[0-9a-z]{20,220}$/.test(zcash.address ?? "") ||
    !Number.isSafeInteger(zcash.birthday) ||
    (zcash.birthday ?? 0) < 1
  )
    throw Error("INVALID_MAINNET_PROVISIONING_METADATA");
  const passphraseSize = statSync(passphraseFile).size;
  if (passphraseSize < 24 || passphraseSize > 1024)
    throw Error("INVALID_RECOVERY_PASSPHRASE");
  const passphrase = readFileSync(passphraseFile);
  if (passphrase.length < 24 || passphrase.length > 1024)
    throw Error("INVALID_RECOVERY_PASSPHRASE");
  let seed: Buffer | undefined;
  try {
    seed = await openMainnetCredential(
      readMainnetKeystore(keystore),
      passphrase,
      "mainnet:zcash:receiver",
    );
    const result = JSON.parse(await runWithInput(seed, ["--out", out])) as {
      network?: string;
      address?: string;
      account?: string;
      ufvkWritten?: boolean;
      spendingKeyRetained?: boolean;
    };
    if (
      result.network !== "zcash-mainnet" ||
      result.address !== zcash.address ||
      result.account !== zcash.account ||
      result.ufvkWritten !== true ||
      result.spendingKeyRetained !== false
    )
      throw Error("MAINNET_UFVK_RECOVERY_MISMATCH");
    process.stdout.write(
      JSON.stringify(
        {
          recovered: true,
          network: result.network,
          account: result.account,
          address: result.address,
          birthday: zcash.birthday,
          ufvkWritten: true,
          spendingKeyRetained: false,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    seed?.fill(0);
    passphrase.fill(0);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    JSON.stringify({
      error: error instanceof Error ? error.message : "RECOVERY_FAILED",
    }) + "\n",
  );
  process.exitCode = 1;
});
