// Creates a local encrypted watch-only backup and records that off-host readiness is still blocked.
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { writeJsonAtomic } from "../services/operations/mainnet-watch-worker.ts";

const exec = promisify(execFile);
function value(name: string) {
  const index = process.argv.indexOf(`--${name}`),
    found = index >= 0 ? process.argv[index + 1] : undefined;
  if (!found || found.startsWith("--"))
    throw Error(`${name.toUpperCase().replaceAll("-", "_")}_REQUIRED`);
  return resolve(found);
}

async function main() {
  if (process.env.ZECONE_READ_ONLY !== "1")
    throw Error("READ_ONLY_MODE_REQUIRED");
  const state = value("state"),
    profile = value("profile"),
    recipientFile = value("recipient-file"),
    outbox = value("outbox");
  mkdirSync(outbox, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
  const output = join(outbox, `watch-${stamp}.age`),
    status = join(state, "backup", "status.json");
  try {
    await exec(
      process.execPath,
      [
        "--experimental-transform-types",
        resolve("scripts/mainnet-watch-backup.ts"),
        "backup",
        "--profile",
        profile,
        "--recipient-file",
        recipientFile,
        "--out",
        output,
        "--confirm",
        "CREATE_WATCH_BACKUP",
      ],
      { windowsHide: true, timeout: 10 * 60_000, maxBuffer: 1024 * 1024 },
    );
    writeJsonAtomic(status, {
      schemaVersion: 1,
      state: "LOCAL_ENCRYPTED_BACKUP_ONLY",
      completedAt: Math.floor(Date.now() / 1000),
      artifact: basename(output),
      offHostVerified: false,
      restoreDrillVerified: false,
      productionReady: false,
      blocker: "OFF_HOST_COPY_AND_RESTORE_DRILL_REQUIRED",
    });
    process.stdout.write(
      JSON.stringify({
        backupCreated: true,
        productionReady: false,
        blocker: "OFF_HOST_COPY_AND_RESTORE_DRILL_REQUIRED",
      }) + "\n",
    );
  } catch {
    writeJsonAtomic(status, {
      schemaVersion: 1,
      state: "FAILED",
      failedAt: Math.floor(Date.now() / 1000),
      offHostVerified: false,
      restoreDrillVerified: false,
      productionReady: false,
      blocker: "BACKUP_JOB_FAILED",
    });
    throw Error("BACKUP_JOB_FAILED");
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    JSON.stringify({
      error:
        error instanceof Error && /^[A-Z0-9_]{1,96}$/.test(error.message)
          ? error.message
          : "BACKUP_JOB_FAILED",
    }) + "\n",
  );
  process.exitCode = 1;
});
