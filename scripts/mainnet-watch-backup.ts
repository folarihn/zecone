import { generateX25519Identity, identityToRecipient } from "age-encryption";
import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  assertExternalPath,
  decryptWatchBackup,
  encryptWatchBackup,
  packWatchProfile,
  restoreWatchProfile,
  writeEncryptedWatchBackup,
} from "../services/provisioning/mainnet-watch-backup.ts";

function args() {
  const [command, ...rest] = process.argv.slice(2),
    values = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i],
      value = rest[i + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--"))
      throw Error("INVALID_ARGUMENTS");
    values.set(flag.slice(2), value);
  }
  return { command, values };
}

function required(values: Map<string, string>, key: string) {
  const value = values.get(key);
  if (!value || value.startsWith("--"))
    throw Error(`${key.toUpperCase()}_REQUIRED`);
  return value;
}

function readText(path: string, max: number) {
  assertExternalPath(path);
  const stat = statSync(path);
  if (stat.size < 1 || stat.size > max + 2)
    throw Error("INVALID_PRIVATE_TEXT_FILE");
  const value = readFileSync(path, "utf8").trim();
  if (!value || value.length > max || value.includes("\n"))
    throw Error("INVALID_PRIVATE_TEXT_FILE");
  return value;
}

function writeSecret(path: string, value: string) {
  assertExternalPath(path);
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, value + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function output(value: unknown) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

async function run() {
  const { command, values } = args();
  if (command === "identity") {
    if (values.get("confirm") !== "CREATE_AGE_IDENTITY")
      throw Error("AGE_IDENTITY_CONFIRMATION_REQUIRED");
    const path = resolve(required(values, "out"));
    const identity = await generateX25519Identity();
    writeSecret(path, identity);
    output({
      identityWritten: true,
      recipient: await identityToRecipient(identity),
    });
    return;
  }
  if (command === "backup") {
    if (values.get("confirm") !== "CREATE_WATCH_BACKUP")
      throw Error("WATCH_BACKUP_CONFIRMATION_REQUIRED");
    const profile = resolve(required(values, "profile")),
      recipient = readText(resolve(required(values, "recipient-file")), 512),
      path = resolve(required(values, "out"));
    if (!/^age1[0-9a-z]{20,200}$/.test(recipient))
      throw Error("AGE_RECIPIENT_REQUIRED");
    const { archive, metadata } = packWatchProfile(profile);
    const ciphertext = await encryptWatchBackup(archive, recipient);
    writeEncryptedWatchBackup(path, ciphertext);
    output({
      backupWritten: true,
      metadata,
      ciphertextBytes: ciphertext.length,
      ciphertextSha256: createHash("sha256").update(ciphertext).digest("hex"),
    });
    return;
  }
  if (command === "restore") {
    if (values.get("confirm") !== "RESTORE_WATCH_PROFILE")
      throw Error("WATCH_RESTORE_CONFIRMATION_REQUIRED");
    const backup = resolve(required(values, "backup"));
    assertExternalPath(backup);
    const size = statSync(backup).size;
    if (size < 32 || size > 512 * 1024 * 1024)
      throw Error("INVALID_WATCH_BACKUP");
    const ciphertext = readFileSync(backup),
      identity = readText(resolve(required(values, "identity-file")), 4096),
      metadata = restoreWatchProfile(
        await decryptWatchBackup(ciphertext, identity),
        resolve(required(values, "out")),
      );
    output({ restored: true, metadata });
    return;
  }
  if (command === "verify") {
    const { metadata } = packWatchProfile(resolve(required(values, "profile")));
    output({ valid: true, metadata });
    return;
  }
  throw Error("UNKNOWN_COMMAND");
}

run().catch((error: unknown) => {
  process.stderr.write(
    JSON.stringify({
      error: error instanceof Error ? error.message : "WATCH_BACKUP_FAILED",
    }) + "\n",
  );
  process.exitCode = 1;
});
