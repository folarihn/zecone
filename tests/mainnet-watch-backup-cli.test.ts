import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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

const key = "uview1" + "q".repeat(80);
const account = createHash("sha256").update(key).digest("hex");
const address = "u1" + "r".repeat(80);
const script = resolve("scripts/mainnet-watch-backup.ts");
function run(args: string[]) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", script, ...args],
    { cwd: resolve("."), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

test("watch backup CLI creates, verifies and restores an encrypted profile", () => {
  const root = mkdtempSync(join(tmpdir(), "zecone-watch-backup-cli-")),
    profile = join(root, "profile"),
    identity = join(root, "backup.agekey"),
    recipientFile = join(root, "backup.agepub"),
    archive = join(root, "watch.age"),
    restored = join(root, "restored");
  try {
    mkdirSync(profile);
    writeFileSync(
      join(profile, "watch-only.json"),
      JSON.stringify({
        version: 1,
        network: "zcash-mainnet",
        keyId: account,
        birthday: 3_000_000,
        address,
      }),
    );
    writeFileSync(join(profile, "viewing-key.txt"), key + "\n");
    const database = new DatabaseSync(join(profile, "wallet.sqlite"));
    database.exec(
      "CREATE TABLE watch_state(id INTEGER PRIMARY KEY, network TEXT NOT NULL); INSERT INTO watch_state VALUES(1, 'zcash-mainnet');",
    );
    database.close();

    const identityOutput = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        script,
        "identity",
        "--out",
        identity,
        "--confirm",
        "CREATE_AGE_IDENTITY",
      ],
      { cwd: resolve("."), encoding: "utf8" },
    );
    assert.equal(identityOutput.status, 0, identityOutput.stderr);
    assert.ok(!identityOutput.stdout.includes("AGE-SECRET"));
    const { recipient } = JSON.parse(identityOutput.stdout) as {
      recipient: string;
    };
    assert.match(recipient, /^age1[0-9a-z]{20,200}$/);
    writeFileSync(recipientFile, recipient + "\n");

    const verified = run(["verify", "--profile", profile]);
    assert.equal(verified.valid, true);
    assert.equal(
      (verified.metadata as Record<string, unknown>).account,
      account,
    );

    const backup = run([
      "backup",
      "--profile",
      profile,
      "--recipient-file",
      recipientFile,
      "--out",
      archive,
      "--confirm",
      "CREATE_WATCH_BACKUP",
    ]);
    assert.equal(backup.backupWritten, true);
    assert.ok(!JSON.stringify(backup).includes(key));

    const restore = run([
      "restore",
      "--backup",
      archive,
      "--identity-file",
      identity,
      "--out",
      restored,
      "--confirm",
      "RESTORE_WATCH_PROFILE",
    ]);
    assert.equal(restore.restored, true);
    assert.equal(readFileSync(join(restored, "viewing-key.txt"), "utf8"), key + "\n");
    const restoredDatabase = new DatabaseSync(join(restored, "wallet.sqlite"), {
      readOnly: true,
    });
    assert.equal(
      restoredDatabase
        .prepare("SELECT network FROM watch_state WHERE id=1")
        .get()?.network,
      "zcash-mainnet",
    );
    restoredDatabase.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
