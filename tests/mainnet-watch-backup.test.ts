import assert from "node:assert/strict";
import { generateX25519Identity, identityToRecipient } from "age-encryption";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  assertExternalPath,
  decryptWatchBackup,
  encryptWatchBackup,
  packWatchProfile,
  restoreWatchProfile,
  validateWatchBackupArchive,
  writeEncryptedWatchBackup,
} from "../services/provisioning/mainnet-watch-backup.ts";

const key = "uview1" + "q".repeat(80);
const account = createHash("sha256").update(key).digest("hex");
const address = "u1" + "r".repeat(80);
function profile(root: string) {
  const directory = join(root, "profile");
  mkdirSync(directory);
  writeFileSync(
    join(directory, "watch-only.json"),
    JSON.stringify({
      version: 1,
      network: "zcash-mainnet",
      keyId: account,
      birthday: 3_000_000,
      address,
    }),
  );
  writeFileSync(join(directory, "viewing-key.txt"), key + "\n");
  const database = new DatabaseSync(join(directory, "wallet.sqlite"));
  database.exec(
    "CREATE TABLE watch_state(id INTEGER PRIMARY KEY, network TEXT NOT NULL); INSERT INTO watch_state VALUES(1, 'zcash-mainnet');",
  );
  database.close();
  return directory;
}

test("watch-only profile round trips through an encrypted archive", async () => {
  const root = mkdtempSync(join(tmpdir(), "zecone-watch-backup-")),
    source = profile(root),
    output = join(root, "restored"),
    identity = await generateX25519Identity(),
    recipient = await identityToRecipient(identity);
  try {
    const packed = packWatchProfile(source);
    assert.equal(packed.metadata.network, "zcash-mainnet");
    assert.equal(packed.metadata.watchOnly, true);
    assert.equal(packed.metadata.account, account);
    const ciphertext = await encryptWatchBackup(packed.archive, recipient);
    assert.ok(!Buffer.from(ciphertext).includes(Buffer.from(key)));
    const archive = await decryptWatchBackup(ciphertext, identity);
    const restored = restoreWatchProfile(archive, output);
    assert.deepEqual(restored, packed.metadata);
    assert.equal(
      readFileSync(join(output, "viewing-key.txt"), "utf8"),
      key + "\n",
    );
    const restoredDb = new DatabaseSync(join(output, "wallet.sqlite"), {
      readOnly: true,
    });
    assert.equal(
      restoredDb.prepare("SELECT network FROM watch_state WHERE id=1").get()
        ?.network,
      "zcash-mainnet",
    );
    restoredDb.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("encrypted backup writes exclusively and refuses overwrite", async () => {
  const root = mkdtempSync(join(tmpdir(), "zecone-watch-backup-")),
    source = profile(root),
    path = join(root, "watch.age"),
    identity = await generateX25519Identity(),
    recipient = await identityToRecipient(identity);
  try {
    const { archive } = packWatchProfile(source);
    writeEncryptedWatchBackup(
      path,
      await encryptWatchBackup(archive, recipient),
    );
    assert.ok(existsSync(path));
    assert.throws(
      () => writeEncryptedWatchBackup(path, new Uint8Array(32)),
      /WATCH_BACKUP_MUST_BE_NEW/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("archive tampering, unsafe files, testnet keys and path escapes fail closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "zecone-watch-backup-")),
    source = profile(root),
    identity = await generateX25519Identity(),
    recipient = await identityToRecipient(identity);
  try {
    const { archive } = packWatchProfile(source);
    assert.throws(
      () =>
        validateWatchBackupArchive({
          ...archive,
          files: archive.files.map((file) =>
            file.name === "viewing-key.txt"
              ? { ...file, sha256: "0".repeat(64) }
              : file,
          ),
        }),
      /WATCH_BACKUP_FILE_INTEGRITY_FAILED/,
    );
    assert.throws(
      () =>
        validateWatchBackupArchive({
          ...archive,
          files: [
            ...archive.files,
            { name: "process.lock", sha256: "0".repeat(64), data: "YQ==" },
          ],
        }),
      /INVALID_WATCH_BACKUP/,
    );
    const corruptedDatabase = Buffer.from(
      archive.files.find((file) => file.name === "wallet.sqlite")!.data,
      "base64",
    );
    corruptedDatabase.fill(0, 100);
    const corruptedArchive = {
      ...archive,
      files: archive.files.map((file) =>
        file.name === "wallet.sqlite"
          ? {
              ...file,
              data: corruptedDatabase.toString("base64"),
              sha256: createHash("sha256")
                .update(corruptedDatabase)
                .digest("hex"),
            }
          : file,
      ),
    };
    assert.throws(
      () => restoreWatchProfile(corruptedArchive, join(root, "corrupted")),
      /INVALID_WATCH_DATABASE/,
    );
    assert.throws(
      () =>
        validateWatchBackupArchive({
          ...archive,
          address: "utest1" + "q".repeat(60),
        }),
      /INVALID_WATCH_BACKUP/,
    );
    assert.throws(
      () => assertExternalPath(resolve(".secrets", "watch.age")),
      /HISTORICAL_WALLET_PATH_FORBIDDEN/,
    );
    assert.throws(
      () => assertExternalPath(resolve(".state", "watch.age")),
      /HISTORICAL_WALLET_PATH_FORBIDDEN/,
    );
    assert.throws(
      () => assertExternalPath(resolve("tests", "watch.age")),
      /WATCH_PATH_INSIDE_REPOSITORY/,
    );
    assert.throws(
      () =>
        restoreWatchProfile(
          archive,
          resolve("tests", "restored-watch-profile"),
        ),
      /WATCH_PATH_INSIDE_REPOSITORY/,
    );
    await assert.rejects(
      decryptWatchBackup(
        await encryptWatchBackup(archive, recipient),
        await generateX25519Identity(),
      ),
      /WATCH_BACKUP_DECRYPT_FAILED/,
    );
    writeFileSync(join(source, "process.lock"), "locked");
    assert.throws(
      () => packWatchProfile(source),
      /WATCH_PROFILE_MUST_BE_STOPPED/,
    );
    rmSync(join(source, "process.lock"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository guard does not depend on the process cwd", () => {
  const original = process.cwd(),
    root = mkdtempSync(join(tmpdir(), "zecone-watch-backup-cwd-"));
  try {
    process.chdir(root);
    assert.throws(
      () => assertExternalPath(resolve(original, "services")),
      { message: "WATCH_PATH_INSIDE_REPOSITORY" },
    );
  } finally {
    process.chdir(original);
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore refuses to replace an existing profile", () => {
  const root = mkdtempSync(join(tmpdir(), "zecone-watch-backup-")),
    source = profile(root);
  try {
    const { archive } = packWatchProfile(source);
    assert.throws(
      () => restoreWatchProfile(archive, source),
      /WATCH_RESTORE_DIRECTORY_MUST_BE_NEW/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
